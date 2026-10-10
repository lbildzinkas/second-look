import { DEFAULT_AGENT_SETTINGS, type AgentSettings } from './agent.js';
import { AGENT_NAMES, agentAdapter, isAgentName, modelAndEffortProblem } from './agents.js';
import { budgetMeter, budgetOf } from './budget.js';
import { defaultCacheDir } from './cache.js';
import { readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import type { ClaudeCodeAdapterOptions } from './claude-code.js';
import type { PiAdapterOptions } from './pi.js';
import { runAgentProbe } from './probe.js';
import type { Budget } from './protocol.js';
import { reviewPullRequest } from './review.js';
import { readPackagePdbs } from './symbols.js';
import { runRpcServer, type RpcAgentDeps, type RpcServerDeps } from './server.js';
import { redactToken } from './rpc.js';

export { redactToken };

const USAGE = `second-look-engine — the engine of the Second Look reviewer's companion

Usage:
  second-look-engine review <pull-request-url> [--agent <pi|claude-code>]
      [--model <model>] [--effort <level>] [--agent-timeout <seconds>]
      [--criteria-heading <heading>] [--token <token>] [--cache-dir <dir>]
  second-look-engine probe <pull-request-url> [--agent <pi|claude-code>] [--target <path-or-url>]...
      [--model <model>] [--effort <level>] [--agent-timeout <seconds>]
      [--agent-concurrency <n>] [--token <token>] [--cache-dir <dir>]
  second-look-engine pdb <package-file>
  second-look-engine serve [--agent <pi|claude-code>] [--model <model>]
      [--effort <level>] [--agent-timeout <seconds>]

The review command fetches a pull request's metadata, full diff and CI,
parses the diff into files and hunks, reads the no-mistakes pipeline
report in the description, and prints a typed, versioned review result
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
agent then ranks the parts, each with a one-line reason citing the plain
signals it used; the validator rejects a missing reason, an uncited or
unknown signal, or more than a third of the parts at must review, and the
plain ranking stays then, as it does for an agent, model and effort
whose evaluation has not matched or beaten the plain ranking. The
result's ranking says which ranking is shown and why. Last, the agent
writes the story: a few sentences telling what the change does, in the
parts' reading order, each part it mentions linked. The checks reject a
story that leaves out a must-review part, mentions the parts out of
order, or names a file or code the change does not show; a rejected
story is retried once, and then the result says why there is none. Then
the agent compares the description and the linked issues with the
change, in both directions: each part neither explains is marked
unexplained with a one-line reason, and each statement describing a
change the diff does not contain is listed, quoted from where it is
made; an unknown or noise part, or a quote not found in its source,
rejects the answer, which is retried once before the result says why
there is no comparison, and with neither a description nor a linked
issue no agent is asked. Then the agent lists the claims the change makes about how code or a library
behaves — from the description, the docstrings and comments the change
adds, and the story — each quoted from its source and attached to a part;
a quote not found in its source rejects the answer, which is retried once
before the result says why the agent listed none. A fresh pipeline
report's open findings are claims too, listed first by the engine. Then
the agent judges each claim against the change, the head copy and, when
a check failed, its trimmed CI log: verified, refuted or unverifiable,
with its evidence source and the lines it cites, each of which the engine
re-reads; a citation that does not match, or the
model's memory alone, keeps a claim from verified. Last, the agent maps
each acceptance criterion of the linked issues to the change: met, partly
met, not met, can't tell or needs manual check, with the code that
implements it and the tests that cover it, each a line the engine
re-reads, and the manual checks the description reports, each a quote
the engine finds there; one that does not match makes the criterion
can't tell. Each stage is announced on stderr while the agent works.

It keeps read-only copies of the base and head versions, downloaded as
archives, in a per-pull-request cache: --cache-dir, else the
SECOND_LOOK_CACHE_DIR environment variable, else the platform's per-user
cache folder. Nothing is checked out and nothing from the pull request runs.

The result's budget counts what the review used — every agent run it
started, a retry included, every file it fetched and the bytes downloaded
— and the review's last line on stderr says the same; nothing is limited.

The review also reads the issues the pull request links — the closing
references GitHub returns, which cover the description's closing keywords
and the sidebar's "will close" links in this repository or another, and
the issues referencing the pull request — and lists each acceptance
criterion from the checklist under a heading, quoted and not checked
until the agent maps it. Issue text is untrusted: it is parsed and never
followed, and the agent reads it only as marked untrusted text. The heading is
"Acceptance criteria" unless --criteria-heading names another; GitHub
returns no closing references for a pull request into a non-default
branch, and the result says so.

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
The agent runs with file-reading tools only and signs in with its own
login; the GitHub token never reaches it. The companion's guard confines
every path to the copy, and a credential path or a URL comes back refused
(docs/agent-safety.md states each agent's reach and gaps). Each run stops
after --agent-timeout
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
request. An agents/probe request, carrying the editor's agent path
settings, reports each agent the companion can drive as installed here —
its version, whether it can run with the lockdown and why not, the effort
levels its own help lists, and for Claude Code the login it would use —
without running a model or reading a login.
Each review arrives in stages: the plain result first, in a
review/stage notification, then the result with the agent's grouping in
another while the agent ranks, then the ranked result in another while
the agent writes the story, then the result with the story in another
while the agent compares the change with its description and issues,
then the result with the comparison in another while the agent lists
the claims, then the result with the claims in another while the agent
judges them, then the result with the verdicts in another while the agent
maps the acceptance criteria, then the mapped result. Each review
request may also carry the reviewer's agent choice — the agent, model,
effort, account and agent path from the editor's settings, the path an
absolute one that replaces the agent's command — which runs that review's
agent passes and stamps the account label on their results, replacing
this command's --agent, --model and --effort for that review; a request
without a choice runs the agent chosen here.`;

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
  claudeCode?: Pick<ClaudeCodeAdapterOptions, 'command' | 'guardPath'>;
}

