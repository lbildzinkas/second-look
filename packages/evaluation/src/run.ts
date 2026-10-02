import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { GROUPING_PROMPT_ID, reviewChange } from '@second-look/engine';
import type { AgentAdapter, AgentSettings, AgentStamp, Part } from '@second-look/engine';
import { caseInput } from './case.js';
import type { EvaluationCase } from './case.js';
import { pressFetches, reportedClaims } from './claims.js';
import type { PressedClaim } from './claims.js';
import type { PromptRegistry } from './prompts.js';
import { GROUPING_AGREEMENT, addTallies, scoresOf, tallyCase } from './score.js';
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
  /** Cases whose agent grouping fell back to the plain one, with why. */
  fallbacks?: { case: string; agent: string; detail: string }[];
}

/**
 * The scores an agent run of the grouping prompt gives each case tied to
 * it: the coverage of its parts, a hard gate at 100%, and their pairwise
 * hunk agreement with the hand labels. The other scores stay with the
 * plain pass.
 */
export const GROUPING_SCORES: readonly string[] = ['coverage', GROUPING_AGREEMENT];

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
  /**
   * The agent that runs the agent prompts the cases are tied to, so far
   * the grouping prompt; without one the run is model-free.
   */
  agent?: { adapter: AgentAdapter; settings?: AgentSettings };
}

/** An adapter that appends every run it makes to the run's local trace. */
function tracingAdapter(
  adapter: AgentAdapter,
  trace: (call: Omit<AgentCall, 'case' | 'prompt' | 'promptVersion'>) => Promise<void>,
): AgentAdapter {
  return {
    agent: adapter.agent,
    probe: () => adapter.probe(),
    run: async (request) => {
      const started = Date.now();
      const outcome = await adapter.run(request);
      await trace({
        agent: outcome.stamp.agent,
        agentVersion: outcome.stamp.agentVersion,
        model: outcome.stamp.model ?? '',
        effort: outcome.stamp.effort ?? '',
        startedAt: new Date(started).toISOString(),
        durationMs: Date.now() - started,
        input: `${request.instructions}\n\n${request.prompt}`,
        output: outcome.text,
      });
      return outcome;
    },
  };
}

/** A finished run: its folder and what it wrote there. */
export interface Run {
  folder: string;
  results: RunResults;
}

/**
 * Runs the engine over every case offline and scores it. Writes the
 * stamped rows to `results.json` in a new run folder, beside the local
 * trace of every agent call.
 *
 * Every case is scored on the plain pass, stamped with no agent. With an
 * agent, each case tied to the grouping prompt is reviewed again with the
 * agent grouping stage, and its {@link GROUPING_SCORES} are stamped with
 * the agent, its version, the model and the effort that answered; a
 * model-free run makes no agent call, so its trace stays empty.
 */
export async function runEvaluation(options: RunOptions): Promise<Run> {
  const runDate = (options.now ?? new Date()).toISOString();
  const versions = new Map(options.registry.prompts.map((prompt) => [prompt.id, prompt.version]));
  const stampFor = (prompts: readonly string[], agent?: AgentStamp): Stamp => ({
    companionVersion: options.companionVersion,
    promptVersions: Object.fromEntries(prompts.map((id) => [id, versions.get(id) ?? ''])),
    agent: agent?.agent ?? NO_AGENT,
    agentVersion: agent?.agentVersion ?? NO_AGENT,
    // A run that ended before naming its model leaves the stamp incomplete,
    // so its rows are never compared.
    model: agent ? (agent.model ?? '') : NO_AGENT,
    effort: agent ? (agent.effort ?? 'default') : NO_AGENT,
    runDate,
  });
  const rowsOf = (name: string, tally: Tally, stamp: Stamp, only?: readonly string[]): ResultRow[] =>
    scoresOf(tally)
      .filter((score) => only === undefined || only.includes(score.name))
      .map((score) => ({ case: name, ...score, ...stamp }));

  const folder = join(options.runsFolder, runDate.replace(/[:.]/g, '-'));
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, TRACE_FILE), '');

  const results: RunResults = { rows: [], failures: [], fallbacks: [] };
  const tallies: Tally[] = [];
  const agentTallies = new Map<string, { stamp: AgentStamp; tallies: Tally[] }>();
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
      results.failures.push({ case: evaluationCase.id, error: messageOf(error) });
    }
    const tally = tallyCase(input.diff, evaluationCase.expected, parts, claims);
    tallies.push(tally);
    results.rows.push(...rowsOf(evaluationCase.id, tally, stampFor(evaluationCase.record.prompts)));

    if (!options.agent || !evaluationCase.record.prompts.includes(GROUPING_PROMPT_ID)) continue;
    const adapter = tracingAdapter(options.agent.adapter, (call) =>
      traceAgentCall(folder, {
        case: evaluationCase.id,
        prompt: GROUPING_PROMPT_ID,
        promptVersion: versions.get(GROUPING_PROMPT_ID) ?? '',
        ...call,
      }),
    );
    try {
      const result = await reviewChange(input, { adapter, ...(options.agent.settings ? { settings: options.agent.settings } : {}) });
      const grouping = result.grouping.agent;
      if (!grouping) continue;
      if (grouping.outcome === 'fell back') {
        results.fallbacks!.push({ case: evaluationCase.id, agent: grouping.stamp.agent, detail: grouping.detail });
      }
      const agentTally = tallyCase(input.diff, evaluationCase.expected, result.parts);
      const stamp = stampFor(evaluationCase.record.prompts, grouping.stamp);
      results.rows.push(...rowsOf(evaluationCase.id, agentTally, stamp, GROUPING_SCORES));
      const key = JSON.stringify([stamp.agent, stamp.agentVersion, stamp.model, stamp.effort]);
      const group = agentTallies.get(key) ?? { stamp: grouping.stamp, tallies: [] };
      group.tallies.push(agentTally);
      agentTallies.set(key, group);
    } catch (error) {
      results.failures.push({ case: evaluationCase.id, error: messageOf(error) });
      results.rows.push(
        ...rowsOf(
          evaluationCase.id,
          tallyCase(input.diff, evaluationCase.expected, undefined),
          {
            ...stampFor(evaluationCase.record.prompts),
            agent: options.agent.adapter.agent,
            agentVersion: '',
            model: '',
            effort: '',
          },
          GROUPING_SCORES,
        ),
      );
    }
  }
  const allPrompts = [...new Set(options.cases.flatMap((each) => each.record.prompts))].sort();
  results.rows.push(...rowsOf(ALL_CASES, addTallies(tallies), stampFor(allPrompts)));
  for (const { stamp, tallies: byAgent } of agentTallies.values()) {
    results.rows.push(...rowsOf(ALL_CASES, addTallies(byAgent), stampFor([GROUPING_PROMPT_ID], stamp), GROUPING_SCORES));
  }

  await writeFile(join(folder, 'results.json'), `${JSON.stringify(results, null, 2)}\n`);
  return { folder, results };
}

/**
 * The coverage rows below 100%: coverage is a hard gate, so any of them
 * fails the run, whatever the baseline says.
 */
export function belowFullCoverage(rows: readonly ResultRow[]): ResultRow[] {
  return rows.filter((row) => row.name === 'coverage' && row.value < 1);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
