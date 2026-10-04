import * as vscode from 'vscode';
import { filesOfPart, pathInCopy, type ChangeCopies, type FetchedLibrary, type Part, type ReviewResult } from '@second-look/engine';

/**
 * The URI scheme the companion serves the change's copies under: the
 * editor reads the base and head versions of every part from the engine's
 * cache through it, read-only, so nothing is ever checked out.
 */
export const CHANGE_SCHEME = 'second-look-change' as const;

/** Which side of the change one URI serves: the base copy or the head copy. */
export type ChangeSide = 'base' | 'head';

/** The authority that serves an empty stand-in file where a side has none. */
const EMPTY_SIDE = 'empty';

/** The authority that serves a fetched library's source from the pull request's library cache. */
const LIBRARY_SIDE = 'library';

/** The folder a fetched library landed in, by its name in the library cache. */
function libraryFolder(library: FetchedLibrary): string {
  return library.path.split(/[\\/]/).filter(Boolean).pop() ?? '';
}

/**
 * The URI of one file of a fetched library's source, by its path in that
 * source, as a verdict judged against it cites it. The editor reads it
 * from the same library cache the agent read, read-only.
 */
export function libraryUri(library: FetchedLibrary, path: string): vscode.Uri {
  return vscode.Uri.from({ scheme: CHANGE_SCHEME, authority: LIBRARY_SIDE, path: `/${libraryFolder(library)}/${path}` });
}

/**
 * The URI of one side of a file of the change: the side's copy, the commit
 * it was taken at, and the file's path in the repository. The commit rides
 * in the path, so a URI names its content even after a later review.
 */
export function changeUri(side: ChangeSide, commit: string, path: string): vscode.Uri {
  return vscode.Uri.from({ scheme: CHANGE_SCHEME, authority: side, path: `/${commit}/${path}` });
}

/**
 * The URI that serves an always-empty file, for the side a part does not
 * have: the base side of an addition, the head side of a deletion.
 */
export function emptyChangeUri(path: string): vscode.Uri {
  return vscode.Uri.from({ scheme: CHANGE_SCHEME, authority: EMPTY_SIDE, path: `/${path}` });
}

/** One file of a part as the diff editor compares it: base left, head right. */
export interface PartFile {
  original: vscode.Uri;
  modified: vscode.Uri;
}

/**
 * The files a part is made of, in the part's order, base on the left and
 * head on the right: one file for a plain part, several when the agent
 * grouped related hunks across files. The side a change kind does not
 * have gets the empty stand-in, so additions and deletions open like the
 * pull request shows them; renames read the base copy under the previous
 * path; binary files open like any other.
 */
export function partFiles(copies: ChangeCopies, part: Part): PartFile[] {
  return filesOfPart(part).map((file) => {
    const previousPath = file.previousPath ?? file.path;
    return {
      original:
        file.changeKind === 'addition'
          ? emptyChangeUri(previousPath)
          : changeUri('base', copies.base.commit, previousPath),
      modified:
        file.changeKind === 'deletion'
          ? emptyChangeUri(file.path)
          : changeUri('head', copies.head.commit, file.path),
    };
  });
}

/** What a change URI resolves to in the engine's cache. */
export type ChangeFile =
  /** The absolute path of the file the URI serves. */
  | { kind: 'file'; path: string }
  /** The always-empty stand-in for a side the change does not have. */
  | { kind: 'empty' };

/**
 * Maps a change URI back to the file it serves in the engine's cache.
 * `roots` holds each side's copy path, keyed by `side/commit`, and each
 * fetched library's, keyed by `library/<folder>`. Returns undefined when
 * the URI names no copy this companion knows, or its path would leave the
 * copy.
 */
