import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { defaultCacheDir, redactToken } from '@second-look/engine';
import { compareWithBaseline } from './baseline.js';
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
import { NO_AGENT, runEvaluation } from './run.js';
import type { ResultRow, RunResults } from './run.js';

const USAGE = `second-look-eval — the evaluation of the Second Look engine

Usage:
  second-look-eval record <pull-request-url> [--cases <dir>] [--id <name>]
                          [--token <token>] [--cache-dir <dir>]
  second-look-eval run [--cases <dir>]... [--model-free] [--changed-since <ref>]
                       [--baseline <file>] [--write-baseline <file>]
                       [--runs <dir>]

The record command fetches a pull request once and writes it as a case:
its metadata, description, full diff, and the base and head content the
review reads. Label the case by hand in its expected.json. Cases go to
--cases, else the first folder of SECOND_LOOK_EVAL_CASES, so a private
case is kept outside the repository unless a folder in it is named.

The run command reviews every case offline and scores it: coverage,
noise-label precision and recall per class and state, and the median and
top-3 rank position of the known important parts. It reads the cases in
--cases (the repository's own cases when none is given) and in every
folder of SECOND_LOOK_EVAL_CASES. --model-free keeps the cases tied to no
prompt; --changed-since keeps the cases tied to the prompts this branch
changed since the ref. Each run writes its stamped results and the trace
of every agent call to its own folder under --runs (default: the
engine's cache folder). With --baseline it compares the stamped rows and
exits 1 when a model-free score drops; --write-baseline stores the run.`;

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
        'cache-dir': { type: 'string' },
        'model-free': { type: 'boolean' },
        'changed-since': { type: 'string' },
        baseline: { type: 'string' },
        'write-baseline': { type: 'string' },
        runs: { type: 'string' },
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
    if (command !== 'run') {
      streams.err.write(`${USAGE}\n`);
      return 1;
    }

    const cases = await loadCases([...(values.cases ?? [REPOSITORY_CASES]), ...privateFolders]);
    const registry = await loadRegistry(REGISTRY);
    const problems = mappingProblems(registry, cases);
    if (problems.length > 0) throw new Error(problems.join('\n'));
    let selected = cases;
    if (values['model-free']) {
      selected = selected.filter((each) => each.record.prompts.length === 0);
    }
    const since = values['changed-since'];
    if (since !== undefined) {
      const changed = changedPrompts(registry, await changedPathsSince(since, PACKAGE_ROOT));
      const ids = changed.map((prompt) => prompt.id).join(', ') || 'none';
      streams.out.write(`prompts changed since ${since}: ${ids}\n`);
      selected = casesForPrompts(selected, changed);
    }
    if (selected.length === 0) {
      streams.out.write('no cases selected; nothing to run\n');
      return 0;
    }

    const run = await runEvaluation({
      cases: selected,
      registry,
      companionVersion: companionVersion(),
      runsFolder: values.runs ?? join(cacheDir, 'evaluation'),
    });
    streams.out.write(report(run.results));
    streams.out.write(`results and trace: ${run.folder}\n`);

    let failed = false;
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
      failed =
        comparison.drops.some((change) => modelFree(change.row)) ||
        comparison.missing.some(modelFree);
    }
    if (values['write-baseline']) {
      await writeFile(values['write-baseline'], `${JSON.stringify(run.results, null, 2)}\n`);
      streams.out.write(`baseline written to ${values['write-baseline']}\n`);
    }
    return failed ? 1 : 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    streams.err.write(`second-look-eval: ${token ? redactToken(message, token) : message}\n`);
    return 1;
  }
}

function format(value: number): string {
  return String(Math.round(value * 10_000) / 10_000);
}

/** The run's scores, one line per row, then any case the engine failed. */
function report(results: RunResults): string {
  const lines = results.rows.map((row) => `${row.case}  ${row.name}  ${format(row.value)}`);
  for (const failure of results.failures) {
    lines.push(`FAILED ${failure.case}: ${failure.error}`);
  }
  return `${lines.join('\n')}\n`;
}
