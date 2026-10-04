import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { trackAgentChild } from './agent-children.js';
import {
  GITHUB_TOKEN_VARIABLES,
  type AgentAdapter,
  type AgentProbe,
  type AgentRunOutcome,
  type AgentRunRequest,
  type AgentStamp,
  type AgentTokens,
} from './agent.js';
import { READ_ROOT_VARIABLE, READ_TOOLS } from './pi-guard.js';

/**
 * The flags the lockdown needs. A Pi whose help lacks any of them is never
 * run, rather than run with a weaker lockdown.
 */
const LOCKDOWN_FLAGS = [
  '--mode',
  '--no-session',
  '--offline',
  '--no-approve',
  '--no-extensions',
  '--extension',
  '--no-skills',
  '--no-prompt-templates',
  '--no-themes',
  '--no-context-files',
  '--tools',
  '--system-prompt',
] as const;

/** The guard extension built next to this file. */
export const PI_GUARD_PATH = fileURLToPath(new URL('./pi-guard.js', import.meta.url));

export interface PiAdapterOptions {
  /** The command that starts Pi, with any leading arguments; `['pi']` by default. */
  command?: readonly string[];
  /** The guard extension Pi loads; {@link PI_GUARD_PATH} by default. */
  guardPath?: string;
  /** The engine's environment, which the agent inherits minus the GitHub login. */
  env?: NodeJS.ProcessEnv;
  /** Milliseconds between asking a timed-out Pi to stop and killing it. */
  killGraceMs?: number;
}

/**
 * The exact arguments of a locked-down Pi run: JSON events, no session
 * file, no startup network, the project's Pi settings and the reviewer's
 * extensions, skills, prompt templates, themes and context files all off,
 * the companion's guard loaded, file-reading tools only, and the
 * companion's own system prompt. The prompt itself goes on stdin, so no
 * argument can be read as a file to attach.
 */
export function piArguments(
  request: Pick<AgentRunRequest, 'instructions' | 'model' | 'effort'>,
  guardPath: string,
  supportsEffort: boolean,
): string[] {
  return [
    '--mode',
    'json',
    '--no-session',
    '--offline',
    '--no-approve',
    '--no-extensions',
    '--extension',
    guardPath,
    '--no-skills',
    '--no-prompt-templates',
    '--no-themes',
    '--no-context-files',
    '--tools',
    READ_TOOLS.join(','),
    '--system-prompt',
    request.instructions,
    ...(request.model ? ['--model', request.model] : []),
    ...(request.effort && supportsEffort ? ['--thinking', request.effort] : []),
  ];
}

/** The agent's environment: the engine's, minus the GitHub login, plus the read root. */
export function piEnvironment(env: NodeJS.ProcessEnv, root: string): NodeJS.ProcessEnv {
  const clean: NodeJS.ProcessEnv = { ...env };
  for (const name of GITHUB_TOKEN_VARIABLES) delete clean[name];
  return { ...clean, [READ_ROOT_VARIABLE]: root, PI_OFFLINE: '1', PI_TELEMETRY: '0' };
}

interface Captured {
  code: number | null;
  stdout: string;
  error?: string;
}

/** Runs a short Pi command, such as `--version`, outside any project folder. */
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

interface PiUsage {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  totalTokens?: number;
  cost?: { total?: number };
}

interface PiAssistantMessage {
  role: string;
  content?: { type: string; text?: string }[];
  provider?: string;
  model?: string;
  providerThinkingLevel?: string;
  usage?: PiUsage;
  stopReason?: string;
  errorMessage?: string;
}

interface PiEvent {
  type?: string;
  message?: PiAssistantMessage;
  assistantMessageEvent?: { type?: string; delta?: string };
}

