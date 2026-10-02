import { randomBytes } from 'node:crypto';
import { chmod, mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { extractTarball } from './archive.js';
import type { PullRequestRef } from './github.js';
import type { ChangeCopy } from './protocol.js';

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
