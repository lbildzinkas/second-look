import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import {
  DEFAULT_AGENT_SETTINGS,
  defaultCacheDir,
  piAdapter,
  redactToken,
  type AgentSettings,
} from '@second-look/engine';
import { compareWithBaseline, mergeBaseline } from './baseline.js';
import type { ScoreChange } from './baseline.js';
import { loadCases } from './case.js';
import {
  casesForPrompts,
  changedPathsSince,
  changedPrompts,
  loadRegistry,
  mappingProblems,
} from './prompts.js';
import { recordCase } from './record.js';
import { seedCase } from './seed.js';
import { NO_AGENT, belowFullCoverage, runEvaluation } from './run.js';
import type { ResultRow, RunResults } from './run.js';

const USAGE = `second-look-eval — the evaluation of the Second Look engine

Usage:
  second-look-eval record <pull-request-url> [--cases <dir>] [--id <name>]
                          [--token <token>] [--cache-dir <dir>]
  second-look-eval seed <mutant.diff> --source <dir> --id <name>
                        [--cases <dir>] [--fault <path>]
  second-look-eval run [--cases <dir>]... [--model-free] [--changed-since <ref>]
                       [--agent pi [--model <model>] [--effort <level>]
                        [--agent-timeout <seconds>]]
                       [--baseline <file>] [--write-baseline <file>]
                       [--runs <dir>]

The record command fetches a pull request once and writes it as a case:
its metadata, description, full diff, and the base and head content the
review reads. Label the case by hand in its expected.json. Cases go to
--cases, else the first folder of SECOND_LOOK_EVAL_CASES, so a private
case is kept outside the repository unless a folder in it is named.

The seed command wraps one mutant as a case offline: the mutant is a
unified diff (mutmut show, or a Stryker mutant applied by hand and diffed)
against the un-mutated code in --source, a clean export of the mutated
project at the base commit. The diff may wrap the mutant with benign
edits from the same project, so the ranking has other parts to put
beside the fault; --fault then names the mutated file, and only that
file's parts are marked important. Without --fault every part is, the
starting point the revert-the-fix recipe labels by hand. The wrapped
pull request carries neutral wording — its title, branch and description
name only the changed files, never what the edit does — and the
expected.json is written in full: each changed file's noise as the live
review assessed it, the part holding the fault as the important part.
Cases go to --cases, else
the first folder of SECOND_LOOK_EVAL_CASES; public cases come only from
public code.

The run command reviews every case offline and scores it: coverage,
noise-label precision and recall per class and state, the median and
top-3 rank position of the known important parts, the grouping's
pairwise hunk agreement with the hand labels, the story's plain checks
(every must-review part linked, reading order, only names the change
shows), the recall and precision of the claims the agent lists against
the hand lists, the accuracy and false-verified rate of the verdicts the
agent gives the hand-labelled claims, the recall and precision of the
unexplained changes the agent finds in each direction against the hand
labels, the accuracy, false-met rate and evidence recall of the verdicts
the agent gives the acceptance criteria against the hand labels, the
plain checks of the comments the agent drafts from hand-written findings
(cites an evidence location, adds no claim the finding lacks, stays within
the length cap), the plain checks of the explanations the agent gives of
the labelled parts (cites only lines the part shows, names only what the
change shows), the verdicts the verify ask gives the hand-labelled
selections (accuracy, false-verified rate, fetch offered), what the agent
says covers the labelled parts (citations checked, test recall and
precision, manual-check recall, none found), and the claim checks over the
hand-labelled verdicts (found, verdict, evidence, fetch offered), which
the plain pass fails as expected failures, since it reports no claims;
the stored baseline records them at those failing values. It reads the cases in
--cases (the repository's own cases when none is given) and in every
folder of SECOND_LOOK_EVAL_CASES. --model-free keeps the cases tied to no
prompt; --changed-since keeps the cases tied to the prompts this branch
changed since the ref, and the agent then runs only those prompts.
Without --agent no model is called. With --agent pi, the cases tied to
the grouping prompt also run it through the reviewer's installed Pi, the
cases tied to the ranking prompt have their plain parts ranked by it, the
cases tied to the story prompt have the story of their plain parts
written by it, the cases tied to the claims prompt have the claims of
their plain parts listed by it, the cases tied to the verdicts prompt
have their hand-labelled claims judged by it and each hand-labelled
selection judged alone, as the verify ask judges it, the cases tied to the
unexplained-changes prompt have their plain parts compared by it with
their description and recorded linked issues, the cases tied to the
criteria-mapping prompt have their recorded acceptance criteria mapped by
it to their plain parts, the cases tied to the draft-comment prompt have
a comment drafted by it from each hand-written finding, the cases tied to the
explain prompt have each labelled part explained by it, the cases tied to the
cover prompt have each labelled part asked what covers it, the cases tied to the
library verdicts prompt have every library fetch those verdicts offer
pressed from their recorded downloads and each pressed claim judged again
in the library's source, scored by the claim checks, and those rows are
stamped with the agent and model that answered; the report says whether each agent, model and
effort's ranking matches or beats the plain ranking over the cases it
ranked. Each run writes its stamped results and the trace
of every agent call to its own folder under --runs (default: the
engine's cache folder). Coverage is a hard gate: the run exits 1 when any
coverage is below 100%. With --baseline it compares the stamped rows and
exits 1 when a model-free score drops; --write-baseline stores the run,
keeping the stored rows of the cases, agents and models it did not run.`;

