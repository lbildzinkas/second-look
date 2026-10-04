import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  CLAIMS_PROMPT_ID,
  DEFAULT_EFFORT,
  GROUPING_PROMPT_ID,
  RANKING_PROMPT_ID,
  STORY_PROMPT_ID,
  VERDICTS_PROMPT_ID,
  changeText,
  findClaims,
  judgeClaims,
  rankWithAgent,
  rankingItems,
  reviewChange,
  storyChecks,
  storyItems,
  writeStory,
} from '@second-look/engine';
import type { AgentAdapter, AgentSettings, AgentStamp, Part } from '@second-look/engine';
import { caseInput } from './case.js';
import type { EvaluationCase } from './case.js';
import { labelledClaims, pressFetches, reportedClaims } from './claims.js';
import type { PressedClaim } from './claims.js';
import type { PromptRegistry } from './prompts.js';
import {
  CLAIM_SCORES,
  GROUPING_AGREEMENT,
  RANK_SCORES,
  STORY_SCORES,
  VERDICT_SCORES,
  addTallies,
  scoresOf,
  tallyCase,
  tallyFinding,
  tallyJudging,
  tallyStory,
} from './score.js';
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
  /** Cases whose agent grouping, ranking, story, claims or verdicts fell back, with the prompt and why. */
  fallbacks?: { case: string; agent: string; prompt?: string; detail: string }[];
  /** How each agent, model and effort's ranking scored against the plain ranking over the same cases. */
  rankings?: RankingComparison[];
}

/**
 * The agent ranking's rank scores beside the plain ranking's, over the
 * cases the agent ranked: the score behind whether the agent ranking is
 * the default for that agent, model and effort. It matches or beats the
 * plain ranking when neither score is worse.
 */
export interface RankingComparison {
  agent: string;
  agentVersion: string;
  model: string;
  effort: string;
  /** The cases the scores count: those the agent ranked, with at least three parts. */
  cases: string[];
  plain: Record<string, number>;
  ranked: Record<string, number>;
  verdict: 'matches or beats the plain ranking' | 'falls behind the plain ranking';
}

/**
 * The scores an agent run of the grouping prompt gives each case tied to
 * it: the coverage of its parts, a hard gate at 100%, and their pairwise
 * hunk agreement with the hand labels. The other scores stay with the
 * plain pass.
 */
export const GROUPING_SCORES: readonly string[] = ['coverage', GROUPING_AGREEMENT];

/**
 * The scores an agent run of the ranking prompt gives each case tied to
 * it: the rank position of the known important parts, the plain parts
 * ranked by the agent, so they compare with the plain ranking of the same
 * parts.
 */
export const RANKING_SCORES: readonly string[] = RANK_SCORES;

export { CLAIM_SCORES, STORY_SCORES, VERDICT_SCORES };

/**
 * The prompt an agent row's score belongs to: each agent prompt gives its
 * own scores. A model-free row belongs to none.
 */
