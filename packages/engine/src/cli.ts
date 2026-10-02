import { DEFAULT_AGENT_SETTINGS, type AgentSettings } from './agent.js';
import { agentAdapter } from './agents.js';
import { defaultCacheDir } from './cache.js';
import { readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import type { ClaudeCodeAdapterOptions } from './claude-code.js';
import type { PiAdapterOptions } from './pi.js';
import { runAgentProbe } from './probe.js';
import { reviewPullRequest } from './review.js';
import { readPackagePdbs } from './symbols.js';
import { runRpcServer, type RpcServerDeps } from './server.js';
import { redactToken } from './rpc.js';

export { redactToken };

const USAGE = `second-look-engine — the engine of the Second Look reviewer's companion

Usage:
  second-look-engine review <pull-request-url> [--agent <pi|claude-code>]
      [--model <model>] [--effort <level>] [--agent-timeout <seconds>]
      [--token <token>] [--cache-dir <dir>]
  second-look-engine probe <pull-request-url> [--agent <pi|claude-code>] [--target <path-or-url>]...
      [--model <model>] [--effort <level>] [--agent-timeout <seconds>]
      [--agent-concurrency <n>] [--token <token>] [--cache-dir <dir>]
  second-look-engine pdb <package-file>
  second-look-engine serve [--agent <pi|claude-code>] [--model <model>]
      [--effort <level>] [--agent-timeout <seconds>]

The review command fetches a pull request's metadata and full diff, parses
the diff into files and hunks, and prints a typed, versioned review result
as JSON. Each file carries a noise label (lockfile, generated, vendored,
moved or renamed, snapshot, fixture) with its state — confirmed or claimed
— and a one-line blind spot, or says that no rule applied. The labels read
the repository's linguist attributes at the head commit, without a
checkout.

The hunks are grouped into parts named after the entities they touch, and
the run fails unless every changed line is in exactly one part. Each part
gets plain signals — new versus changed code, test versus code, size,
public surface change, and a name-based count of other files mentioning
its entity names — and a fixed rule ranks it must review, worth reviewing
or context with a one-line reason, at most a third of the parts at must
review. Noise parts sink to the bottom, except snapshots and fixtures,
which are labelled but ranked with the rest.

With --agent (pi or claude-code), the reviewer's installed agent then
groups related hunks
across files into parts — a function, its caller and its test — named by
the entities they touch. Its answer is checked: hunks it leaves out go to
a part marked "not grouped by the agent", and a missing or invalid answer
keeps the plain grouping, with the reason in the result's grouping. The
plain parts are announced on stderr while the agent works.

It keeps read-only copies of the base and head versions, downloaded as
archives, in a per-pull-request cache: --cache-dir, else the
SECOND_LOOK_CACHE_DIR environment variable, else the platform's per-user
cache folder. Nothing is checked out and nothing from the pull request runs.

The GitHub token is passed in by the caller, either with --token or through
the GITHUB_TOKEN environment variable. It is used only for the GitHub
request, and is never written to disk or logs.

The probe command checks the reviewer's installed coding agent (Pi by
default, Claude Code with --agent) on a
pull request: it takes the read-only head copy, asks the agent, locked down,
to read each target (the copy's root by default), and prints what the
installed version supports, each answer checked against its schema, and the
stamp of each run: agent, version, model, effort, run date, tokens and cost.
Each adapter reports which login the run used — Claude Code, for instance,
its stored subscription sign-in, and a warning when an inherited
ANTHROPIC_API_KEY overrides it.
The agent runs with file-reading tools only, confined to the copy: a
credential path or a URL comes back refused. It signs in with its own login;
the GitHub token never reaches it. Each run stops after --agent-timeout
seconds (default ${DEFAULT_AGENT_SETTINGS.timeoutMs / 1000}), at most --agent-concurrency (default
${DEFAULT_AGENT_SETTINGS.concurrency}) at once, and a timed-out run keeps what it wrote.

The pdb command is a debug command: given a NuGet package or symbols
package (or a single .pdb or assembly), it reads every portable PDB in it,
standalone or embedded in an assembly, and prints as JSON each source
document with its hash algorithm, its hash and its Source Link URL, plus
each PDB's Source Link map. It reads only the local file.

The serve command starts the engine as a JSON-RPC server on stdio, one
JSON-RPC message per line. The protocol starts with a version handshake,
and the GitHub token then arrives with each review request — never on the
command line, where any process could read it — and is used only for that
request. Each review arrives in stages: the plain result first, in a
review/stage notification, then the result with the agent's grouping.`;

export interface WriteDestination {
  write(chunk: string): boolean;
}

export interface CliStreams {
  out: WriteDestination;
  err: WriteDestination;
}

export interface CliDeps {
  fetch?: typeof fetch;
  /** How the probe and the agent stage start Pi; tests point it at a fake agent. */
  pi?: Pick<PiAdapterOptions, 'command' | 'guardPath'>;
  /** How the probe and the agent stage start Claude Code; tests point it at a fake agent. */
  claudeCode?: Pick<ClaudeCodeAdapterOptions, 'command'>;
}

/** Flags that take a value, beyond --token and --cache-dir. */
const AGENT_FLAGS = ['--agent', '--target', '--model', '--effort', '--agent-timeout', '--agent-concurrency'];

/**
 * Runs the command line. Returns the process exit code: 0 on success,
 * 1 on any error. Never throws, never prints the token.
 */
export async function runCli(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
  streams: CliStreams,
  deps: CliDeps = {},
): Promise<number> {
  const positional: string[] = [];
  let tokenFlag: string | undefined;
  let cacheDirFlag: string | undefined;
  const agentFlags: Record<string, string[]> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--help' || arg === '-h') {
      streams.out.write(`${USAGE}\n`);
      return 0;
    }
    if (arg === '--token') {
      const value = argv[++i];
      if (value === undefined) {
        streams.err.write('second-look-engine: --token needs a value\n');
        return 1;
      }
      tokenFlag = value;
      continue;
    }
    if (arg === '--cache-dir') {
      const value = argv[++i];
      if (value === undefined) {
        streams.err.write('second-look-engine: --cache-dir needs a value\n');
        return 1;
      }
      cacheDirFlag = value;
      continue;
    }
    if (AGENT_FLAGS.includes(arg)) {
      const value = argv[++i];
      if (value === undefined) {
        streams.err.write(`second-look-engine: ${arg} needs a value\n`);
        return 1;
      }
      (agentFlags[arg] ??= []).push(value);
      continue;
    }
    positional.push(arg);
  }

  const command = positional[0];
  if (command === 'pdb') {
    return runPdb(positional[1], streams);
  }
  const url = positional[1];
  const settings = agentSettings(agentFlags);
  if (typeof settings === 'string') {
    streams.err.write(`second-look-engine: ${settings}\n`);
    return 1;
  }
  // The agent is chosen once, before any command runs, so an unknown
  // name is refused the same way everywhere; serve defaults to Pi.
  let adapter;
  try {
    adapter = agentAdapter(agentFlags['--agent']?.at(-1) ?? 'pi', { pi: deps.pi, claudeCode: deps.claudeCode, env });
  } catch (error) {
    streams.err.write(`second-look-engine: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
  if (command === 'serve') {
    const agent = { adapter, settings };
    return serve(streams, tokenFlag !== undefined, deps, cacheDirFlag ?? defaultCacheDir(env), agent);
  }
  const agentName = agentFlags['--agent']?.at(-1);
  if (command !== 'review' && command !== 'probe') {
    streams.err.write(`${USAGE}\n`);
    return 1;
  }
  if (!url) {
    streams.err.write(`second-look-engine: ${command} needs a pull request URL\n`);
    return 1;
  }
  if (command === 'review' && agentName === undefined) {
    const tuning = ['--model', '--effort', '--agent-timeout'].find((flag) => agentFlags[flag] !== undefined);
    if (tuning) {
      streams.err.write(`second-look-engine: ${tuning} tunes the agent; pass --agent to run one\n`);
      return 1;
    }
  }

  const token = tokenFlag ?? env['GITHUB_TOKEN'] ?? env['GH_TOKEN'];
  if (!token) {
    streams.err.write(
      'second-look-engine: no GitHub token; pass one with --token or the GITHUB_TOKEN environment variable\n',
    );
    return 1;
  }

  if (command === 'probe') {
    try {
      const report = await runAgentProbe(url, {
        token,
        fetch: deps.fetch,
        cacheDir: cacheDirFlag ?? defaultCacheDir(env),
        adapter,
        targets: agentFlags['--target'] ?? [],
        settings,
      });
      streams.out.write(`${JSON.stringify(report, null, 2)}\n`);
      if (!report.agent.usable) {
        streams.err.write(`second-look-engine: ${report.agent.reason}\n`);
        return 1;
      }
      return 0;
    } catch (error) {
      const message = redactToken(error instanceof Error ? error.message : String(error), token);
      streams.err.write(`second-look-engine: ${message}\n`);
      return 1;
    }
  }

  try {
    const result = await reviewPullRequest(url, {
      token,
      fetch: deps.fetch,
      cacheDir: cacheDirFlag ?? defaultCacheDir(env),
      ...(agentName
        ? {
            agentStage: {
              adapter,
              settings,
              onStage: (stage) => {
                streams.err.write(`second-look-engine: plain parts ready; ${stage.running}\n`);
              },
            },
          }
        : {}),
    });
    streams.out.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  } catch (error) {
    const message = redactToken(
      error instanceof Error ? error.message : String(error),
      token,
    );
    streams.err.write(`second-look-engine: ${message}\n`);
    return 1;
  }
}

/** Reads the agent settings from their flags; a string is the problem with them. */
function agentSettings(flags: Record<string, string[]>): AgentSettings | string {
  const last = (name: string): string | undefined => flags[name]?.at(-1);
  const settings: AgentSettings = { ...DEFAULT_AGENT_SETTINGS };
  const timeout = last('--agent-timeout');
  if (timeout !== undefined) {
    const seconds = Number(timeout);
    if (!(seconds > 0)) return '--agent-timeout needs a number of seconds above zero';
    settings.timeoutMs = Math.round(seconds * 1000);
  }
  const concurrency = last('--agent-concurrency');
  if (concurrency !== undefined) {
    const count = Number(concurrency);
    if (!Number.isInteger(count) || count < 1) return '--agent-concurrency needs a whole number of at least 1';
    settings.concurrency = count;
  }
  const model = last('--model');
  const effort = last('--effort');
  if (model) settings.model = model;
  if (effort) settings.effort = effort;
  return settings;
}

/** Prints every portable PDB in a package file, with its documents. */
async function runPdb(path: string | undefined, streams: CliStreams): Promise<number> {
  if (!path) {
    streams.err.write('second-look-engine: pdb needs a package file\n');
    return 1;
  }
  try {
    const pdbs = readPackagePdbs(path, await readFile(path));
    streams.out.write(`${JSON.stringify({ package: path, pdbs }, null, 2)}\n`);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    streams.err.write(`second-look-engine: ${message}\n`);
    return 1;
  }
}

/**
 * Serves the JSON-RPC protocol on this process's stdio until stdin ends.
 * The GitHub token arrives with each review request, so a token on the
 * command line is refused: any process on the machine could read it there.
 */
async function serve(
  streams: CliStreams,
  tokenFlagGiven: boolean,
  deps: CliDeps,
  cacheDir: string,
  agent: RpcServerDeps['agent'],
): Promise<number> {
  if (tokenFlagGiven) {
    streams.err.write(
      'second-look-engine: serve takes the GitHub token with each request, not on the command line\n',
    );
    return 1;
  }
  const lines = createInterface({ input: process.stdin });
  const iterator = lines[Symbol.asyncIterator]();
  await runRpcServer(
    {
      readLine: async () => {
        const next = await iterator.next();
        return next.done ? null : (next.value as string);
      },
    },
    {
      writeLine: (line) => {
        process.stdout.write(`${line}\n`);
      },
    },
    { cacheDir, agent, ...(deps.fetch ? { fetch: deps.fetch } : {}) },
  );
  return 0;
}
