import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { trackAgentChild } from './agent-children.js';
import {
  GITHUB_TOKEN_VARIABLES,
  type AgentAdapter,
  type AgentLogin,
  type AgentProbe,
  type AgentRunOutcome,
  type AgentRunRequest,
  type AgentStamp,
  type AgentTokens,
} from './agent.js';
import {
  CLAUDE_READ_TOOLS,
  GUARD_AUDIT_VARIABLE,
  type GuardAuditLine,
} from './claude-guard-check.js';
import { CREDENTIAL_PATHS, READ_ROOT_VARIABLE } from './read-guard.js';

/**
 * The Claude Code adapter (ADR 0004): the same contract as the Pi adapter,
 * built from what Claude Code offers plus the companion's own guard.
 *
 * - **the companion's guard**: a `PreToolUse` hook (`claude-guard.ts`),
 *   passed with `--settings` for every tool, checks each call before it
 *   runs: paths confined to the read-only copy, symbolic links followed,
 *   credential paths and climbing or absolute glob patterns refused, every
 *   other tool denied. The same settings pin `disableAllHooks` off, so the
 *   reviewer's own settings cannot switch the guard off, and add deny rules
 *   for every credential path.
 * - **the default permission mode**: `--permission-mode default`. Claude
 *   Code starts some models in its `auto` mode, which reads files outside
 *   the working directory without asking; in `default` mode such a read
 *   needs approval, which `--permission-prompts none` denies, so Claude
 *   Code's own working-directory check stands behind the guard.
 * - **print mode with a schema**: `--print` runs the agent once and exits,
 *   and `--json-schema` makes Claude Code validate the answer against the
 *   task's schema before returning it.
 * - **user-level settings only**: `--setting-sources user` loads the
 *   reviewer's own settings and nothing from the pull request — project
 *   and local settings, and the copy's own context, stay out.
 * - **no project MCP servers**: `--strict-mcp-config` ignores every MCP
 *   configuration except the one the run names, and the run names none.
 * - **file-reading tools only**: `--tools Read,Grep,Glob` leaves the agent
 *   without a shell, network tools or edits.
 * - `--permission-prompts none` denies anything that would ask, and
 *   `--no-session-persistence` writes no session file.
 *
 * A Claude Code whose help lacks any of these flags is never run, rather
 * than run with a weaker lockdown. A Claude Code hook that cannot start
 * lets the call through, so the run fails closed instead: the probe runs
 * the exact hook command on an outside read and requires a refusal, a run
 * whose permission mode is not `default` is failed, and so is a run with a
 * tool call the guard's audit file never saw and Claude Code did not deny
 * itself.
 *
 * Each run's stamp reports which login it used. The companion never reads
 * the login — it names the source: an inherited `ANTHROPIC_API_KEY` (with a
 * warning that it silently overrides the Claude subscription), an OAuth
 * token or cloud credentials from the environment, or the stored Claude
 * subscription sign-in.
 */

/** The guard hook built next to this file. */
export const CLAUDE_GUARD_PATH = fileURLToPath(new URL('./claude-guard.js', import.meta.url));

/** The permission mode every run is pinned to, so Claude Code's own working-directory check applies. */
export const CLAUDE_PERMISSION_MODE = 'default';

/** Seconds Claude Code gives the guard hook for one call. */
const GUARD_TIMEOUT_SECONDS = 30;

/**
 * The flags the lockdown needs. A Claude Code whose help lacks any of them
 * is never run, rather than run with a weaker lockdown.
 */
const LOCKDOWN_FLAGS = [
  '--print',
  '--output-format',
  '--include-partial-messages',
  '--no-session-persistence',
  '--setting-sources',
  '--strict-mcp-config',
  '--tools',
  '--permission-prompts',
  '--permission-mode',
  '--settings',
  '--system-prompt',
  '--json-schema',
] as const;

export interface ClaudeCodeAdapterOptions {
  /** The command that starts Claude Code, with any leading arguments; `['claude']` by default. */
  command?: readonly string[];
  /** The guard hook Claude Code runs; {@link CLAUDE_GUARD_PATH} by default. */
  guardPath?: string;
  /** The engine's environment, which the agent inherits minus the GitHub login. */
  env?: NodeJS.ProcessEnv;
  /** Milliseconds between asking a timed-out Claude Code to stop and killing it. */
  killGraceMs?: number;
}

