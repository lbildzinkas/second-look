/**
 * The companion's guard, loaded into Pi as an extension for every run.
 * Pi has no sandbox of its own: its tool-call hook, which can block a call
 * before the tool runs, is the strongest mechanism it offers. The guard:
 *
 * - blocks every tool except the file-reading ones (read, grep, find, ls),
 *   in case a Pi version ignores the tool allowlist;
 * - refuses any path that names a URL, and any credential path (SSH keys,
 *   cloud credentials, the GitHub login, agents' own logins) before
 *   touching the file system there;
 * - confines every other path to the read-only copy named by
 *   `SECOND_LOOK_READ_ROOT`, following symbolic links, and hands the tool
 *   the checked real path so it reads exactly what was checked.
 *
 * Without `SECOND_LOOK_READ_ROOT` every call is blocked. The file runs in
 * Pi's process, so it imports nothing but Node's own modules.
 */
import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

/** The tools the agent may use: reading files of the copy, nothing else. */
export const READ_TOOLS = ['read', 'grep', 'find', 'ls'] as const;

/** The environment variable that names the read-only copy. */
export const READ_ROOT_VARIABLE = 'SECOND_LOOK_READ_ROOT';

/** Credential paths under the home folder, refused whatever the read root is. */
const CREDENTIAL_PATHS = [
  '.ssh',
  '.gnupg',
  '.aws',
  '.azure',
  '.config/gcloud',
  '.kube',
  '.docker/config.json',
  '.config/gh',
  '.git-credentials',
  '.config/git/credentials',
  '.netrc',
  '.npmrc',
  '.pi/agent/auth.json',
  '.claude/.credentials.json',
  '.codex/auth.json',
];

/** What the guard decided about one tool call. */
export type GuardVerdict = { allowed: true; path: string } | { allowed: false; reason: string };

const URL_LIKE = /^[a-z][a-z0-9+.-]*:\/\//i;
const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;

function isInside(path: string, folder: string): boolean {
  const rest = relative(folder, path);
  return rest === '' || (!rest.startsWith(`..${sep}`) && rest !== '..' && !isAbsolute(rest));
}

/** Resolves a tool's path argument the way Pi does: `@` prefix, `~`, odd spaces, cwd. */
function resolveToolPath(raw: string, root: string, home: string): string {
  let path = raw.replace(UNICODE_SPACES, ' ');
  if (path.startsWith('@')) path = path.slice(1);
  if (path === '~') path = home;
  else if (path.startsWith('~/')) path = join(home, path.slice(2));
  return resolve(root, path);
}

/**
 * Checks one tool call. Returns the real path the tool must use, or why the
 * call is refused.
 */
export function checkToolCall(
  toolName: string,
  input: Record<string, unknown>,
  root: string | undefined,
  home: string = homedir(),
): GuardVerdict {
  if (!(READ_TOOLS as readonly string[]).includes(toolName)) {
    return { allowed: false, reason: `the ${toolName} tool is not allowed: only ${READ_TOOLS.join(', ')} may run` };
  }
  if (!root) return { allowed: false, reason: `${READ_ROOT_VARIABLE} is not set, so no path may be read` };
  const raw = input['path'] ?? '.';
  if (typeof raw !== 'string') return { allowed: false, reason: 'the path is not a string' };
  if (URL_LIKE.test(raw.trim())) {
    return { allowed: false, reason: 'URLs are refused: there is no network access, only files of the read-only copy' };
  }
  const path = resolveToolPath(raw, root, home);
  if (CREDENTIAL_PATHS.some((credential) => isInside(path, join(home, credential)))) {
    return { allowed: false, reason: 'credential paths may not be read' };
  }
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

/** The part of Pi's extension interface the guard uses. */
interface PiToolCallEvent {
  toolName: string;
  input: Record<string, unknown>;
}

interface PiExtensionApi {
  on(
    event: 'tool_call',
    handler: (event: PiToolCallEvent) => { block: true; reason: string } | undefined,
  ): void;
}

/** The extension's entry point, which Pi calls once when it loads the file. */
export default function secondLookGuard(pi: PiExtensionApi): void {
  pi.on('tool_call', (event) => {
    const verdict = checkToolCall(event.toolName, event.input, process.env[READ_ROOT_VARIABLE]);
    if (!verdict.allowed) return { block: true, reason: `Refused by Second Look: ${verdict.reason}` };
    event.input['path'] = verdict.path;
    return undefined;
  });
}
