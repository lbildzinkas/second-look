import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { createInterface } from 'node:readline';
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

/**
 * The Claude Code adapter (ADR 0004): the same contract as the Pi adapter,
 * built from what Claude Code itself offers rather than a guard extension.
 *
 * - **print mode with a schema**: `--print` runs the agent once and exits,
 *   and `--json-schema` makes Claude Code validate the answer against the
 *   task's schema before returning it.
 * - **user-level settings only**: `--setting-sources user` loads the
 *   reviewer's own settings and nothing from the pull request — project
 *   and local settings, and the copy's own context, stay out.
 * - **no project MCP servers**: `--strict-mcp-config` ignores every MCP
 *   configuration except the one the run names, and the run names none.
 * - **file-reading tools only**: `--tools Read,Grep,Glob` leaves the agent
 *   without a shell, network tools or edits, and Claude Code confines its
 *   file tools to the working directory — the read-only copy.
 * - `--permission-prompts none` denies anything that would ask, and
 *   `--no-session-persistence` writes no session file.
 *
 * A Claude Code whose help lacks any of these flags is never run, rather
 * than run with a weaker lockdown.
 *
 * Each run's stamp reports which login it used. The companion never reads
 * the login — it names the source: an inherited `ANTHROPIC_API_KEY` (with a
 * warning that it silently overrides the Claude subscription), an OAuth
 * token or cloud credentials from the environment, or the stored Claude
 * subscription sign-in.
 */

/** The tools the agent may use: reading files of the copy, nothing else. */
export const CLAUDE_READ_TOOLS = ['Read', 'Grep', 'Glob'] as const;

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
  '--system-prompt',
  '--json-schema',
] as const;

export interface ClaudeCodeAdapterOptions {
  /** The command that starts Claude Code, with any leading arguments; `['claude']` by default. */
  command?: readonly string[];
  /** The engine's environment, which the agent inherits minus the GitHub login. */
  env?: NodeJS.ProcessEnv;
  /** Milliseconds between asking a timed-out Claude Code to stop and killing it. */
  killGraceMs?: number;
}

/**
 * The exact arguments of a locked-down Claude Code run: print mode, streamed
 * JSON with partial messages so a timeout keeps what was written, no session
 * file, user-level settings only, every MCP configuration ignored,
 * file-reading tools only, permission prompts denied rather than asked, and
 * the companion's own system prompt with the answer's schema. The prompt
 * itself goes on stdin, so no argument can be read as a file to attach.
 */
export function claudeArguments(
  request: Pick<AgentRunRequest, 'instructions' | 'schema' | 'model' | 'effort'>,
  supportsEffort: boolean,
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

interface ClaudeEvent {
  type?: string;
  subtype?: string;
  model?: string;
  result?: string;
  is_error?: boolean;
  usage?: ClaudeUsage;
  total_cost_usd?: number;
  event?: {
    type?: string;
    delta?: { type?: string; text?: string; partial_json?: string };
  };
  message?: { model?: string };
}

/** Drives the installed Claude Code agent (ADR 0004); see {@link AgentAdapter} for the contract. */
export function claudeCodeAdapter(options: ClaudeCodeAdapterOptions = {}): AgentAdapter {
  const command = options.command ?? ['claude'];
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
    return {
      ...base,
      version: found,
      supports,
      usable: true,
      lockdown: [
        `tool allowlist: ${CLAUDE_READ_TOOLS.join(', ')} (no shell, no network, no edits)`,
        'file tools confined to the read-only copy by Claude Code itself',
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
    const child = trackAgentChild(
      spawn(command[0]!, [...command.slice(1), ...claudeArguments(request, probeResult.supports.effort)], {
        cwd: request.root,
        env: claudeEnvironment(env),
        stdio: ['pipe', 'pipe', 'pipe'],
      }),
    );
    child.stdin.on('error', () => undefined);
    child.stdin.end(request.prompt);

    let text = '';
    let finalText: string | undefined;
    let error: string | undefined;
    let stderr = '';
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
    if (timedOut) return { status: 'timeout', text: finalText ?? text, stamp };
    if (exit.spawnError) {
      return { status: 'failed', text, error: `Claude Code could not be started: ${exit.spawnError}`, stamp };
    }
    if (error) return { status: 'failed', text, error, stamp };
    if (exit.code !== 0 || finalText === undefined) {
      const detail = stderr.trim() ? `: ${stderr.trim().split('\n').slice(-3).join(' ')}` : '';
      return { status: 'failed', text, error: `Claude Code exited with ${exit.code} without an answer${detail}`, stamp };
    }
    return { status: 'completed', text: finalText, stamp };
  };

  return {
    agent: 'claude-code',
    probe: () => (probed ??= probe()),
    run,
  };
}
