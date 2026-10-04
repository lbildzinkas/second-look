import { describe, expect, it } from 'vitest';
import {
  CHANGE_SCHEME,
  ChangeCopiesProvider,
  changeFileOf,
  changeUri,
  emptyChangeUri,
  libraryUri,
  partFiles,
} from '../src/change-copies.js';
import { FileSystemError, stub, Uri, workspace } from './vscode-stub.js';
import { fetchedResult, mixedResult, part, result } from './results.js';

const COPIES = mixedResult().copies;

function rootsOf(copies = COPIES): Map<string, string> {
  return new Map([
    [`base/${copies.base.commit}`, copies.base.path],
    [`head/${copies.head.commit}`, copies.head.path],
  ]);
}

describe('changeUri', () => {
  it('names the side, the commit and the file path, and maps back to the cached file', () => {
    const uri = changeUri('head', COPIES.head.commit, 'src/retry.py');

    expect(uri.scheme).toBe(CHANGE_SCHEME);
    expect(uri.authority).toBe('head');
    expect(uri.path).toBe(`/${COPIES.head.commit}/src/retry.py`);
    expect(changeFileOf(rootsOf(), uri)).toEqual({
      kind: 'file',
      path: `${COPIES.head.path}/src/retry.py`,
    });
  });

  it('serves the base side under the same rules', () => {
    const uri = changeUri('base', COPIES.base.commit, 'src/settings.ts');

    expect(changeFileOf(rootsOf(), uri)).toEqual({
      kind: 'file',
      path: `${COPIES.base.path}/src/settings.ts`,
    });
  });

  it('keeps paths with spaces and percent signs whole', () => {
    const uri = changeUri('head', COPIES.head.commit, 'docs/what is 100% new.md');

    expect(uri.path).toBe(`/${COPIES.head.commit}/docs/what is 100% new.md`);
    expect(changeFileOf(rootsOf(), uri)).toEqual({
      kind: 'file',
      path: `${COPIES.head.path}/docs/what is 100% new.md`,
    });
  });

  it('resolves nothing for a copy this companion never saw, or a path that leaves it', () => {
    const roots = rootsOf();

    expect(changeFileOf(roots, changeUri('head', 'f'.repeat(40), 'src/retry.py'))).toBeUndefined();
    expect(
      changeFileOf(roots, changeUri('head', COPIES.head.commit, '../../outside.ts')),
    ).toBeUndefined();
    expect(changeFileOf(roots, Uri.parse('https://github.com/example-org/example-repo'))).toBeUndefined();
  });

  it('resolves the empty stand-in to no file at all', () => {
    const uri = emptyChangeUri('src/new-file.ts');

    expect(uri.authority).toBe('empty');
    expect(changeFileOf(rootsOf(), uri)).toEqual({ kind: 'empty' });
  });
});

describe('partFiles', () => {
  it('lists exactly the part one file, base on the left and head on the right', () => {
    const files = partFiles(COPIES, part('src/retry.py'));

    expect(files).toHaveLength(1);
    expect(files[0]!.original).toEqual(
      changeUri('base', COPIES.base.commit, 'src/retry.py'),
    );
    expect(files[0]!.modified).toEqual(changeUri('head', COPIES.head.commit, 'src/retry.py'));
  });

  it('gives an addition an empty base side and a deletion an empty head side', () => {
    const addition = partFiles(COPIES, part('src/new.ts', { changeKind: 'addition' }))[0]!;
    const deletion = partFiles(COPIES, part('src/gone.ts', { changeKind: 'deletion' }))[0]!;

    expect(addition.original).toEqual(emptyChangeUri('src/new.ts'));
    expect(addition.modified).toEqual(changeUri('head', COPIES.head.commit, 'src/new.ts'));
    expect(deletion.original).toEqual(changeUri('base', COPIES.base.commit, 'src/gone.ts'));
    expect(deletion.modified).toEqual(emptyChangeUri('src/gone.ts'));
  });

  it('reads a rename from the previous path on the base side', () => {
    const renamed = partFiles(
      COPIES,
      part('src/transport.py', { changeKind: 'rename', previousPath: 'transport.py' }),
    )[0]!;

    expect(renamed.original).toEqual(changeUri('base', COPIES.base.commit, 'transport.py'));
    expect(renamed.modified).toEqual(changeUri('head', COPIES.head.commit, 'src/transport.py'));
  });

  it('opens a binary file like any other: both sides from the cache', () => {
    const binary = partFiles(COPIES, part('logo.png', { isBinary: true }))[0]!;

    expect(binary.original).toEqual(changeUri('base', COPIES.base.commit, 'logo.png'));
    expect(binary.modified).toEqual(changeUri('head', COPIES.head.commit, 'logo.png'));
  });
});