/**
 * The shell command Claude Code runs as the guard hook: this engine's own
 * Node (the editor's binary inside VS Code, run as Node) on the guard
 * script. Claude Code hands the command to a shell, so a path holding a
 * quote, a backquote, a `$`, a line break, a backslash outside Windows or
 * a `%` on Windows is refused rather than let it change the command.
 */
export function guardHookCommand(
  nodePath: string,
  guardPath: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const unsafe = platform === 'win32' ? /["`$%\r\n]/ : /["`$\\\r\n]/;
  for (const path of [nodePath, guardPath]) {
    if (unsafe.test(path)) {
      throw new Error(`the path ${JSON.stringify(path)} holds a character that could change the guard's hook command`);
    }
  }
  return `"${nodePath}" "${guardPath}"`;
}

/**
 * Permission rules that deny reading every credential path, generated from
 * the guard's own list: the path itself, and everything under a folder.
 * Claude Code applies a `Read` rule to Grep and Glob as well.
 */
export function credentialDenyRules(): string[] {
  return CREDENTIAL_PATHS.flatMap(({ path, folder }) =>
    folder ? [`Read(~/${path})`, `Read(~/${path}/**)`] : [`Read(~/${path})`],
  );
}

/**
 * The settings every run passes with `--settings`, which outrank the
 * reviewer's user settings: hooks pinned on, the guard hook for every tool,
 * and the credential deny rules.
 */
export function claudeSettings(hookCommand: string): string {
  return JSON.stringify({
    disableAllHooks: false,
    hooks: {
      PreToolUse: [
        { matcher: '*', hooks: [{ type: 'command', command: hookCommand, timeout: GUARD_TIMEOUT_SECONDS }] },
      ],
    },
    permissions: { deny: credentialDenyRules() },
  });
}

/**
 * The exact arguments of a locked-down Claude Code run: print mode, streamed
 * JSON with partial messages so a timeout keeps what was written, no session
 * file, user-level settings only, every MCP configuration ignored,
 * file-reading tools only, permission prompts denied rather than asked, the
 * default permission mode, the companion's settings with the guard hook,
 * and the companion's own system prompt with the answer's schema. The
 * prompt itself goes on stdin, so no argument can be read as a file to
 * attach.
 */
export function claudeArguments(
  request: Pick<AgentRunRequest, 'instructions' | 'schema' | 'model' | 'effort'>,
  supportsEffort: boolean,
  hookCommand: string,
): string[] {
  return [
    '--print',
    '--output-format',
    'stream-json',
    '--include-partial-messages',
    '--no-session-persistence',
    '--setting-sources',
    'user',
    '--strict-mcp-config',
    '--tools',
    CLAUDE_READ_TOOLS.join(','),
    '--permission-prompts',
    'none',
    '--permission-mode',
    CLAUDE_PERMISSION_MODE,
    '--settings',
    claudeSettings(hookCommand),
    '--system-prompt',
    request.instructions,
    ...(request.schema ? ['--json-schema', JSON.stringify(request.schema)] : []),
    ...(request.model ? ['--model', request.model] : []),
    ...(request.effort && supportsEffort ? ['--effort', request.effort] : []),
  ];
}

/** The agent's environment: the engine's, minus the GitHub login. */
export function claudeEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const clean: NodeJS.ProcessEnv = { ...env };
  for (const name of GITHUB_TOKEN_VARIABLES) delete clean[name];
  return { ...clean, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' };
}

/**
 * The environment of one run, which Claude Code hands on to the guard hook:
 * the agent's, plus the read-only copy, the audit file, and
 * `ELECTRON_RUN_AS_NODE`, because inside VS Code the hook's Node is the
 * editor's own binary, which runs plain Node code only when told to.
 */
export function claudeRunEnvironment(env: NodeJS.ProcessEnv, root: string, audit: string): NodeJS.ProcessEnv {
  return {
    ...claudeEnvironment(env),
    [READ_ROOT_VARIABLE]: root,
    [GUARD_AUDIT_VARIABLE]: audit,
    ELECTRON_RUN_AS_NODE: '1',
  };
}

