/**
 * The core both of the companion's guards share: Pi's extension
 * (`pi-guard.ts`) and Claude Code's hook (`claude-guard.ts`). It decides
 * whether one path argument of a file-reading tool stays inside the
 * read-only copy:
 *
 * - a path that names a URL is refused;
 * - `~` and relative paths are resolved against the home folder and the
 *   copy, and credential paths (SSH keys, cloud credentials, the GitHub
 *   login, agents' own logins) are refused before the file system is
 *   touched there;
 * - the path must sit inside the copy as written, then its real path,
 *   symbolic links followed, inside the copy's real path.
 *
 * The guards run in the agent's process or as the agent's hook, so this
 * file imports nothing but Node's own modules.
 */
import { realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

/** The environment variable that names the read-only copy. */
export const READ_ROOT_VARIABLE = 'SECOND_LOOK_READ_ROOT';

/** A credential path under the home folder: a single file, or a folder and everything in it. */
export interface CredentialPath {
  path: string;
  folder: boolean;
}

/** Credential paths under the home folder, refused whatever the read root is. */
export const CREDENTIAL_PATHS: readonly CredentialPath[] = [
  { path: '.ssh', folder: true },
  { path: '.gnupg', folder: true },
  { path: '.aws', folder: true },
  { path: '.azure', folder: true },
  { path: '.config/gcloud', folder: true },
  { path: '.kube', folder: true },
  { path: '.docker/config.json', folder: false },
  { path: '.config/gh', folder: true },
  { path: '.git-credentials', folder: false },
  { path: '.config/git/credentials', folder: false },
  { path: '.netrc', folder: false },
  { path: '.npmrc', folder: false },
  { path: '.pi/agent/auth.json', folder: false },
  { path: '.claude/.credentials.json', folder: false },
  { path: '.codex/auth.json', folder: false },
];

/** What a guard decided about one tool call: the checked real path, or why it is refused. */
export type GuardVerdict = { allowed: true; path: string } | { allowed: false; reason: string };

/** A path argument that names a URL rather than a file. */
export const URL_LIKE = /^[a-z][a-z0-9+.-]*:\/\//i;

/** Space characters other than the plain space, which some agents' tools read as one. */
export const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;

/** True when `path` is `folder` itself or anything under it. */
export function isInside(path: string, folder: string): boolean {
  const rest = relative(folder, path);
  return rest === '' || (!rest.startsWith(`..${sep}`) && rest !== '..' && !isAbsolute(rest));
}

/** Resolves `~`, `~/…` and relative paths the way an agent's tools do: against the home folder and the copy. */
export function resolveReadPath(raw: string, root: string, home: string): string {
  if (raw === '~') return home;
  if (raw.startsWith('~/')) return join(home, raw.slice(2));
  return resolve(root, raw);
}

/** True when `path` is one of the credential paths under `home`, or inside one. */
export function isCredentialPath(path: string, home: string): boolean {
  return CREDENTIAL_PATHS.some((credential) => isInside(path, join(home, credential.path)));
}

/**
 * Confines one path argument to the read-only copy at `root`: refuses a
 * URL, resolves the path (`toolPath` first applies an agent's own
 * spelling rules, such as Pi's `@` prefix), refuses credential paths
 * before touching the file system, requires the path inside the copy as
 * written, then its real path inside the copy's real path. A path that
 * does not exist is refused: outside paths are refused before the file
 * system is read, so this tells nothing about files outside the copy.
 */
export function confinePath(
  raw: string,
  root: string,
  home: string,
  toolPath: (raw: string) => string = (path) => path,
): GuardVerdict {
  if (URL_LIKE.test(raw.trim())) {
    return { allowed: false, reason: 'URLs are refused: there is no network access, only files of the read-only copy' };
  }
  const path = resolveReadPath(toolPath(raw), root, home);
  if (isCredentialPath(path, home)) return { allowed: false, reason: 'credential paths may not be read' };
  let realRoot: string;
  try {
    realRoot = realpathSync(root);
  } catch {
    return { allowed: false, reason: 'the read-only copy is missing' };
  }
  if (!isInside(path, root) && !isInside(path, realRoot)) {
    return { allowed: false, reason: 'only files of the read-only copy may be read' };
  }
  let real: string;
  try {
    real = realpathSync(path);
  } catch {
    return { allowed: false, reason: 'no such file in the read-only copy' };
  }
  if (!isInside(real, realRoot)) {
    return { allowed: false, reason: 'the path leads outside the read-only copy' };
  }
  return { allowed: true, path: real };
}