describe('ChangeCopiesProvider', () => {
  it('serves the cached base and head content', async () => {
    const provider = new ChangeCopiesProvider();
    provider.setCopies(COPIES);
    const headContent = new TextEncoder().encode('def send():\n    retry\n');
    const baseContent = new TextEncoder().encode('def send():\n    pass\n');
    stub.files.set(`${COPIES.head.path}/src/retry.py`, headContent);
    stub.files.set(`${COPIES.base.path}/src/retry.py`, baseContent);

    await expect(
      provider.readFile(changeUri('head', COPIES.head.commit, 'src/retry.py')),
    ).resolves.toEqual(headContent);
    await expect(
      provider.readFile(changeUri('base', COPIES.base.commit, 'src/retry.py')),
    ).resolves.toEqual(baseContent);
  });

  it('serves the empty stand-in as an empty read-only file', async () => {
    const provider = new ChangeCopiesProvider();
    provider.setCopies(COPIES);

    await expect(provider.readFile(emptyChangeUri('src/new.ts'))).resolves.toEqual(
      new Uint8Array(0),
    );
    await expect(provider.stat(emptyChangeUri('src/new.ts'))).resolves.toEqual({
      type: 1,
      ctime: 0,
      mtime: 0,
      size: 0,
      permissions: 1,
    });
  });

  it('reports the copies read-only in every stat', async () => {
    const provider = new ChangeCopiesProvider();
    provider.setCopies(COPIES);
    stub.files.set(`${COPIES.head.path}/src/retry.py`, new TextEncoder().encode('x'));

    await expect(
      provider.stat(changeUri('head', COPIES.head.commit, 'src/retry.py')),
    ).resolves.toMatchObject({ permissions: 1 });
  });

  it('rejects every write, create, delete and rename', async () => {
    const provider = new ChangeCopiesProvider();
    provider.setCopies(COPIES);
    const uri = changeUri('head', COPIES.head.commit, 'src/retry.py');

    expect(() => provider.writeFile(uri, new Uint8Array(), { create: true, overwrite: false })).toThrow(
      FileSystemError,
    );
    expect(() => provider.writeFile(uri, new Uint8Array(), { create: true, overwrite: false })).toThrow(
      'the base and head copies and the fetched libraries are read-only; nothing from the pull request is written',
    );
    expect(() => provider.createDirectory(uri)).toThrow(FileSystemError);
    expect(() => provider.delete(uri, { recursive: false })).toThrow(FileSystemError);
    expect(() => provider.rename(uri, uri, { overwrite: false })).toThrow(FileSystemError);
  });

  it('says a file is not found when no copy backs the URI', async () => {
    const provider = new ChangeCopiesProvider();
    provider.setCopies(COPIES);

    await expect(
      provider.readFile(changeUri('head', 'a'.repeat(40), 'src/retry.py')),
    ).rejects.toThrow(FileSystemError);
  });

  it('serves what the review recorded, also through workspace.fs', async () => {
    const provider = new ChangeCopiesProvider();
    workspace.registerFileSystemProvider(CHANGE_SCHEME, provider);
    provider.setCopies(result([], { base: '/copies/base', head: '/copies/head' }).copies);
    const content = new TextEncoder().encode('content from the engine cache\n');
    stub.files.set('/copies/head/src/legacy.ts', content);

    await expect(
      workspace.fs.readFile(changeUri('head', COPIES.head.commit, 'src/legacy.ts')),
    ).resolves.toEqual(content);
  });
});

describe('libraryUri', () => {
  const LIBRARY = '/cache/github.com/example-org/example-repo/pull-42/libraries/requests-2.32.3-0123456789ab';

  it("serves a cited file from the same read-only library cache the agent read, once a result names the library", async () => {
    const fetched = fetchedResult(LIBRARY);
    const verdict = fetched.claims!.claims[2]!.verdict as { library: Parameters<typeof libraryUri>[0] };
    const uri = libraryUri(verdict.library, 'requests/models.py');
    const provider = new ChangeCopiesProvider();

    expect(uri.toString()).toBe(`${CHANGE_SCHEME}://library/requests-2.32.3-0123456789ab/requests/models.py`);
    await expect(provider.stat(uri)).rejects.toBeInstanceOf(FileSystemError);
    provider.setLibraries(fetched);
    const content = new TextEncoder().encode('if 400 <= self.status_code < 500:\n');
    stub.files.set(`${LIBRARY}/requests/models.py`, content);
    await expect(provider.readFile(uri)).resolves.toEqual(content);
    await expect(provider.stat(uri)).resolves.toMatchObject({ permissions: 1 });
    expect(changeFileOf(new Map([['library/requests-2.32.3-0123456789ab', LIBRARY]]), libraryUri(verdict.library, '../../../outside.py'))).toBeUndefined();
    expect(() => provider.writeFile(uri, new Uint8Array(), { create: true, overwrite: true })).toThrow(
      'the base and head copies and the fetched libraries are read-only; nothing from the pull request is written',
    );
  });
});