const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url));
const REPOSITORY_CASES = join(PACKAGE_ROOT, 'cases');
const REGISTRY = join(PACKAGE_ROOT, 'prompts.json');

export interface WriteDestination {
  write(chunk: string): boolean;
}

export interface CliStreams {
  out: WriteDestination;
  err: WriteDestination;
}

export interface CliDeps {
  fetch?: typeof fetch;
}

/** The companion version every row is stamped with: the engine's. */
function companionVersion(): string {
  const manifest = createRequire(import.meta.url)('@second-look/engine/package.json') as {
    version: string;
  };
  return manifest.version;
}

/** Runs the command line; returns the exit code. Never prints the token. */
export async function runCli(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
  streams: CliStreams,
  deps: CliDeps = {},
): Promise<number> {
  let token: string | undefined;
  try {
    const { values, positionals } = parseArgs({
      args: [...argv],
      allowPositionals: true,
      options: {
        help: { type: 'boolean', short: 'h' },
        cases: { type: 'string', multiple: true },
        id: { type: 'string' },
        token: { type: 'string' },
        source: { type: 'string' },
        fault: { type: 'string' },
        'cache-dir': { type: 'string' },
        'model-free': { type: 'boolean' },
        'changed-since': { type: 'string' },
        baseline: { type: 'string' },
        'write-baseline': { type: 'string' },
        runs: { type: 'string' },
        agent: { type: 'string' },
        model: { type: 'string' },
        effort: { type: 'string' },
        'agent-timeout': { type: 'string' },
      },
    });
    if (values.help) {
      streams.out.write(`${USAGE}\n`);
      return 0;
    }
    const privateFolders = (env['SECOND_LOOK_EVAL_CASES'] ?? '').split(delimiter).filter(Boolean);
    const cacheDir = values['cache-dir'] ?? defaultCacheDir(env);
    const [command, url] = positionals;

    if (command === 'record') {
      token = values.token ?? env['GITHUB_TOKEN'] ?? env['GH_TOKEN'];
      const casesFolder = values.cases?.[0] ?? privateFolders[0];
      if (!url) throw new Error('record needs a pull request URL');
      if (!token) throw new Error('no GitHub token; pass one with --token or GITHUB_TOKEN');
      if (!casesFolder) throw new Error('name a cases folder with --cases or SECOND_LOOK_EVAL_CASES');
      const folder = await recordCase(url, {
        token,
        cacheDir,
        casesFolder,
        ...(values.id ? { id: values.id } : {}),
        ...(deps.fetch ? { fetch: deps.fetch } : {}),
      });
      streams.out.write(`recorded ${folder}; label it by hand in its expected.json\n`);
      return 0;
    }
    if (command === 'seed') {
      if (!url) throw new Error('seed needs the mutant diff file');
      const casesFolder = values.cases?.[0] ?? privateFolders[0];
      if (!values.source) throw new Error('seed needs --source: the un-mutated code the diff applies to');
      if (!values.id) throw new Error('seed needs --id: the seeded case\'s name');
      if (!casesFolder) throw new Error('name a cases folder with --cases or SECOND_LOOK_EVAL_CASES');
      const folder = await seedCase(await readFile(url, 'utf8'), {
        sourceDir: values.source,
        casesFolder,
        id: values.id,
        ...(values.fault ? { faultPath: values.fault } : {}),
      });
      streams.out.write(
        `seeded ${folder}; its expected.json marks the part holding the fault\n`,
      );
      return 0;
    }
    if (command !== 'run') {
      streams.err.write(`${USAGE}\n`);
      return 1;
    }

    const folders = [...(values.cases ?? [REPOSITORY_CASES]), ...privateFolders];
    const cases = await loadCases(folders);
    const registry = await loadRegistry(REGISTRY);
    const problems = mappingProblems(registry, cases, { everyPromptHasACase: values.cases === undefined });
    if (problems.length > 0) throw new Error(problems.join('\n'));
    let selected = cases;
    let prompts: string[] | undefined;
    if (values['model-free']) {
      selected = selected.filter((each) => each.record.prompts.length === 0);
    }
    const since = values['changed-since'];
    if (since !== undefined) {
      const changed = changedPrompts(registry, await changedPathsSince(since, PACKAGE_ROOT));
      const ids = changed.map((prompt) => prompt.id).join(', ') || 'none';
      streams.out.write(`prompts changed since ${since}: ${ids}\n`);
      selected = casesForPrompts(selected, changed);
      prompts = changed.map((prompt) => prompt.id);
    }
    if (selected.length === 0) {
      streams.out.write('no cases selected; nothing to run\n');
      return 0;
    }

    const agent = agentOption(values, env);
    const run = await runEvaluation({
      cases: selected,
      registry,
      companionVersion: companionVersion(),
      runsFolder: values.runs ?? join(cacheDir, 'evaluation'),
      ...(agent ? { agent } : {}),
      ...(prompts ? { prompts } : {}),
    });
    streams.out.write(report(run.results));
    streams.out.write(`results and trace: ${run.folder}\n`);

    // Coverage is a hard gate: every changed line in exactly one part.
    const uncovered = belowFullCoverage(run.results.rows);
    for (const row of uncovered) {
      streams.out.write(`COVERAGE below 100% ${row.case} (${row.agent}): ${format(row.value)}\n`);
    }
    let failed = uncovered.length > 0;
    if (values.baseline) {
      const stored = JSON.parse(await readFile(values.baseline, 'utf8')) as RunResults;
      const comparison = compareWithBaseline(run.results.rows, stored.rows);
      const modelFree = (row: ResultRow) => row.agent === NO_AGENT;
      const line = (change: ScoreChange) =>
        `${change.row.case} ${change.row.name}: ${format(change.baseline)} -> ${format(change.row.value)}`;
      for (const change of comparison.drops) streams.out.write(`DROP ${line(change)}\n`);
      for (const row of comparison.missing) streams.out.write(`MISSING ${row.case} ${row.name}\n`);
      for (const change of comparison.gains) streams.out.write(`gain ${line(change)}\n`);
      streams.out.write(
        `baseline: ${comparison.drops.length} dropped, ${comparison.missing.length} missing, ` +
          `${comparison.gains.length} gained, ${comparison.unchanged} unchanged, ` +
          `${comparison.withoutBaseline.length} without a baseline, ` +
          `${comparison.unstamped} unstamped and not compared\n`,
      );
      failed ||=
        comparison.drops.some((change) => modelFree(change.row)) ||
        comparison.missing.some(modelFree);
    }
    const target = values['write-baseline'];
    if (target) {
      const stored = await readBaseline(target);
      const merged = stored ? mergeBaseline(stored, run.results) : run.results;
      await writeFile(target, `${JSON.stringify(merged, null, 2)}\n`);
      streams.out.write(`baseline written to ${target}\n`);
    }
    return failed ? 1 : 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    streams.err.write(`second-look-eval: ${token ? redactToken(message, token) : message}\n`);
    return 1;
  }
}

