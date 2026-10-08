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
 * Without `SECOND_LOOK_READ_ROOT` every call is blocked. The checks it
 * shares with Claude Code's hook live in `read-guard.ts`. The file runs in
 * Pi's process, so it imports nothing but Node's own modules and that
 * sibling, and the package bundles the two into one file.
 */
import { homedir } from 'node:os';
import { confinePath, READ_ROOT_VARIABLE, UNICODE_SPACES, type GuardVerdict } from './read-guard.js';

/** The tools the agent may use: reading files of the copy, nothing else. */
export const READ_TOOLS = ['read', 'grep', 'find', 'ls'] as const;

/** Pi's own spelling of a path argument: odd spaces read as spaces, and an `@` prefix dropped. */
function piToolPath(raw: string): string {
  const path = raw.replace(UNICODE_SPACES, ' ');
  return path.startsWith('@') ? path.slice(1) : path;
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
  const given = input['path'];
  if (given === undefined) {
    if (toolName === 'read') {
      return { allowed: false, reason: 'the read tool must name a file to read' };
    }
  } else if (typeof given !== 'string') {
    return { allowed: false, reason: 'the path is not a string' };
  }
  return confinePath(typeof given === 'string' ? given : '.', root, home, piToolPath);
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