/** Drives the Pi coding agent (ADR 0004); see {@link AgentAdapter} for the contract. */
export function piAdapter(options: PiAdapterOptions = {}): AgentAdapter {
  const command = options.command ?? ['pi'];
  const guardPath = options.guardPath ?? PI_GUARD_PATH;
  const env = options.env ?? process.env;
  const killGraceMs = options.killGraceMs ?? 2000;
  let probed: Promise<AgentProbe> | undefined;

  const probe = async (): Promise<AgentProbe> => {
    const base = { agent: 'pi', supports: { effort: false }, lockdown: [] as string[] };
    const quiet = piEnvironment(env, tmpdir());
    const version = await capture(command, ['--version'], quiet);
    if (version.code !== 0) {
      const why = version.error ?? `pi --version exited with ${version.code}`;
      return { ...base, version: '', usable: false, reason: `Pi could not be started: ${why}` };
    }
    const found = /\d+\.\d+\.\d+\S*/.exec(version.stdout)?.[0] ?? version.stdout.trim();
    const help = await capture(command, ['--help'], quiet);
    const missing = LOCKDOWN_FLAGS.filter((flag) => !new RegExp(`(^|\\s)${flag}\\b`, 'm').test(help.stdout));
    const supports = { effort: /(^|\s)--thinking\b/m.test(help.stdout) };
    if (missing.length > 0) {
      const reason = `Pi ${found} lacks ${missing.join(', ')}, which the companion's lockdown needs`;
      return { ...base, version: found, supports, usable: false, reason };
    }
    if (!existsSync(guardPath)) {
      return { ...base, version: found, supports, usable: false, reason: `the companion's guard is missing: ${guardPath}` };
    }
    return {
      ...base,
      version: found,
      supports,
      usable: true,
      lockdown: [
        'guard extension confines every path to the read-only copy and refuses credential paths and URLs',
        `tool allowlist: ${READ_TOOLS.join(', ')} (no shell, no network)`,
        'project Pi settings, extensions, skills, prompt templates, themes and context files off',
        'GitHub token variables removed from the agent environment',
      ],
    };
  };

  const run = async (request: AgentRunRequest): Promise<AgentRunOutcome> => {
    const probeResult = await (probed ??= probe());
    const stamp: AgentStamp = {
      agent: 'pi',
      agentVersion: probeResult.version,
      model: null,
      effort: request.effort && probeResult.supports.effort ? request.effort : null,
      runAt: new Date().toISOString(),
    };
    if (!probeResult.usable) {
      return { status: 'failed', text: '', error: probeResult.reason, stamp };
    }
    const args = piArguments(request, guardPath, probeResult.supports.effort);
    const child = trackAgentChild(
      spawn(command[0]!, [...command.slice(1), ...args], {
        cwd: request.root,
        env: piEnvironment(env, request.root),
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
      let event: PiEvent;
      try {
        event = JSON.parse(line) as PiEvent;
      } catch {
        return;
      }
      if (event.type === 'message_start' && event.message?.role === 'assistant') text = '';
      if (event.type === 'message_update' && event.assistantMessageEvent?.type === 'text_delta') {
        text += event.assistantMessageEvent.delta ?? '';
      }
      const message = event.message;
      if (event.type !== 'message_end' || message?.role !== 'assistant') return;
      text = (message.content ?? []).filter((part) => part.type === 'text').map((part) => part.text ?? '').join('');
      if (message.provider && message.model) stamp.model = `${message.provider}/${message.model}`;
      if (message.providerThinkingLevel) stamp.effort = message.providerThinkingLevel;
      if (message.usage) {
        tokensReported = true;
        tokens.input += message.usage.input ?? 0;
        tokens.output += message.usage.output ?? 0;
        tokens.cacheRead += message.usage.cacheRead ?? 0;
        tokens.cacheWrite += message.usage.cacheWrite ?? 0;
        tokens.total += message.usage.totalTokens ?? 0;
        if (message.usage.cost?.total !== undefined) cost = (cost ?? 0) + message.usage.cost.total;
      }
      if (message.stopReason === 'error' || message.stopReason === 'aborted') {
        error = message.errorMessage ?? `the model's answer ended: ${message.stopReason}`;
      } else if (message.stopReason !== 'toolUse') {
        finalText = text;
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
    if (exit.spawnError) return { status: 'failed', text, error: `Pi could not be started: ${exit.spawnError}`, stamp };
    if (error) return { status: 'failed', text, error, stamp };
    if (exit.code !== 0 || finalText === undefined) {
      const detail = stderr.trim() ? `: ${stderr.trim().split('\n').slice(-3).join(' ')}` : '';
      return { status: 'failed', text, error: `Pi exited with ${exit.code} without an answer${detail}`, stamp };
    }
    return { status: 'completed', text: finalText, stamp };
  };

  return {
    agent: 'pi',
    probe: () => (probed ??= probe()),
    run,
  };
}
