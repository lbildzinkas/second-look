import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { reviewChange } from '@second-look/engine';
import type { Part } from '@second-look/engine';
import { caseInput } from './case.js';
import type { EvaluationCase } from './case.js';
import { pressFetches, reportedClaims } from './claims.js';
import type { PressedClaim } from './claims.js';
import type { PromptRegistry } from './prompts.js';
import { addTallies, scoresOf, tallyCase } from './score.js';
import type { Score, Tally } from './score.js';

/** The agent stamp of a model-free run: no agent, no model, no effort. */
export const NO_AGENT = 'none';

/** The case name of a run's overall rows, which no case folder can take. */
export const ALL_CASES = '(all)';

/**
 * What every result row carries, so two runs are compared only when their
 * rows say what produced them.
 */
export interface Stamp {
  companionVersion: string;
  /** The version of each prompt the row's cases are tied to, by prompt id. */
  promptVersions: Record<string, string>;
  agent: string;
  agentVersion: string;
  model: string;
  effort: string;
  /** When the run started, as an ISO date. */
  runDate: string;
}

/** The fields of {@link Stamp}; a row missing any of them is never compared. */
export const STAMP_FIELDS: readonly (keyof Stamp)[] = [
  'companionVersion',
  'promptVersions',
  'agent',
  'agentVersion',
  'model',
  'effort',
  'runDate',
];

/** One score of one case (or of the whole run), with its stamp. */
export interface ResultRow extends Stamp, Score {
  case: string;
}

/** A run's `results.json`; a stored baseline has the same shape. */
export interface RunResults {
  rows: ResultRow[];
  /** Cases whose review failed, with the engine's message. */
  failures: { case: string; error: string }[];
}

/** One agent call, as the run's local trace keeps it. */
export interface AgentCall {
  case: string;
  prompt: string;
  promptVersion: string;
  agent: string;
  agentVersion: string;
  model: string;
  effort: string;
  startedAt: string;
  durationMs: number;
  input: string;
  output: string;
}

/** The trace file in a run folder: one JSON line per agent call. */
export const TRACE_FILE = 'trace.jsonl';

/** Appends one agent call to the run's local trace. */
export async function traceAgentCall(runFolder: string, call: AgentCall): Promise<void> {
  await appendFile(join(runFolder, TRACE_FILE), `${JSON.stringify(call)}\n`);
}

export interface RunOptions {
  cases: readonly EvaluationCase[];
  registry: PromptRegistry;
  companionVersion: string;
  /** The folder each run gets its own sub-folder in. */
  runsFolder: string;
  /** The run's start; the clock when not given. */
  now?: Date;
}

/** A finished run: its folder and what it wrote there. */
export interface Run {
  folder: string;
  results: RunResults;
}

/**
 * Runs the engine over every case offline and scores it. Writes the
 * stamped rows to `results.json` in a new run folder, beside the local
 * trace of every agent call; a model-free run makes none, so its trace
 * stays empty.
 */
export async function runEvaluation(options: RunOptions): Promise<Run> {
  const runDate = (options.now ?? new Date()).toISOString();
  const versions = new Map(options.registry.prompts.map((prompt) => [prompt.id, prompt.version]));
  const stampFor = (prompts: readonly string[]): Stamp => ({
    companionVersion: options.companionVersion,
    promptVersions: Object.fromEntries(prompts.map((id) => [id, versions.get(id) ?? ''])),
    agent: NO_AGENT,
    agentVersion: NO_AGENT,
    model: NO_AGENT,
    effort: NO_AGENT,
    runDate,
  });
  const rowsOf = (name: string, tally: Tally, stamp: Stamp): ResultRow[] =>
    scoresOf(tally).map((score) => ({ case: name, ...score, ...stamp }));

  const results: RunResults = { rows: [], failures: [] };
  const tallies: Tally[] = [];
  for (const evaluationCase of options.cases) {
    const input = await caseInput(evaluationCase);
    let parts: Part[] | undefined;
    let claims: PressedClaim[] = [];
    try {
      const result = await reviewChange(input);
      parts = result.parts;
      // The evaluation stands in for the reviewer and presses every fetch
      // the review offered, so the checks see what a press unlocked.
      claims = pressFetches(reportedClaims(result));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      results.failures.push({ case: evaluationCase.id, error: message });
    }
    const tally = tallyCase(input.diff, evaluationCase.expected, parts, claims);
    tallies.push(tally);
    results.rows.push(...rowsOf(evaluationCase.id, tally, stampFor(evaluationCase.record.prompts)));
  }
  const allPrompts = [...new Set(options.cases.flatMap((each) => each.record.prompts))].sort();
  results.rows.push(...rowsOf(ALL_CASES, addTallies(tallies), stampFor(allPrompts)));

  const folder = join(options.runsFolder, runDate.replace(/[:.]/g, '-'));
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, 'results.json'), `${JSON.stringify(results, null, 2)}\n`);
  await writeFile(join(folder, TRACE_FILE), '');
  return { folder, results };
}
