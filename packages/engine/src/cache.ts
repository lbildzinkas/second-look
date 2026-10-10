import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, copyFile, mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { extractTarball } from './archive.js';
import type { PullRequestRef } from './github.js';
import type { ChangeCopy, ProjectCopy } from './protocol.js';

/**
 * The folder the engine keeps its cache in when the caller names none:
 * `SECOND_LOOK_CACHE_DIR` when set, otherwise the platform's usual
 * per-user cache folder.
 */
export function defaultCacheDir(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
): string {
  const configured = env['SECOND_LOOK_CACHE_DIR'];
  if (configured) return configured;
  if (platform === 'win32') {
    return join(env['LOCALAPPDATA'] ?? join(home, 'AppData', 'Local'), 'second-look', 'cache');
  }
  if (platform === 'darwin') return join(home, 'Library', 'Caches', 'second-look');
  return join(env['XDG_CACHE_HOME'] ?? join(home, '.cache'), 'second-look');
}

const NAME_SEGMENT = /^[A-Za-z0-9_.-]+$/;
const COMMIT = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

/**
 * The pull request's own cache folder:
 * `<cacheDir>/github.com/<owner>/<repo>/pull-<number>`. Throws when the
 * owner or repository is not a plain name, so no URL can steer the path.
 */
export function pullRequestCacheDir(cacheDir: string, ref: PullRequestRef): string {
  for (const segment of [ref.owner, ref.repo]) {
    if (!NAME_SEGMENT.test(segment) || segment === '.' || segment === '..') {
      throw new Error(`not a GitHub owner or repository name: ${segment}`);
    }
  }
  return join(cacheDir, 'github.com', ref.owner, ref.repo, `pull-${ref.number}`);
}

export interface CopyRequest {
  /** The engine's cache folder. */
  cacheDir: string;
  ref: PullRequestRef;
  /** Full commit hash of the version to copy. */
  commit: string;
  /** Downloads the commit's gzipped tarball; called only when no copy exists yet. */
  download: (commit: string) => Promise<AsyncIterable<Uint8Array>>;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Removes a copy, first making its read-only folders writable again so
 * the removal can unlink their files.
 */
export async function removeCopy(dir: string): Promise<void> {
  if (!(await exists(dir))) return;
  const makeWritable = async (folder: string): Promise<void> => {
    await chmod(folder, 0o755);
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      if (entry.isDirectory()) await makeWritable(join(folder, entry.name));
    }
  };
  await makeWritable(dir);
  await rm(dir, { recursive: true, force: true });
}

/**
 * Returns the read-only copy of one commit of the pull request, reusing
 * the copy an earlier run left at the same commit. A new copy is
 * extracted into a private folder and renamed into place only once
 * complete, so a copy that exists is always whole.
 */
export async function ensureCopy(request: CopyRequest): Promise<ChangeCopy> {
  const { cacheDir, ref, commit } = request;
  if (!COMMIT.test(commit)) {
    throw new Error(`not a full commit hash: ${commit}`);
  }
  const pullDir = pullRequestCacheDir(cacheDir, ref);
  const path = join(pullDir, commit);
  if (await exists(path)) return { commit, path, reused: true };

  await mkdir(pullDir, { recursive: true });
  const partial = join(pullDir, `.partial-${commit}-${randomBytes(6).toString('hex')}`);
  try {
    await extractTarball(await request.download(commit), partial);
    await rename(partial, path);
  } catch (error) {
    await removeCopy(partial);
    // Another run finished the same copy first; theirs is just as good.
    if (await exists(path)) return { commit, path, reused: true };
    throw error;
  }
  return { commit, path, reused: false };
}

/**
 * Modes of the project loaded for navigation: writable, so restoring the
 * project can write beside its files, but never executable.
 */
const PROJECT_FILE = 0o644;
const PROJECT_DIR = 0o755;

/**
 * The folder the project loaded for navigation sits in:
 * `<pull request folder>/project/<commit>`, beside the read-only copies
 * and never inside one, so no agent run's folder holds it.
 */
export function projectCopyDir(cacheDir: string, ref: PullRequestRef, commit: string): string {
  if (!COMMIT.test(commit)) {
    throw new Error(`not a full commit hash: ${commit}`);
  }
  return join(pullRequestCacheDir(cacheDir, ref), 'project', commit);
}

/** Copies a folder's regular files and folders, writable and never executable; a link or special file is never copied. */
async function copyTree(from: string, to: string): Promise<void> {
  await mkdir(to);
  await chmod(to, PROJECT_DIR);
  for (const entry of await readdir(from, { withFileTypes: true })) {
    const source = join(from, entry.name);
    const target = join(to, entry.name);
    if (entry.isDirectory()) {
      await copyTree(source, target);
    } else if (entry.isFile()) {
      await copyFile(source, target, constants.COPYFILE_EXCL);
      await chmod(target, PROJECT_FILE);
    }
  }
}

/**
 * Writes the project loaded for navigation, which the client asks for
 * only once the reviewer confirmed it: a writable copy of the head copy,
 * so language extensions can restore the project and offer go to
 * definition in it. The head copy itself stays read-only and stays the
 * folder agent runs read, so the agents' locked-down posture is
 * unchanged: this copy is written beside it, never inside it. Only
 * regular files and folders are copied, never a link. A copy is written
 * into a private folder and renamed into place once complete, and a load
 * an earlier request left at the same commit is reused as the reviewer
 * left it.
 */
export async function ensureProjectCopy(cacheDir: string, ref: PullRequestRef, head: ChangeCopy): Promise<ProjectCopy> {
  const path = projectCopyDir(cacheDir, ref, head.commit);
  if (await exists(path)) return { commit: head.commit, path, reused: true };

  const projects = join(pullRequestCacheDir(cacheDir, ref), 'project');
  await mkdir(projects, { recursive: true });
  const partial = join(projects, `.partial-${head.commit}-${randomBytes(6).toString('hex')}`);
  try {
    await copyTree(head.path, partial);
    await rename(partial, path);
  } catch (error) {
    await removeCopy(partial);
    // Another request finished the same copy first; theirs is just as good.
    if (await exists(path)) return { commit: head.commit, path, reused: true };
    throw error;
  }
  return { commit: head.commit, path, reused: false };
}