export function promptOfScore(row: { name: string; agent: string }): string | undefined {
  if (row.agent === NO_AGENT) return undefined;
  if (GROUPING_SCORES.includes(row.name)) return GROUPING_PROMPT_ID;
  if (RANKING_SCORES.includes(row.name)) return RANKING_PROMPT_ID;
  if (STORY_SCORES.includes(row.name)) return STORY_PROMPT_ID;
  if (CLAIM_SCORES.includes(row.name)) return CLAIMS_PROMPT_ID;
  if (VERDICT_SCORES.includes(row.name)) return VERDICTS_PROMPT_ID;
  return undefined;
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
  /**
   * The agent that runs the agent prompts the cases are tied to, the
   * grouping, ranking, story, claims and verdicts prompts; without one
   * the run is model-free.
   */
  agent?: { adapter: AgentAdapter; settings?: AgentSettings };
  /** The agent prompts the agent runs, by id; every prompt a case is tied to when absent. */
  prompts?: readonly string[];
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
 * the agent, its version, the model and the effort that answered; each
 * case tied to the ranking prompt has its plain parts ranked by the agent,
 * stamped the same way with its {@link RANKING_SCORES}, and each agent and
 * model's ranking is compared with the plain ranking over the cases it
 * ranked; each case tied to the story prompt has the story of its plain
 * parts written by the agent, scored on the story's plain checks with its
 * {@link STORY_SCORES} — the agent's own answer, which the run does not
 * hold to those checks; and each case tied to the claims prompt has the
 * claims of its plain parts listed by the agent, with no story to read,
 * scored against the case's hand list with its {@link CLAIM_SCORES}; and
 * each case tied to the verdicts prompt has its hand-labelled claims
 * judged by the agent, scored against the hand verdicts with its
 * {@link VERDICT_SCORES}. A grouping or ranking fallback scores what the
 * reviewer would see, the plain parts; a story fallback fails the
 * story's checks, a claims fallback lists no claim, and a verdicts
 * fallback leaves every claim not checked. With `prompts`, the agent runs only those
 * prompts. A model-free run makes no agent call, so its trace stays
 * empty.
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
    effort: agent ? (agent.effort ?? DEFAULT_EFFORT) : NO_AGENT,
    runDate,
  });
  const rowsOf = (name: string, tally: Tally, stamp: Stamp, only?: readonly string[]): ResultRow[] =>
    scoresOf(tally)
      .filter((score) => only === undefined || only.includes(score.name))
      .map((score) => ({ case: name, ...score, ...stamp }));

  const folder = join(options.runsFolder, runDate.replace(/[:.]/g, '-'));
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, TRACE_FILE), '');

  const results: RunResults = { rows: [], failures: [], fallbacks: [], rankings: [] };
  const tallies: Tally[] = [];
  const agentTallies = new Map<string, { stamp: AgentStamp; tallies: Tally[] }>();
  const rankingTallies = new Map<string, { stamp: AgentStamp; cases: string[]; tallies: Tally[]; plain: Tally[] }>();
  const storyTallies = new Map<string, { stamp: AgentStamp; tallies: Tally[] }>();
  const claimTallies = new Map<string, { stamp: AgentStamp; tallies: Tally[] }>();
  const verdictTallies = new Map<string, { stamp: AgentStamp; tallies: Tally[] }>();
  const stampKey = (stamp: Stamp): string => JSON.stringify([stamp.agent, stamp.agentVersion, stamp.model, stamp.effort]);
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

    if (!options.agent) continue;
    const agent = options.agent;
    const runs = (prompt: string): boolean =>
      evaluationCase.record.prompts.includes(prompt) && (options.prompts === undefined || options.prompts.includes(prompt));
    const settings = agent.settings ? { settings: agent.settings } : {};
    const adapterFor = (prompt: string): AgentAdapter =>
      tracingAdapter(agent.adapter, (call) =>
        traceAgentCall(folder, {
          case: evaluationCase.id,
          prompt,
          promptVersion: versions.get(prompt) ?? '',
          ...call,
        }),
      );
    const failedAgent = (error: unknown, scores: readonly string[]): void => {
      results.failures.push({ case: evaluationCase.id, error: messageOf(error) });
      const stamp = { ...stampFor(evaluationCase.record.prompts), agent: agent.adapter.agent, agentVersion: '', model: '', effort: '' };
      results.rows.push(...rowsOf(evaluationCase.id, tallyCase(input.diff, evaluationCase.expected, undefined), stamp, scores));
    };

    if (runs(GROUPING_PROMPT_ID)) {
      try {
        // The ranking, story, claims and verdicts prompts are scored on their own below, on the plain parts.
        const result = await reviewChange(input, {
          adapter: adapterFor(GROUPING_PROMPT_ID),
          ...settings,
          testedRankings: [],
          story: false,
          claims: false,
        });
        const grouping = result.grouping.agent;
        if (grouping) {
          if (grouping.outcome === 'fell back') {
            results.fallbacks!.push({ case: evaluationCase.id, agent: grouping.stamp.agent, prompt: GROUPING_PROMPT_ID, detail: grouping.detail });
          }
          const agentTally = tallyCase(input.diff, evaluationCase.expected, result.parts);
          const stamp = stampFor(evaluationCase.record.prompts, grouping.stamp);
          results.rows.push(...rowsOf(evaluationCase.id, agentTally, stamp, GROUPING_SCORES));
          const group = agentTallies.get(stampKey(stamp)) ?? { stamp: grouping.stamp, tallies: [] };
          group.tallies.push(agentTally);
          agentTallies.set(stampKey(stamp), group);
        }
      } catch (error) {
        failedAgent(error, GROUPING_SCORES);
      }
    }

    if (runs(STORY_PROMPT_ID) && parts && parts.length > 0) {
      try {
        const { story, answer } = await writeStory(parts, {
          adapter: adapterFor(STORY_PROMPT_ID),
          ...settings,
          root: input.copies.head.path,
          pullRequest: input.pullRequest,
          plainChecks: false,
        });
        if (story.outcome === 'fell back') {
          results.fallbacks!.push({ case: evaluationCase.id, agent: story.stamp.agent, prompt: STORY_PROMPT_ID, detail: story.detail });
        }
        const checks = storyChecks(storyItems(parts), answer ?? { sentences: [] }, changeText(parts));
        const storyTally: Tally = { ...tallyCase(input.diff, evaluationCase.expected, undefined), story: tallyStory(checks, answer !== undefined) };
        const stamp = stampFor(evaluationCase.record.prompts, story.stamp);
        results.rows.push(...rowsOf(evaluationCase.id, storyTally, stamp, STORY_SCORES));
        const group = storyTallies.get(stampKey(stamp)) ?? { stamp: story.stamp, tallies: [] };
        group.tallies.push(storyTally);
        storyTallies.set(stampKey(stamp), group);
      } catch (error) {
        failedAgent(error, STORY_SCORES);
      }
    }

    if (runs(CLAIMS_PROMPT_ID) && parts && parts.length > 0) {
      try {
        const claims = await findClaims(parts, {
          adapter: adapterFor(CLAIMS_PROMPT_ID),
          ...settings,
          root: input.copies.head.path,
          pullRequest: input.pullRequest,
        });
        if (claims.outcome === 'fell back') {
          results.fallbacks!.push({ case: evaluationCase.id, agent: claims.stamp.agent, prompt: CLAIMS_PROMPT_ID, detail: claims.detail });
        }
        const claimsTally: Tally = {
          ...tallyCase(input.diff, evaluationCase.expected, undefined),
          finding: tallyFinding(evaluationCase.expected.claims, claims.claims),
        };
        const stamp = stampFor(evaluationCase.record.prompts, claims.stamp);
        results.rows.push(...rowsOf(evaluationCase.id, claimsTally, stamp, CLAIM_SCORES));
        const group = claimTallies.get(stampKey(stamp)) ?? { stamp: claims.stamp, tallies: [] };
        group.tallies.push(claimsTally);
        claimTallies.set(stampKey(stamp), group);
      } catch (error) {
        failedAgent(error, CLAIM_SCORES);
      }
    }

    if (runs(VERDICTS_PROMPT_ID) && parts && parts.length > 0) {
      try {
        const labelled = labelledClaims(parts, input.pullRequest.description, evaluationCase.expected.claims);
        const judged = await judgeClaims(
          parts,
          labelled.map((each) => each.claim),
          { adapter: adapterFor(VERDICTS_PROMPT_ID), ...settings, root: input.copies.head.path },
        );
        const { judging } = judged;
        if (judging.outcome === 'fell back') {
          results.fallbacks!.push({ case: evaluationCase.id, agent: judging.stamp.agent, prompt: VERDICTS_PROMPT_ID, detail: judging.detail });
        }
        const verdictsTally: Tally = {
          ...tallyCase(input.diff, evaluationCase.expected, undefined),
          judging: tallyJudging(labelled.map((each, index) => ({ wanted: each.wanted, got: judged.claims[index]!.verdict }))),
        };
        const stamp = stampFor(evaluationCase.record.prompts, judging.stamp);
        results.rows.push(...rowsOf(evaluationCase.id, verdictsTally, stamp, VERDICT_SCORES));
        const group = verdictTallies.get(stampKey(stamp)) ?? { stamp: judging.stamp, tallies: [] };
        group.tallies.push(verdictsTally);
        verdictTallies.set(stampKey(stamp), group);
      } catch (error) {
        failedAgent(error, VERDICT_SCORES);
      }
    }

    // The agent ranks the plain parts, so its ranking compares with the
    // plain ranking of the same parts; a single part needs no agent.
    if (!runs(RANKING_PROMPT_ID) || !parts || rankingItems(parts).length < 2) continue;
    try {
      const { parts: ranked, ranking } = await rankWithAgent(parts, {
        adapter: adapterFor(RANKING_PROMPT_ID),
        ...settings,
        root: input.copies.head.path,
        pullRequest: input.pullRequest,
      });
      if (ranking.outcome === 'fell back') {
        results.fallbacks!.push({ case: evaluationCase.id, agent: ranking.stamp!.agent, prompt: RANKING_PROMPT_ID, detail: ranking.detail });
      }
      const agentTally = tallyCase(input.diff, evaluationCase.expected, ranked ?? parts);
      const stamp = stampFor(evaluationCase.record.prompts, ranking.stamp);
      results.rows.push(...rowsOf(evaluationCase.id, agentTally, stamp, RANKING_SCORES));
      const group = rankingTallies.get(stampKey(stamp)) ?? { stamp: ranking.stamp!, cases: [], tallies: [], plain: [] };
      if (agentTally.positions.length > 0) group.cases.push(evaluationCase.id);
      group.tallies.push(agentTally);
      group.plain.push(tally);
      rankingTallies.set(stampKey(stamp), group);
    } catch (error) {
      failedAgent(error, RANKING_SCORES);
    }
  }
  const allPrompts = [...new Set(options.cases.flatMap((each) => each.record.prompts))].sort();
  results.rows.push(...rowsOf(ALL_CASES, addTallies(tallies), stampFor(allPrompts)));
  for (const { stamp, tallies: byAgent } of agentTallies.values()) {
    results.rows.push(...rowsOf(ALL_CASES, addTallies(byAgent), stampFor([GROUPING_PROMPT_ID], stamp), GROUPING_SCORES));
  }
  for (const { stamp, cases, tallies: byAgent, plain } of rankingTallies.values()) {
    const rowStamp = stampFor([RANKING_PROMPT_ID], stamp);
    results.rows.push(...rowsOf(ALL_CASES, addTallies(byAgent), rowStamp, RANKING_SCORES));
    results.rankings!.push(compareRankings(rowStamp, cases, addTallies(plain), addTallies(byAgent)));
  }
  for (const { stamp, tallies: byAgent } of storyTallies.values()) {
    results.rows.push(...rowsOf(ALL_CASES, addTallies(byAgent), stampFor([STORY_PROMPT_ID], stamp), STORY_SCORES));
  }
  for (const { stamp, tallies: byAgent } of claimTallies.values()) {
    results.rows.push(...rowsOf(ALL_CASES, addTallies(byAgent), stampFor([CLAIMS_PROMPT_ID], stamp), CLAIM_SCORES));
  }
  for (const { stamp, tallies: byAgent } of verdictTallies.values()) {
    results.rows.push(...rowsOf(ALL_CASES, addTallies(byAgent), stampFor([VERDICTS_PROMPT_ID], stamp), VERDICT_SCORES));
  }

  await writeFile(join(folder, 'results.json'), `${JSON.stringify(results, null, 2)}\n`);
  return { folder, results };
}

/** The agent ranking's rank scores beside the plain ranking's over the same cases, and whether it matches or beats it. */
function compareRankings(stamp: Stamp, cases: string[], plain: Tally, ranked: Tally): RankingComparison {
  const values = (tally: Tally): Record<string, number> =>
    Object.fromEntries(scoresOf(tally).filter((score) => RANKING_SCORES.includes(score.name)).map((score) => [score.name, score.value]));
  const better = new Map(scoresOf(plain).map((score) => [score.name, score.better]));
  const [plainValues, rankedValues] = [values(plain), values(ranked)];
  const worse = Object.entries(plainValues).some(([name, value]) => {
    const agentValue = rankedValues[name];
    if (agentValue === undefined) return true;
    return better.get(name) === 'lower' ? agentValue > value : agentValue < value;
  });
  const { agent, agentVersion, model, effort } = stamp;
  return {
    agent,
    agentVersion,
    model,
    effort,
    cases,
    plain: plainValues,
    ranked: rankedValues,
    verdict: worse || cases.length === 0 ? 'falls behind the plain ranking' : 'matches or beats the plain ranking',
  };
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