/** Flags that take a value, beyond --token and --cache-dir. */
const AGENT_FLAGS = ['--agent', '--target', '--model', '--effort', '--agent-timeout', '--agent-concurrency'];

/** The heading the acceptance criteria checklist sits under, as the review command names it. */
const CRITERIA_HEADING_FLAG = '--criteria-heading';

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
  let criteriaHeading: string | undefined;
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
    if (arg === CRITERIA_HEADING_FLAG) {
      const value = argv[++i];
      if (value === undefined || value.trim() === '') {
        streams.err.write(`second-look-engine: ${CRITERIA_HEADING_FLAG} needs a heading\n`);
        return 1;
      }
      criteriaHeading = value;
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
  const agentName = agentFlags['--agent']?.at(-1) ?? 'pi';
  if (!isAgentName(agentName)) {
    streams.err.write(
      `second-look-engine: unknown agent "${agentName}": choose ${AGENT_NAMES.join(' or ')}\n`,
    );
    return 1;
  }
  const adapter = agentAdapter(agentName, { pi: deps.pi, claudeCode: deps.claudeCode, env });
  const tuningProblem = modelAndEffortProblem(agentName, settings);
  if (command === 'serve') {
    if (tuningProblem) {
      streams.err.write(`second-look-engine: ${tuningProblem}\n`);
      return 1;
    }
    const agent: RpcAgentDeps = {
      adapterFor: (name, path) => agentAdapter(name, { pi: deps.pi, claudeCode: deps.claudeCode, env }, path),
      defaultAgent: agentName,
      settings,
    };
    return serve(streams, tokenFlag !== undefined, deps, cacheDirFlag ?? defaultCacheDir(env), agent);
  }
  if (command !== 'review' && command !== 'probe') {
    streams.err.write(`${USAGE}\n`);
    return 1;
  }
  if (!url) {
    streams.err.write(`second-look-engine: ${command} needs a pull request URL\n`);
    return 1;
  }
  if (command === 'review' && agentFlags['--agent'] === undefined) {
    const tuning = ['--model', '--effort', '--agent-timeout'].find((flag) => agentFlags[flag] !== undefined);
    if (tuning) {
      streams.err.write(`second-look-engine: ${tuning} tunes the agent; pass --agent to run one\n`);
      return 1;
    }
  }
  if (tuningProblem) {
    streams.err.write(`second-look-engine: ${tuningProblem}\n`);
    return 1;
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

  const meter = budgetMeter();
  try {
    const result = await reviewPullRequest(url, {
      token,
      fetch: deps.fetch,
      cacheDir: cacheDirFlag ?? defaultCacheDir(env),
      budget: meter,
      ...(criteriaHeading !== undefined ? { criteriaHeading } : {}),
      ...(agentFlags['--agent'] !== undefined
        ? {
            agentStage: {
              adapter,
              settings,
              onStage: (stage) => {
                const parts = stage.result.grouping.by === 'agent' ? "agent's" : 'plain';
                streams.err.write(`second-look-engine: ${parts} parts ready; ${stage.running}\n`);
              },
            },
          }
        : {}),
    });
    streams.out.write(`${JSON.stringify(result, null, 2)}\n`);
    streams.err.write(`second-look-engine: ${budgetUseLine(budgetOf(meter))}\n`);
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

/** What a review used, in one line: its agent runs, the files it fetched and the bytes downloaded. */
function budgetUseLine({ used }: Budget): string {
  return `used ${used.agentRuns} agent runs, ${used.filesFetched} files fetched, ${used.downloadBytes} bytes downloaded`;
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