/** The agent a run drives, from its flags; none unless --agent names one. */
function agentOption(
  values: { agent?: string; model?: string; effort?: string; 'agent-timeout'?: string; 'model-free'?: boolean },
  env: NodeJS.ProcessEnv,
): { adapter: ReturnType<typeof piAdapter>; settings: AgentSettings } | undefined {
  if (values.agent === undefined) return undefined;
  if (values.agent !== 'pi') throw new Error(`--agent ${values.agent} is not supported; the one agent so far is pi`);
  if (values['model-free']) throw new Error('--model-free runs no agent; leave out --agent');
  const settings: AgentSettings = { ...DEFAULT_AGENT_SETTINGS };
  if (values['agent-timeout'] !== undefined) {
    const seconds = Number(values['agent-timeout']);
    if (!(seconds > 0)) throw new Error('--agent-timeout needs a number of seconds above zero');
    settings.timeoutMs = Math.round(seconds * 1000);
  }
  if (values.model) settings.model = values.model;
  if (values.effort) settings.effort = values.effort;
  return { adapter: piAdapter({ env }), settings };
}

/** A stored baseline, or undefined when the file does not exist yet. */
async function readBaseline(path: string): Promise<RunResults | undefined> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as RunResults;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

function format(value: number): string {
  return String(Math.round(value * 10_000) / 10_000);
}

/** The run's scores, one line per row, then any case the engine failed. */
function report(results: RunResults): string {
  const lines = results.rows.map((row) => {
    const note = row.note ? `  (${row.note})` : '';
    const agent = row.agent === NO_AGENT ? '' : `  [${row.agent} ${row.agentVersion} ${row.model || 'unknown model'}]`;
    return `${row.case}  ${row.name}  ${format(row.value)}${agent}${note}`;
  });
  for (const failure of results.failures) {
    lines.push(`FAILED ${failure.case}: ${failure.error}`);
  }
  for (const fallback of results.fallbacks ?? []) {
    const prompt = fallback.prompt ? `, ${fallback.prompt}` : '';
    lines.push(`FELL BACK ${fallback.case} (${fallback.agent}${prompt}): ${fallback.detail}`);
  }
  for (const ranking of results.rankings ?? []) {
    const scores = (values: Record<string, number>) =>
      Object.entries(values).map(([name, value]) => `${name} ${format(value)}`).join(', ') || 'no scores';
    lines.push(
      `RANKING ${ranking.agent} ${ranking.agentVersion} ${ranking.model || 'unknown model'} ${ranking.effort}: ` +
        `${ranking.verdict} over ${ranking.cases.length} cases (agent: ${scores(ranking.ranked)}; plain: ${scores(ranking.plain)})`,
    );
  }
  return `${lines.join('\n')}\n`;
}