/** The environment variable whose inherited value silently overrides the subscription. */
export const API_KEY_VARIABLE = 'ANTHROPIC_API_KEY';

/**
 * Names which login Claude Code signs in with, without reading it: an
 * inherited `ANTHROPIC_API_KEY` (warned about, because it silently overrides
 * the subscription the reviewer chose), an OAuth token or cloud credentials
 * from the environment, else the stored subscription sign-in.
 */
export function claudeLogin(env: NodeJS.ProcessEnv): AgentLogin {
  if (env[API_KEY_VARIABLE] !== undefined && env[API_KEY_VARIABLE] !== '') {
    return {
      source: `the inherited ${API_KEY_VARIABLE} environment variable (an API key)`,
      warning:
        `an inherited ${API_KEY_VARIABLE} overrides the Claude subscription sign-in, ` +
        'so this run bills the API key instead of the subscription',
    };
  }
  if (env['CLAUDE_CODE_OAUTH_TOKEN'] !== undefined && env['CLAUDE_CODE_OAUTH_TOKEN'] !== '') {
    return { source: 'the CLAUDE_CODE_OAUTH_TOKEN environment variable' };
  }
  if (env['CLAUDE_CODE_USE_BEDROCK'] === '1' || env['CLAUDE_CODE_USE_BEDROCK'] === 'true') {
    return { source: 'Amazon Bedrock credentials from the environment' };
  }
  if (env['CLAUDE_CODE_USE_VERTEX'] === '1' || env['CLAUDE_CODE_USE_VERTEX'] === 'true') {
    return { source: 'Google Vertex AI credentials from the environment' };
  }
  return { source: 'the stored Claude subscription sign-in' };
}

interface Captured {
  code: number | null;
  stdout: string;
  error?: string;
}

/** Runs a short Claude Code command, such as `--version`, outside any project folder. */
function capture(command: readonly string[], args: string[], env: NodeJS.ProcessEnv): Promise<Captured> {
  return new Promise((done) => {
    const child = trackAgentChild(
      spawn(command[0]!, [...command.slice(1), ...args], {
        cwd: tmpdir(),
        env,
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 30_000,
      }),
    );
    let stdout = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
    child.on('error', (error) => done({ code: null, stdout, error: error.message }));
    child.on('close', (code) => done({ code, stdout }));
  });
}

interface ClaudeUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
}

interface ClaudeContentBlock {
  type?: string;
  id?: string;
}

interface ClaudeEvent {
  type?: string;
  subtype?: string;
  model?: string;
  permissionMode?: string;
  result?: string;
  is_error?: boolean;
  usage?: ClaudeUsage;
  total_cost_usd?: number;
  permission_denials?: { tool_use_id?: string }[];
  event?: {
    type?: string;
    delta?: { type?: string; text?: string; partial_json?: string };
    content_block?: ClaudeContentBlock;
  };
  message?: { model?: string; content?: ClaudeContentBlock[] };
}

/** The tool-use id of the preflight's synthetic call. */
const PREFLIGHT_TOOL_USE_ID = 'second-look-guard-preflight';

/** What the guard hook answered one event. */
interface HookRun {
  code: number | null;
  stdout: string;
  stderr: string;
  error?: string;
}

/** Runs the guard hook command through a shell, as Claude Code does, with one event on stdin. */
function runHook(hookCommand: string, eventText: string, env: NodeJS.ProcessEnv, cwd: string): Promise<HookRun> {
  return new Promise((done) => {
    const child = trackAgentChild(
      spawn(hookCommand, { shell: true, cwd, env, stdio: ['pipe', 'pipe', 'pipe'], timeout: GUARD_TIMEOUT_SECONDS * 1000 }),
    );
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr = (stderr + chunk).slice(-2000)));
    child.stdin.on('error', () => undefined);
    child.stdin.end(eventText);
    child.on('error', (error) => done({ code: null, stdout, stderr, error: error.message }));
    child.on('close', (code) => done({ code, stdout, stderr }));
  });
}

