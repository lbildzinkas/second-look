/**
 * What the companion's guard for Claude Code decides about one tool call.
 * Claude Code runs the guard as a `PreToolUse` hook (`claude-guard.ts`)
 * before every tool call, whatever the tool, and the guard:
 *
 * - lets `StructuredOutput` through: it is how Claude Code returns the
 *   `--json-schema` answer, and it touches no file;
 * - denies every tool except the file-reading ones (Read, Grep, Glob), in
 *   case a tool slips past the `--tools` allowlist;
 * - confines Read's `file_path` and Grep's and Glob's `path` to the
 *   read-only copy named by `SECOND_LOOK_READ_ROOT`, with the checks it
 *   shares with Pi's guard (`read-guard.ts`): `~` and relative paths
 *   resolved, credential paths and URLs refused, symbolic links followed;
 * - refuses a Glob `pattern` or Grep `glob` that names an absolute path or
 *   climbs out with `..`, since Claude Code reads an absolute pattern
 *   wherever it points.
 *
 * The guard never answers `allow` and never rewrites a call: a call it
 * passes still meets Claude Code's own permission checks. It writes one
 * audit line per call to the file `SECOND_LOOK_GUARD_AUDIT` names, so the
 * adapter can tell a call the guard saw from one it never saw. Any error
 * blocks the call (exit code 2) rather than letting it through.
 *
 * Without `SECOND_LOOK_READ_ROOT` every file-reading call is denied. The
 * hook runs as its own process, so this file imports nothing but Node's
 * own modules and its siblings, and the package bundles them into one file.
 */
import { appendFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute } from 'node:path';
import { confinePath, READ_ROOT_VARIABLE } from './read-guard.js';

/** The tools the agent may use: reading files of the copy, nothing else. */
export const CLAUDE_READ_TOOLS = ['Read', 'Grep', 'Glob'] as const;

/** The tool Claude Code answers through when it is given `--json-schema`. */
export const STRUCTURED_OUTPUT_TOOL = 'StructuredOutput';

/** The environment variable that names the guard's audit file. */
export const GUARD_AUDIT_VARIABLE = 'SECOND_LOOK_GUARD_AUDIT';

/** What every refusal the guard gives starts with. */
export const REFUSAL_PREFIX = 'Refused by Second Look: ';

/** One line of the guard's audit file: which call it saw, and what it decided. */
export interface GuardAuditLine {
  id: string;
  tool: string;
  decision: 'pass' | 'deny';
}

/** The guard's answer to one hook event, as the hook process returns it. */
export interface HookAnswer {
  /** 0 to pass or deny through `stdout`; 2 blocks the call with `stderr` as the reason. */
  exitCode: 0 | 2;
  stdout: string;
  stderr: string;
}

/** A `..` segment: between separators, or inside braces and extended-glob groups. */
const CLIMBS_OUT = /(^|[\\/{,(|])\.\.($|[\\/},)|])/;

/** An absolute path, a home path or a drive at the start of a pattern or of one of its alternatives. */
const NAMES_ABSOLUTE = /(^|[{,(|])\s*([\\/~]|[A-Za-z]:)/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Confines one path argument as written; Claude Code reads an existing path exactly as given. */
function checkPath(raw: unknown, root: string, home: string): string | undefined {
  if (typeof raw !== 'string') return 'the path is not a string';
  const verdict = confinePath(raw, root, home);
  return verdict.allowed ? undefined : verdict.reason;
}

/** Refuses a glob pattern that names an absolute path or climbs out of the folder it searches. */
function checkPattern(raw: unknown, name: string): string | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string') return `the ${name} is not a string`;
  if (isAbsolute(raw) || NAMES_ABSOLUTE.test(raw)) return `a ${name} may not name an absolute path`;
  if (CLIMBS_OUT.test(raw)) return `a ${name} may not climb out with ..`;
  return undefined;
}

/**
 * Checks one tool call. Returns why the call is refused, or undefined when
 * it may go on to Claude Code's own permission checks.
 */
export function checkClaudeToolCall(
  toolName: string,
  input: Record<string, unknown>,
  root: string | undefined,
  home: string = homedir(),
): string | undefined {
  if (toolName === STRUCTURED_OUTPUT_TOOL) return undefined;
  if (!(CLAUDE_READ_TOOLS as readonly string[]).includes(toolName)) {
    return `the ${toolName} tool is not allowed: only ${CLAUDE_READ_TOOLS.join(', ')} may run`;
  }
  if (!root) return `${READ_ROOT_VARIABLE} is not set, so no path may be read`;
  if (toolName === 'Read') {
    if (input['file_path'] === undefined) return 'the Read tool must name a file to read';
    return checkPath(input['file_path'], root, home);
  }
  const why = checkPath(input['path'] ?? '.', root, home);
  if (why) return why;
  return toolName === 'Glob' ? checkPattern(input['pattern'], 'pattern') : checkPattern(input['glob'], 'glob');
}

/** Blocks the call through the hook's exit code, the answer for anything that went wrong. */
function blocked(why: string): HookAnswer {
  return { exitCode: 2, stdout: '', stderr: `${REFUSAL_PREFIX}${why}` };
}

/**
 * Answers one `PreToolUse` hook event, given as the JSON text Claude Code
 * writes to the hook's stdin: no output to pass the call on to Claude
 * Code's own checks, a `deny` decision with the reason to refuse it, or
 * exit code 2 when the event cannot be read. Never `allow`, and never a
 * rewritten input.
 */
export function answerPreToolUse(eventText: string, env: NodeJS.ProcessEnv, home: string = homedir()): HookAnswer {
  try {
    const event: unknown = JSON.parse(eventText);
    if (!isRecord(event) || typeof event['tool_name'] !== 'string') return blocked('the hook event names no tool');
    const tool = event['tool_name'];
    const id = event['tool_use_id'];
    const input = isRecord(event['tool_input']) ? event['tool_input'] : {};
    let reason =
      typeof id === 'string' && id !== ''
        ? checkClaudeToolCall(tool, input, env[READ_ROOT_VARIABLE], home)
        : 'the hook event names no tool call to audit';
    const audit = env[GUARD_AUDIT_VARIABLE];
    if (audit) {
      const line: GuardAuditLine = { id: String(id), tool, decision: reason === undefined ? 'pass' : 'deny' };
      try {
        appendFileSync(audit, `${JSON.stringify(line)}\n`);
      } catch {
        reason = 'the guard could not write its audit line';
      }
    }
    if (reason === undefined) return { exitCode: 0, stdout: '', stderr: '' };
    const denial = {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: `${REFUSAL_PREFIX}${reason}`,
      },
    };
    return { exitCode: 0, stdout: JSON.stringify(denial), stderr: '' };
  } catch (error) {
    return blocked(`the guard failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}