export function changeFileOf(
  roots: ReadonlyMap<string, string>,
  uri: vscode.Uri,
): ChangeFile | undefined {
  if (uri.scheme !== CHANGE_SCHEME) return undefined;
  if (uri.authority === EMPTY_SIDE) return { kind: 'empty' };
  const side = uri.authority;
  if (side !== 'base' && side !== 'head' && side !== LIBRARY_SIDE) return undefined;
  const [commit, ...rest] = uri.path.replace(/^\//, '').split('/');
  const root = roots.get(`${side}/${commit ?? ''}`);
  if (root === undefined || rest.length === 0) return undefined;
  const path = pathInCopy(root, rest.join('/'));
  return path === undefined ? undefined : { kind: 'file', path };
}

/**
 * The read-only file system provider that serves the cached base and head
 * content, and the source of each library the reviewer fetched, to the
 * editor. Reads go through VS Code's own file system to the
 * copies the engine already downloaded — nothing is fetched again and
 * nothing is checked out — and every write, create, delete and rename is
 * refused, because the copies are the record the review reads against.
 * The copies never change under a commit, so nothing is ever watched.
 */
export class ChangeCopiesProvider implements vscode.FileSystemProvider {
  private readonly roots = new Map<string, string>();

  private readonly changes = new vscode.EventEmitter<vscode.FileChangeEvent[]>();

  readonly onDidChangeFile = this.changes.event;

  /** Records where the latest review's base and head copies sit. */
  setCopies(copies: ChangeCopies): void {
    this.roots.set(`base/${copies.base.commit}`, copies.base.path);
    this.roots.set(`head/${copies.head.commit}`, copies.head.path);
  }

  /** Records where every library the result's verdicts were judged against sits in the library cache. */
  setLibraries(result: ReviewResult): void {
    for (const claim of result.claims?.claims ?? []) {
      const library = claim.verdict.kind === 'not checked' ? undefined : claim.verdict.library;
      if (library !== undefined) this.roots.set(`${LIBRARY_SIDE}/${libraryFolder(library)}`, library.path);
    }
  }

  watch(): vscode.Disposable {
    return { dispose: () => undefined };
  }

  async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
    const file = this.target(uri);
    if (file === undefined) throw notFound(uri);
    return file.kind === 'empty' ? emptyStat() : readonlyStat(file.path);
  }

  async readFile(uri: vscode.Uri): Promise<Uint8Array> {
    const file = this.target(uri);
    if (file === undefined) throw notFound(uri);
    if (file.kind === 'empty') return new Uint8Array(0);
    return vscode.workspace.fs.readFile(vscode.Uri.file(file.path));
  }

  async readDirectory(uri: vscode.Uri): Promise<[string, vscode.FileType][]> {
    return vscode.workspace.fs.readDirectory(vscode.Uri.file(this.file(uri)));
  }

  writeFile(
    _uri: vscode.Uri,
    _content: Uint8Array,
    _options: { create: boolean; overwrite: boolean },
  ): never {
    throw readOnly();
  }

  createDirectory(_uri: vscode.Uri): never {
    throw readOnly();
  }

  delete(_uri: vscode.Uri, _options: { recursive: boolean }): never {
    throw readOnly();
  }

  rename(
    _oldUri: vscode.Uri,
    _newUri: vscode.Uri,
    _options: { overwrite: boolean },
  ): never {
    throw readOnly();
  }

  /** The cached file a directory URI lists; the empty side has none. */
  private file(uri: vscode.Uri): string {
    const file = this.target(uri);
    if (file === undefined || file.kind === 'empty') {
      throw notFound(uri);
    }
    return file.path;
  }

  private target(uri: vscode.Uri): ChangeFile | undefined {
    return changeFileOf(this.roots, uri);
  }
}

async function readonlyStat(path: string): Promise<vscode.FileStat> {
  const stat = await vscode.workspace.fs.stat(vscode.Uri.file(path));
  return { ...stat, permissions: vscode.FilePermission.Readonly };
}

function emptyStat(): vscode.FileStat {
  return {
    type: vscode.FileType.File,
    ctime: 0,
    mtime: 0,
    size: 0,
    permissions: vscode.FilePermission.Readonly,
  };
}

function readOnly(): vscode.FileSystemError {
  return vscode.FileSystemError.NoPermissions(
    'the base and head copies and the fetched libraries are read-only; nothing from the pull request is written',
  );
}

function notFound(uri: vscode.Uri): vscode.FileSystemError {
  return vscode.FileSystemError.FileNotFound(uri);
}