/** Reads the guard's audit file: one line per call it saw. A missing file means it saw none. */
async function readAudit(audit: string): Promise<GuardAuditLine[]> {
  let text: string;
  try {
    text = await readFile(audit, 'utf8');
  } catch {
    return [];
  }
  const lines: GuardAuditLine[] = [];
  for (const line of text.split('\n')) {
    if (line === '') continue;
    try {
      lines.push(JSON.parse(line) as GuardAuditLine);
    } catch {
      // A torn line names no call, so the call it was for counts as unseen.
    }
  }
  return lines;
}

/**
 * Runs the exact hook command on a synthetic read outside an empty copy,
 * with no model involved, and requires the guard to deny it and audit it.
 * Returns why the guard cannot be trusted, or undefined when it held.
 */
async function preflightGuard(hookCommand: string, env: NodeJS.ProcessEnv): Promise<string | undefined> {
  const dir = await mkdtemp(join(tmpdir(), 'second-look-guard-preflight-'));
  try {
    const root = join(dir, 'copy');
    await mkdir(root);
    const audit = join(dir, 'audit.jsonl');
    const event = {
      session_id: PREFLIGHT_TOOL_USE_ID,
      hook_event_name: 'PreToolUse',
      cwd: root,
      permission_mode: CLAUDE_PERMISSION_MODE,
      tool_name: 'Read',
      tool_input: { file_path: join(dir, 'outside.txt') },
      tool_use_id: PREFLIGHT_TOOL_USE_ID,
    };
    const answer = await runHook(hookCommand, JSON.stringify(event), claudeRunEnvironment(env, root, audit), root);
    if (answer.error) return answer.error;
    const detail = answer.stderr.trim() ? `: ${answer.stderr.trim().split('\n').slice(-3).join(' ')}` : '';
    if (answer.code !== 0) return `the hook exited with ${answer.code}${detail}`;
    let decision: unknown;
    try {
      const parsed = JSON.parse(answer.stdout) as { hookSpecificOutput?: { permissionDecision?: unknown } };
      decision = parsed.hookSpecificOutput?.permissionDecision;
    } catch {
      decision = undefined;
    }
    if (decision !== 'deny') return 'the hook did not refuse a read outside the copy';
    const audited = await readAudit(audit);
    if (!audited.some((line) => line.id === PREFLIGHT_TOOL_USE_ID && line.decision === 'deny')) {
      return 'the hook did not write its audit line';
    }
    return undefined;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Drives the installed Claude Code agent (ADR 0004); see {@link AgentAdapter} for the contract. */
export function claudeCodeAdapter(options: ClaudeCodeAdapterOptions = {}): AgentAdapter {
  const command = options.command ?? ['claude'];
  const guardPath = options.guardPath ?? CLAUDE_GUARD_PATH;
  const env = options.env ?? process.env;
  const killGraceMs = options.killGraceMs ?? 2000;
  let probed: Promise<AgentProbe> | undefined;

  const probe = async (): Promise<AgentProbe> => {
    const base = { agent: 'claude-code', supports: { effort: false }, lockdown: [] as string[] };
    const quiet = claudeEnvironment(env);
    const version = await capture(command, ['--version'], quiet);
    if (version.code !== 0) {
      const why = version.error ?? `claude --version exited with ${version.code}`;
      return { ...base, version: '', usable: false, reason: `Claude Code could not be started: ${why}` };
    }
    const found = /\d+\.\d+\.\d+\S*/.exec(version.stdout)?.[0] ?? version.stdout.trim();
    const help = await capture(command, ['--help'], quiet);
    const missing = LOCKDOWN_FLAGS.filter((flag) => !new RegExp(`(^|\\s)${flag}\\b`, 'm').test(help.stdout));
    const supports = { effort: /(^|\s)--effort\b/m.test(help.stdout) };
    if (missing.length > 0) {
      const reason = `Claude Code ${found} lacks ${missing.join(', ')}, which the companion's lockdown needs`;
      return { ...base, version: found, supports, usable: false, reason };
    }
    const unusable = (reason: string): AgentProbe => ({ ...base, version: found, supports, usable: false, reason });
    let hookCommand: string;
    try {
      hookCommand = guardHookCommand(process.execPath, guardPath);
    } catch (error) {
      return unusable(`the companion's guard cannot be handed to Claude Code safely: ${(error as Error).message}`);
    }
    if (!existsSync(guardPath)) return unusable(`the companion's guard is missing: ${guardPath}`);
    const failure = await preflightGuard(hookCommand, env).catch((error: Error) => error.message);
    if (failure !== undefined) return unusable(`the companion's guard could not be run: ${failure}`);
    return {
      ...base,
      version: found,
      supports,
      usable: true,
      lockdown: [
        "companion's guard hook checks every tool call: paths confined to the read-only copy, symbolic links " +
          'followed; credential paths, URLs and absolute or climbing glob patterns refused; every other tool denied',
        `permission mode pinned to ${CLAUDE_PERMISSION_MODE}, so Claude Code's own working-directory check also applies`,
        "credential paths also denied by permission rules; hooks pinned on over the reviewer's own settings",
        'a run fails when its permission mode is not default or a tool call has no guard audit line',
        `tool allowlist: ${CLAUDE_READ_TOOLS.join(', ')} (no shell, no network, no edits)`,
        'user-level settings only: project and local settings, and the context in the copy, stay out',
        'no MCP servers: every MCP configuration is ignored',
        'no session file written; permission prompts denied, never asked',
        'GitHub token variables removed from the agent environment',
      ],
    };
  };

  const run = async (request: AgentRunRequest): Promise<AgentRunOutcome> => {
    const probeResult = await (probed ??= probe());
    const stamp: AgentStamp = {
      agent: 'claude-code',
      agentVersion: probeResult.version,
      model: null,
      effort: request.effort && probeResult.supports.effort ? request.effort : null,
      login: claudeLogin(env),
      runAt: new Date().toISOString(),
    };
    if (!probeResult.usable) {
      return { status: 'failed', text: '', error: probeResult.reason, stamp };
    }
    let auditDir: string;
    try {
      auditDir = await mkdtemp(join(tmpdir(), 'second-look-claude-audit-'));
    } catch (error) {
      return { status: 'failed', text: '', error: `the guard's audit file could not be made: ${(error as Error).message}`, stamp };
    }
    try {
      return await runGuarded(request, probeResult, stamp, join(auditDir, 'audit.jsonl'));
    } finally {
      await rm(auditDir, { recursive: true, force: true });
    }
  };

  const runGuarded = async (
    request: AgentRunRequest,
    probeResult: AgentProbe,
    stamp: AgentStamp,
    audit: string,
  ): Promise<AgentRunOutcome> => {
    const hookCommand = guardHookCommand(process.execPath, guardPath);
    const args = claudeArguments(request, probeResult.supports.effort, hookCommand);
    const child = trackAgentChild(
      spawn(command[0]!, [...command.slice(1), ...args], {
        cwd: request.root,
        env: claudeRunEnvironment(env, request.root, audit),
        stdio: ['pipe', 'pipe', 'pipe'],
      }),
    );
    child.stdin.on('error', () => undefined);
    child.stdin.end(request.prompt);

    let text = '';
    let finalText: string | undefined;
    let error: string | undefined;
    let stderr = '';
    let permissionMode: string | undefined;
    const toolUseIds = new Set<string>();
    const deniedIds = new Set<string>();
    const tokens: AgentTokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
    let tokensReported = false;
    let cost: number | undefined;
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr = (stderr + chunk).slice(-2000)));
    const lines = createInterface({ input: child.stdout });
    lines.on('line', (line) => {
      let event: ClaudeEvent;
      try {
        event = JSON.parse(line) as ClaudeEvent;
      } catch {
        return;
      }
      const model = event.model ?? event.message?.model;
      if (model) stamp.model = model;
      if (event.type === 'system' && event.subtype === 'init') {
        permissionMode = typeof event.permissionMode === 'string' ? event.permissionMode : '';
      }
      const block = event.type === 'stream_event' && event.event?.type === 'content_block_start' ? event.event.content_block : undefined;
      if (block?.type === 'tool_use' && block.id) toolUseIds.add(block.id);
      if (event.type === 'assistant') {
        for (const part of event.message?.content ?? []) if (part.type === 'tool_use' && part.id) toolUseIds.add(part.id);
      }
      if (
        event.type === 'stream_event' &&
        event.event?.type === 'content_block_delta' &&
        event.event.delta !== undefined
      ) {
        const delta = event.event.delta;
        if (delta.type === 'text_delta' && delta.text !== undefined) text += delta.text;
        if (delta.type === 'input_json_delta' && delta.partial_json !== undefined) text += delta.partial_json;
      }
      if (event.type !== 'result') return;
      for (const denial of event.permission_denials ?? []) if (denial.tool_use_id) deniedIds.add(denial.tool_use_id);
      const usage = event.usage;
      if (usage) {
        tokensReported = true;
        tokens.input += usage.input_tokens ?? 0;
        tokens.output += usage.output_tokens ?? 0;
        tokens.cacheRead += usage.cache_read_input_tokens ?? 0;
        tokens.cacheWrite += usage.cache_creation_input_tokens ?? 0;
        tokens.total =
          tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite;
        if (event.total_cost_usd !== undefined) cost = (cost ?? 0) + event.total_cost_usd;
      }
      if (event.model) stamp.model = event.model;
      if (typeof event.result === 'string') finalText = event.result;
      if (event.is_error === true || (event.subtype !== undefined && event.subtype !== 'success')) {
        error =
          typeof event.result === 'string' && event.result !== ''
            ? event.result
            : `the run ended: ${event.subtype ?? 'unknown result'}`;
      }
    });

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), killGraceMs).unref();
    }, request.timeoutMs);
    const exit = await new Promise<{ code: number | null; spawnError?: string }>((done) => {
      child.on('error', (spawnError) => done({ code: null, spawnError: spawnError.message }));
      child.on('close', (code) => done({ code }));
    });
    clearTimeout(timer);
    // The child closes only after its output ends, so every line has been read.
    lines.close();

    if (tokensReported) stamp.tokens = tokens;
    if (cost !== undefined) stamp.costUsd = cost;
    // The checks that keep the run closed when the guard was switched off or
    // never ran: whatever such a run wrote is discarded, never shown. A call
    // Claude Code denied itself read nothing, and its deny rules are checked
    // before the hook runs, so such a call needs no audit line.
    const audited = new Set((await readAudit(audit)).map((line) => line.id));
    const unguarded = [...toolUseIds].filter((id) => !audited.has(id) && !deniedIds.has(id));
    const wrongMode =
      permissionMode === undefined || permissionMode === CLAUDE_PERMISSION_MODE
        ? undefined
        : permissionMode === ''
          ? 'Claude Code did not report its permission mode, so the answer is discarded'
          : `Claude Code ran in the ${permissionMode} permission mode instead of ${CLAUDE_PERMISSION_MODE}, ` +
            'so the answer is discarded';
    const unseen =
      unguarded.length > 0
        ? `Claude Code ran tool call ${unguarded.join(', ')} without the companion's guard, so the answer is discarded`
        : undefined;
    if (wrongMode) return { status: 'failed', text: '', error: wrongMode, stamp };
    // A run stopped at its timeout can end between a tool call starting and
    // the guard seeing it, so an unseen call only discards what it wrote.
    if (timedOut) return { status: 'timeout', text: unseen ? '' : (finalText ?? text), stamp };
    if (unseen) return { status: 'failed', text: '', error: unseen, stamp };
    if (exit.spawnError) {
      return { status: 'failed', text, error: `Claude Code could not be started: ${exit.spawnError}`, stamp };
    }
    if (error) return { status: 'failed', text, error, stamp };
    if (exit.code !== 0 || finalText === undefined) {
      const detail = stderr.trim() ? `: ${stderr.trim().split('\n').slice(-3).join(' ')}` : '';
      return { status: 'failed', text, error: `Claude Code exited with ${exit.code} without an answer${detail}`, stamp };
    }
    if (permissionMode === undefined) {
      return { status: 'failed', text: '', error: 'Claude Code never reported its permission mode, so the answer is discarded', stamp };
    }
    return { status: 'completed', text: finalText, stamp };
  };

  return {
    agent: 'claude-code',
    probe: () => (probed ??= probe()),
    run,
  };
}
