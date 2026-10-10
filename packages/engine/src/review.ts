import {
  DEFAULT_AGENT_SETTINGS,
  agentStageTimeoutMs,
  type AgentAdapter,
  type AgentSettings,
  type AgentStamp,
} from './agent.js';
import { limitedFetch, meteredFetch, withBudget, type BudgetMeter } from './budget.js';
import { ensureCopy } from './cache.js';
import { readCi } from './ci.js';
import { findClaims } from './claims.js';
import { DEFAULT_CRITERIA_HEADING, readCriteria } from './criteria.js';
import { mapCriteria } from './criteria-mapping.js';
import { publicDocsFetch } from './doc-fetch.js';
import { findDocLinks } from './doc-links.js';
import { validateCoverage } from './coverage.js';
import { parseDiff, type ParsedDiff } from './diff.js';
import { GitHubClient, parsePullRequestUrl } from './github.js';
import { groupingItems, groupWithAgent } from './grouping.js';
import { lookSinceLastLook } from './last-look.js';
import { offerLibraryFetches } from './library-fetch.js';
import { confirmLockfileNoise } from './lockfile.js';
import { applyNoiseRules } from './noise.js';
import { groupParts } from './parts.js';
import { pipelineClaims, readPipelineReport } from './pipeline.js';
import { REVIEW_RESULT_VERSION, REVIEW_STAGE_IDS } from './protocol.js';
import type {
  ChangeCopies,
  CiResults,
  Criteria,
  Part,
  PullRequestSummary,
  ReviewResult,
  ReviewStageId,
  ReviewStageRecord,
  SinceLastLook,
} from './protocol.js';
import { rankParts } from './rank.js';
import {
  RANKING_PROMPT_VERSION,
  TESTED_RANKINGS,
  isTestedRanking,
  mayBeTestedRanking,
  notTestedDetail,
  rankWithAgent,
  rankingItems,
  type TestedRanking,
} from './ranking.js';
import { signalParts } from './signals.js';
import { writeStory } from './story.js';
import { analyseParts } from './syntax.js';
import { findUnexplained } from './unexplained.js';
import { judgeClaims } from './verdicts.js';

export interface ReviewOptions {
  /** GitHub token, passed in by the caller; never stored or logged. */
  token: string;
  /**
   * Fetch implementation the GitHub client uses. Tests inject a
   * fixture-backed fetch here so no test ever touches the network.
   */
  fetch?: typeof fetch;
  /** The engine's cache folder, which holds the read-only copies. */
  cacheDir: string;
  /** The heading the acceptance criteria checklist sits under in a linked issue; "Acceptance criteria" when absent. */
  criteriaHeading?: string;
  /** Asks the agent to group and rank the parts, write the story, compare the change with its description and issues, list the claims and judge them, and map the acceptance criteria too, after the plain pass; see {@link reviewChange}. */
  agentStage?: AgentStageOptions;
  /** True when the reviewer opened this review: it is compared with their last look, then recorded as the latest; see {@link lookSinceLastLook}. */
  lastLook?: boolean;
  /**
   * Counts what the review uses — every agent run it starts, every file it
   * downloads and their bytes — and puts the use on the result and on
   * every stage's result so far, and stops at its limits: an agent stage,
   * or its retry, starts only while a run is left, else it falls back
   * saying which limit, and a documentation download past the file or
   * size limit is refused. The review's own reads of the pull request are
   * never refused. Absent, nothing is counted or limited and the result
   * carries no budget.
   */
  budget?: BudgetMeter;
  /**
   * Aborts when the reviewer cancels the review: a download going stops,
   * the agent run going is stopped and none starts after it, the stage
   * running is marked stopped with every stage after it, and the result
   * keeps what had landed. Cancelled before the plain pass's result, the
   * review fails.
   */
  signal?: AbortSignal;
}

/**
 * Everything a review reads about one pull request, fetched once: the
 * metadata, the full diff, the root `.gitattributes` at the head commit,
 * the read-only copies of both versions, the CI at the head commit and
 * the acceptance criteria of the linked issues. A review of it touches
 * no network, so an evaluation case can replay a recorded one offline.
 */
export interface ReviewInput {
  pullRequest: PullRequestSummary;
  /** The full diff, from the diff media type. */
  diff: string;
  /** The root `.gitattributes` as stored at the head commit, or null when there is none. */
  gitAttributes: string | null;
  copies: ChangeCopies;
  /** The check runs, annotations and failed jobs' trimmed logs at the head commit; absent when none were read. */
  ci?: CiResults;
  /** The acceptance criteria of the linked issues; absent when none were read, such as an offline replay. */
  criteria?: Criteria;
  /** What changed since the reviewer's last look; absent on their first look, or when none was asked for. */
  sinceLastLook?: SinceLastLook;
}

/**
 * Reviews one pull request: fetches its {@link ReviewInput} and reviews it
 * with {@link reviewChange}, with the agent stage when one is given.
 *
 * The description is kept exactly as GitHub stores it, never truncated, and
 * the diff comes from the diff media type so large files keep every line.
 * The copies are downloaded as archives into the per-pull-request cache and
 * reused at the same commits; nothing is checked out and nothing from the
 * pull request runs.
 */
export async function reviewPullRequest(
  url: string,
  options: ReviewOptions,
): Promise<ReviewResult> {
  const meter = options.budget;
  const signal = options.signal;
  const stoppable = signal ? stoppableOptions(options, signal) : options;
  const metered = meter ? meteredOptions(stoppable, meter) : stoppable;
  const input = await fetchChange(url, metered);
  // Cancelled before anything landed, the review has no result to keep.
  signal?.throwIfAborted();
  const reviewed = await reviewChange(input, metered.agentStage);
  const docsBase = signal ? stoppableFetch(options.fetch ?? publicDocsFetch(), signal) : options.fetch;
  // The documentation is no read of the pull request: past a limit, it is refused.
  const docsFetch = meter ? limitedFetch(docsBase ?? publicDocsFetch(), meter) : docsBase;
  const docsOptions = { ...metered, ...(docsFetch ? { fetch: docsFetch } : {}) };
  const agentStage = metered.agentStage;
  const result = agentStage
    ? await runStage('docLinks', reviewed, agentStage, (shown, told) => docLinksStage(shown, { ...docsOptions, agentStage: told }))
    : await docLinksStage(reviewed, docsOptions);
  return meter ? withBudget(result, meter) : result;
}

/**
 * The options with the reviewer's cancel wired in: around the fetch, so a
 * download stops, and into every agent run's settings, so the run going
 * stops and none starts.
 */
function stoppableOptions(options: ReviewOptions, signal: AbortSignal): ReviewOptions {
  const agentStage = options.agentStage;
  return {
    ...options,
    fetch: stoppableFetch(options.fetch ?? fetch, signal),
    ...(agentStage ? { agentStage: { ...agentStage, settings: { ...(agentStage.settings ?? DEFAULT_AGENT_SETTINGS), signal } } } : {}),
  };
}

/** A fetch whose every request stops when the review is cancelled. */
function stoppableFetch(fetchImpl: typeof fetch, signal: AbortSignal): typeof fetch {
  return (input, init) => fetchImpl(input, { ...init, signal });
}

/**
 * The options with the review's meter wired in: around the fetch, which
 * counts the review's own reads and refuses none, into every agent run's
 * settings, which stop at the agent-run limit, and onto each stage's
 * result so far.
 */
function meteredOptions(options: ReviewOptions, meter: BudgetMeter): ReviewOptions {
  const agentStage = options.agentStage;
  const onStage = agentStage?.onStage;
  return {
    ...options,
    fetch: meteredFetch(options.fetch ?? fetch, meter),
    ...(agentStage
      ? {
          agentStage: {
            ...agentStage,
            settings: { ...(agentStage.settings ?? DEFAULT_AGENT_SETTINGS), budget: meter, stopAtBudget: true },
            ...(onStage ? { onStage: (stage: ReviewStage) => onStage({ ...stage, result: withBudget(stage.result, meter) }) } : {}),
          },
        }
      : {}),
  };
}

/**
 * The documentation links stage, after the review: the library APIs the
 * change uses, linked to their documentation at the pinned version from
 * the libraries' published inventories, which the engine downloads, and
 * then, with an agent stage, the agent's suggestions for the rest,
 * labelled as such. A change with no parts uses no library.
 */
async function docLinksStage(shown: ReviewResult, options: ReviewOptions): Promise<ReviewResult> {
  if (shown.parts.length === 0) return shown;
  const agentStage = options.agentStage;
  const settings = agentStage?.settings ?? DEFAULT_AGENT_SETTINGS;
  const docLinks = await findDocLinks(shown.parts, {
    headRoot: shown.copies.head.path,
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(agentStage ? { agent: { adapter: agentStage.adapter, settings } } : {}),
    onSuggesting: () =>
      agentStage?.onStage?.({
        running: `suggesting documentation links with ${agentStage.adapter.agent}`,
        timeoutMs: agentStageTimeoutMs(settings),
        result: shown,
      }),
  });
  return { ...shown, docLinks };
}

/**
 * Fetches what a review reads: the pull request's metadata and full diff,
 * the repository's linguist attributes at the head commit (with no
 * checkout), read-only copies of the base and head versions, the CI at
 * the head commit — each failed job's log trimmed to its failing step —
 * and the acceptance criteria of the issues the pull request links,
 * quoted from the checklist under the configured heading; and, when the
 * reviewer opened the review, what changed since their last look.
 */
export async function fetchChange(url: string, options: ReviewOptions): Promise<ReviewInput> {
  const ref = parsePullRequestUrl(url);
  if (!ref) {
    throw new Error(
      `not a GitHub pull request URL: ${url}\n` +
        'expected the form https://github.com/{owner}/{repo}/pull/{number}',
    );
  }

  const client = new GitHubClient({ token: options.token, fetch: options.fetch });
  const [{ summary: pullRequest, mergeCommit }, diff] = await Promise.all([
    client.getPullRequest(ref),
    client.getPullRequestDiff(ref),
  ]);
  const gitAttributes = await client.getGitAttributesAt(ref, pullRequest.headSha);
  const mergeBase = await client.getMergeBase(
    ref,
    pullRequest.baseCommit,
    pullRequest.headSha,
  );
  const copy = (commit: string) =>
    ensureCopy({
      cacheDir: options.cacheDir,
      ref,
      commit,
      download: (wanted) => client.downloadTarball(ref, wanted),
    });
  const heading = options.criteriaHeading?.trim();
  const [base, head, ci, criteria, sinceLastLook] = await Promise.all([
    copy(mergeBase),
    copy(pullRequest.headSha),
    readCi(client, ref, pullRequest.headSha, mergeCommit),
    readCriteria(client, ref, pullRequest.base, heading === undefined || heading === '' ? DEFAULT_CRITERIA_HEADING : heading),
    options.lastLook ? lookSinceLastLook({ client, cacheDir: options.cacheDir, ref, pullRequest, diff }) : undefined,
  ]);
  return { pullRequest, diff, gitAttributes, copies: { base, head }, ci, criteria, ...(sinceLastLook ? { sinceLastLook } : {}) };
}

/**
 * The agent stages, grouping, ranking, the story, the unexplained
 * changes, the claims then their verdicts, and the criteria mapping, when
 * a review asks the agent to group and rank the parts, write the story,
 * compare the change with its description and linked issues, list the
 * claims and judge them, and map the acceptance criteria to the change too.
 */
export interface AgentStageOptions {
  adapter: AgentAdapter;
  settings?: AgentSettings;
  /** Hears the result so far as each agent stage starts, with the stage that runs. */
  onStage?: (stage: ReviewStage) => void;
  /** Where the agent ranking is the default; {@link TESTED_RANKINGS} when absent. */
  testedRankings?: readonly TestedRanking[];
  /** Whether the agent writes the story after ranking; true when absent. */
  story?: boolean;
  /** Whether the agent compares the change with its description and linked issues after the story; true when absent. */
  unexplained?: boolean;
  /** Whether the agent lists the claims; true when absent. */
  claims?: boolean;
  /** Whether the agent judges the claims it listed; true when absent. */
  verdicts?: boolean;
  /** Whether the agent maps the acceptance criteria to the change, last; true when absent. */
  criteria?: boolean;
}

/** A stage of the review starting, with the result so far. */
export interface ReviewStage {
  /** The stage now running, in words for the reviewer. */
  running: string;
  /** The stage ends within this many milliseconds. */
  timeoutMs: number;
  /** The result so far: the plain pass's, then the grouping, ranking, story, unexplained changes, claims, verdicts and criteria stages' in turn, its stages saying how each stands. */
  result: ReviewResult;
  /** The stage now running, as the result's stages record it; set on every stage a review announces. */
  stage?: ReviewStageRecord;
}

/** Fails the run unless every changed line belongs to exactly one part. */
function coverageProblems(diff: ParsedDiff, parts: Part[]): string | undefined {
  const coverage = validateCoverage(diff, parts);
  if (coverage.ok) return undefined;
  return coverage.problems.map((problem) => `${problem.file}: ${problem.description}`).join('; ');
}

/**
 * Reviews a fetched change offline: parses the diff into files and hunks,
 * runs the syntax pass on every file, labels the noise in every file with
 * its state and blind spot, runs the parse-only lock file checks against
 * both versions' copies, groups the hunks into parts named after the
 * entities they touch, proves every changed line belongs to exactly one
 * part, sets each part's signals, ranks the parts with the noise last,
 * reads the pipeline report in the description, carries the CI it was
 * given, and returns the typed, versioned result.
 *
 * With an agent stage, the plain result goes to `onStage` first, then the
 * agent groups related hunks across files and its checked parts are
 * signalled and ranked the same way. When its answer is missing or
 * invalid, or its parts fail the coverage check, the plain grouping stays
 * and the result says why. The parts shown then go to `onStage` again
 * while the agent ranks them, see {@link rankStage}, once more while it
 * writes their story, see {@link storyStage}, while it compares the
 * change with its description and linked issues, see
 * {@link unexplainedStage}, while it lists the claims the change makes,
 * see {@link claimsStage}, while it judges them, see
 * {@link verdictsStage}, and last while it maps the acceptance criteria
 * to the change, see {@link criteriaStage}. With an agent stage, the
 * result's stages record each stage's position, start time, duration,
 * agent and outcome, see {@link runStage}.
 */
export async function reviewChange(
  input: ReviewInput,
  agentStage?: AgentStageOptions,
): Promise<ReviewResult> {
  const startedAt = new Date();
  const { base, head } = input.copies;
  const parsed = parseDiff(input.diff);
  const [{ parseTimeMs }, lockfileNoise] = await Promise.all([
    analyseParts(parsed.files, { base: base.path, head: head.path }),
    confirmLockfileNoise(parsed.files, { base: base.path, head: head.path }),
  ]);

  const files = applyNoiseRules(parsed.files, input.gitAttributes, lockfileNoise);
  const parts = groupParts(files);
  const problems = coverageProblems(parsed, parts);
  if (problems) throw new Error(`diff coverage check failed: ${problems}`);

  const plain: ReviewResult = {
    version: REVIEW_RESULT_VERSION,
    pullRequest: input.pullRequest,
    copies: input.copies,
    parseTimeMs,
    parts: rankParts(await signalParts(parts, head.path)),
    grouping: { by: 'plain' },
    ranking: { by: 'plain' },
    ...(input.criteria ? { criteria: input.criteria } : {}),
    pipeline: readPipelineReport(input.pullRequest.description, input.pullRequest.headSha),
    ...(input.ci ? { ci: input.ci } : {}),
    ...(input.sinceLastLook ? { sinceLastLook: input.sinceLastLook } : {}),
  };
  if (!agentStage) return plain;
  const stages: [Exclude<ReviewStageId, 'plain' | 'docLinks'>, StageRun | false][] = [
    ['grouping', (shown, told) => groupStage(shown, told, input, parsed, files)],
    ['ranking', (shown, told) => rankStage(shown, told, input)],
    ['story', agentStage.story !== false && ((shown, told) => storyStage(shown, told, input))],
    ['unexplained', agentStage.unexplained !== false && ((shown, told) => unexplainedStage(shown, told, input))],
    ['claims', agentStage.claims !== false && ((shown, told) => claimsStage(shown, told, input))],
    ['verdicts', agentStage.claims !== false && agentStage.verdicts !== false && ((shown, told) => verdictsStage(shown, told, input))],
    ['criteria', agentStage.criteria !== false && ((shown, told) => criteriaStage(shown, told, input))],
  ];
  let shown: ReviewResult = { ...plain, stages: plainStages(startedAt) };
  for (const [id, run] of stages) shown = await runStage(id, shown, agentStage, run);
  return shown;
}

/** One stage's work: the result so far in, the result with the stage's own out, announced through the agent stage it is given. */
type StageRun = (shown: ReviewResult, agentStage: AgentStageOptions) => Promise<ReviewResult>;

/** Why a stage is marked stopped. */
const STOPPED = 'the review was stopped before this stage finished';

/** The review's stages once the plain pass, started at `startedAt`, is done: every other stage to come. */
function plainStages(startedAt: Date): ReviewStageRecord[] {
  const total = REVIEW_STAGE_IDS.length;
  return REVIEW_STAGE_IDS.map((id, index): ReviewStageRecord =>
    id === 'plain'
      ? { id, position: 1, total, state: 'done', startedAt: startedAt.toISOString(), durationMs: Date.now() - startedAt.getTime() }
      : { id, position: index + 1, total, state: 'to come' },
  );
}

/** The result with one stage's record changed: its id and place kept, everything else from `record`. */
function withStage(result: ReviewResult, id: ReviewStageId, record: Omit<ReviewStageRecord, 'id' | 'position' | 'total'>): ReviewResult {
  const stages = (result.stages ?? []).map((stage) =>
    stage.id === id ? { id, position: stage.position, total: stage.total, ...record } : stage,
  );
  return { ...result, stages };
}

/**
 * The pass each stage leaves on the result, which says how it ended:
 * absent when the stage asked no agent and had nothing to do.
 */
const STAGE_PASSES: Record<
  Exclude<ReviewStageId, 'plain'>,
  (result: ReviewResult) => { outcome: string; detail?: string; stamp?: AgentStamp } | undefined
> = {
  grouping: (result) => result.grouping.agent,
  ranking: (result) => result.ranking.agent,
  story: (result) => result.story,
  unexplained: (result) => result.unexplained,
  claims: (result) => result.claims,
  verdicts: (result) => result.claims?.judging,
  criteria: (result) => result.criteria?.mapping,
  docLinks: (result) => result.docLinks && (result.docLinks.suggestions ?? { outcome: 'linked' }),
};

/** How a finished stage ended, read from the pass it left on the result. */
function stageOutcome(id: Exclude<ReviewStageId, 'plain'>, result: ReviewResult): Pick<ReviewStageRecord, 'state' | 'detail' | 'stamp'> {
  const pass = STAGE_PASSES[id](result);
  if (pass === undefined) return { state: 'skipped', detail: 'this change gave it nothing to do' };
  const said = { ...(pass.detail !== undefined ? { detail: pass.detail } : {}), ...(pass.stamp ? { stamp: pass.stamp } : {}) };
  if (pass.outcome === 'not compared') return { state: 'skipped', ...said };
  if (pass.outcome === 'fell back' || pass.outcome === 'not tested') return { state: 'fell back', ...said };
  return { state: 'done', ...(pass.stamp ? { stamp: pass.stamp } : {}) };
}

/** The work's result, or undefined as soon as the review is cancelled, whatever the work is still doing. */
function untilStopped<T>(work: Promise<T>, signal: AbortSignal | undefined): Promise<T | undefined> {
  if (signal === undefined) return work;
  return new Promise<T | undefined>((resolve, reject) => {
    const stop = (): void => resolve(undefined);
    signal.addEventListener('abort', stop, { once: true });
    if (signal.aborted) stop();
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', stop));
  });
}

/**
 * Runs one stage of the review and records it on the result: running,
 * with its start time and the agent, model and effort asked for, on every
 * update the stage announces; then, with its duration, done, fell back
 * or skipped with the reason its pass gives and its stamp, or failed with
 * the error, keeping the result so far. A stage the review was cancelled
 * before, or during, is marked stopped, and what it would have added is
 * dropped; a stage the review was not asked to run is skipped.
 */
async function runStage(
  id: Exclude<ReviewStageId, 'plain'>,
  shown: ReviewResult,
  agentStage: AgentStageOptions,
  run: StageRun | false,
): Promise<ReviewResult> {
  const signal = agentStage.settings?.signal;
  if (signal?.aborted) return withStage(shown, id, { state: 'stopped', detail: STOPPED });
  if (run === false) return withStage(shown, id, { state: 'skipped', detail: 'the review was asked not to run it' });
  const settings = agentStage.settings ?? DEFAULT_AGENT_SETTINGS;
  const startedAt = new Date();
  const started = {
    startedAt: startedAt.toISOString(),
    agent: { agent: agentStage.adapter.agent, model: settings.model ?? null, effort: settings.effort ?? null },
  };
  const running = withStage(shown, id, { state: 'running', ...started });
  const stage = running.stages!.find((record) => record.id === id)!;
  const onStage = agentStage.onStage;
  // A stage cancelled mid-way announces nothing more, so no update follows the review's answer.
  const told: AgentStageOptions = {
    ...agentStage,
    ...(onStage ? { onStage: (update: ReviewStage) => (signal?.aborted ? undefined : onStage({ ...update, stage })) } : {}),
  };
  const ended = (result: ReviewResult, record: Pick<ReviewStageRecord, 'state' | 'detail' | 'stamp'>): ReviewResult =>
    withStage(result, id, { ...record, ...started, durationMs: Date.now() - startedAt.getTime() });
  try {
    const result = await untilStopped(run(running, told), signal);
    if (result === undefined || signal?.aborted) return ended(shown, { state: 'stopped', detail: STOPPED });
    return ended(result, stageOutcome(id, result));
  } catch (error) {
    if (signal?.aborted) return ended(shown, { state: 'stopped', detail: STOPPED });
    return ended(shown, { state: 'failed', detail: error instanceof Error ? error.message : String(error) });
  }
}

/**
 * The agent grouping stage: the agent's parts when they pass the coverage
 * check, else the plain ones with the reason they stayed.
 */
async function groupStage(
  plain: ReviewResult,
  agentStage: AgentStageOptions,
  input: ReviewInput,
  parsed: ParsedDiff,
  files: Part[],
): Promise<ReviewResult> {
  const { head } = input.copies;
  if (groupingItems(files).length < 2) return plain;

  const settings = agentStage.settings ?? DEFAULT_AGENT_SETTINGS;
  agentStage.onStage?.({
    running: `grouping related hunks with ${agentStage.adapter.agent}`,
    timeoutMs: agentStageTimeoutMs(settings),
    result: plain,
  });
  const { parts: grouped, grouping } = await groupWithAgent(files, {
    adapter: agentStage.adapter,
    settings,
    root: head.path,
    pullRequest: input.pullRequest,
  });
  if (!grouped) return { ...plain, grouping: { by: 'plain', agent: grouping } };
  const uncovered = coverageProblems(parsed, grouped);
  if (uncovered) {
    const detail = `the agent's parts failed the coverage check: ${uncovered}`;
    return { ...plain, grouping: { by: 'plain', agent: { ...grouping, outcome: 'fell back', detail } } };
  }
  return {
    ...plain,
    parts: rankParts(await signalParts(grouped, head.path)),
    grouping: { by: 'agent', agent: grouping },
  };
}

/**
 * The agent ranking stage, after grouping: the agent ranks the parts the
 * result shows. Fewer than two parts to rank need no agent. The agent
 * ranking replaces the plain one only when the validator accepts it and
 * the agent, model and effort are among the tested rankings; an agent
 * with no tested model, or a model or effort asked for that is not one,
 * is not asked. Otherwise the plain ranking stays and the result says why.
 */
async function rankStage(
  shown: ReviewResult,
  agentStage: AgentStageOptions,
  input: ReviewInput,
): Promise<ReviewResult> {
  if (rankingItems(shown.parts).length < 2) return shown;
  const settings = agentStage.settings ?? DEFAULT_AGENT_SETTINGS;
  const { agent } = agentStage.adapter;
  const tested = agentStage.testedRankings ?? TESTED_RANKINGS;
  if (!mayBeTestedRanking(tested, agent, settings.model, settings.effort)) {
    const detail = notTestedDetail(agent, settings.model, settings.effort);
    return { ...shown, ranking: { by: 'plain', agent: { promptVersion: RANKING_PROMPT_VERSION, outcome: 'not tested', detail } } };
  }
  agentStage.onStage?.({
    running: `ranking the parts with ${agent}`,
    timeoutMs: agentStageTimeoutMs(settings),
    result: shown,
  });
  const { parts: ranked, ranking } = await rankWithAgent(shown.parts, {
    adapter: agentStage.adapter,
    settings,
    root: input.copies.head.path,
    pullRequest: input.pullRequest,
  });
  if (!ranked) return { ...shown, ranking: { by: 'plain', agent: ranking } };
  if (!isTestedRanking(tested, ranking.stamp!.agent, ranking.stamp!.model, ranking.stamp!.effort)) {
    const detail = notTestedDetail(ranking.stamp!.agent, ranking.stamp!.model, ranking.stamp!.effort);
    return { ...shown, ranking: { by: 'plain', agent: { ...ranking, outcome: 'not tested', detail } } };
  }
  return { ...shown, parts: ranked, ranking: { by: 'agent', agent: ranking } };
}

/**
 * The story stage: the agent writes the story of the parts the
 * result shows, in their reading order. A change with no parts needs no
 * story. The result carries the story the checks accepted, or says why
 * there is none.
 */
async function storyStage(
  shown: ReviewResult,
  agentStage: AgentStageOptions,
  input: ReviewInput,
): Promise<ReviewResult> {
  if (shown.parts.length === 0) return shown;
  const settings = agentStage.settings ?? DEFAULT_AGENT_SETTINGS;
  agentStage.onStage?.({
    running: `writing the story with ${agentStage.adapter.agent}`,
    timeoutMs: agentStageTimeoutMs(settings),
    result: shown,
  });
  const { story } = await writeStory(shown.parts, {
    adapter: agentStage.adapter,
    settings,
    root: input.copies.head.path,
    pullRequest: input.pullRequest,
  });
  return { ...shown, story };
}

/**
 * The unexplained-changes stage: the agent compares the description and
 * the linked issues with the parts the result shows, in both directions —
 * the parts neither explains, and the changes they describe that the diff
 * does not contain. With neither a description nor a linked issue, no
 * agent is asked and the result says so. A change with no parts needs no
 * comparison.
 */
async function unexplainedStage(
  shown: ReviewResult,
  agentStage: AgentStageOptions,
  input: ReviewInput,
): Promise<ReviewResult> {
  if (shown.parts.length === 0) return shown;
  const settings = agentStage.settings ?? DEFAULT_AGENT_SETTINGS;
  const criteria = input.criteria;
  const issuesDetail =
    criteria === undefined ? 'the review read no linked issue' : criteria.outcome === 'unreadable' ? criteria.detail : undefined;
  const options = {
    adapter: agentStage.adapter,
    settings,
    root: input.copies.head.path,
    pullRequest: input.pullRequest,
    issues: criteria?.issues ?? [],
    ...(issuesDetail === undefined ? {} : { issuesDetail }),
  };
  if (input.pullRequest.description.trim() !== '' || options.issues.length > 0) {
    agentStage.onStage?.({
      running: `comparing the change with its description and issues with ${agentStage.adapter.agent}`,
      timeoutMs: agentStageTimeoutMs(settings),
      result: shown,
    });
  }
  return { ...shown, unexplained: await findUnexplained(shown.parts, options) };
}

/**
 * The claims stage: the agent lists the claims the change makes
 * about how code or a library behaves, from the description, the
 * docstrings and comments the change adds, and the story when one was
 * written, each attached to a part and not checked yet. A fresh pipeline
 * report's open findings come first, whatever the agent answers. A change
 * with no parts makes no claim.
 */
async function claimsStage(
  shown: ReviewResult,
  agentStage: AgentStageOptions,
  input: ReviewInput,
): Promise<ReviewResult> {
  if (shown.parts.length === 0) return shown;
  const settings = agentStage.settings ?? DEFAULT_AGENT_SETTINGS;
  agentStage.onStage?.({
    running: `listing the claims with ${agentStage.adapter.agent}`,
    timeoutMs: agentStageTimeoutMs(settings),
    result: shown,
  });
  const claims = await findClaims(shown.parts, {
    adapter: agentStage.adapter,
    settings,
    root: input.copies.head.path,
    pullRequest: input.pullRequest,
    ...(shown.story ? { story: shown.story } : {}),
  });
  return { ...shown, claims: { ...claims, claims: [...pipelineClaims(shown.pipeline, shown.parts), ...claims.claims] } };
}

/**
 * The verdicts stage, last: the agent judges each claim listed against
 * the change, the read-only head copy and the failed checks' trimmed CI
 * logs, and the engine re-checks every citation it gives; a verdict that
 * needs a library the head copy pins, or for which the agent named a
 * repository and tag, then offers its library fetch, which downloads
 * nothing until the reviewer presses it. No claims need no judging;
 * when the agent's listing fell back, the pipeline's claims are still
 * judged.
 */
async function verdictsStage(
  shown: ReviewResult,
  agentStage: AgentStageOptions,
  input: ReviewInput,
): Promise<ReviewResult> {
  const claims = shown.claims;
  if (claims === undefined || claims.claims.length === 0) return shown;
  const settings = agentStage.settings ?? DEFAULT_AGENT_SETTINGS;
  agentStage.onStage?.({
    running: `checking the claims with ${agentStage.adapter.agent}`,
    timeoutMs: agentStageTimeoutMs(settings),
    result: shown,
  });
  const judged = await judgeClaims(shown.parts, claims.claims, {
    adapter: agentStage.adapter,
    settings,
    root: input.copies.head.path,
    ...(shown.ci ? { ci: shown.ci } : {}),
  });
  const offered = await offerLibraryFetches(judged.claims, input.copies.head.path);
  return { ...shown, claims: { ...claims, ...judged, claims: offered } };
}

/**
 * The criteria stage, last: the agent maps each acceptance criterion read
 * from the linked issues to the change — met, partly met, not met, can't
 * tell or needs manual check — citing the code that implements it and the
 * tests that cover it, which the engine re-reads in the head copy, and
 * quoting the manual checks the description reports, which the engine
 * finds there. No criteria, or a change with no parts, need no mapping.
 */
async function criteriaStage(
  shown: ReviewResult,
  agentStage: AgentStageOptions,
  input: ReviewInput,
): Promise<ReviewResult> {
  const criteria = shown.criteria;
  if (criteria === undefined || criteria.criteria.length === 0 || shown.parts.length === 0) return shown;
  const settings = agentStage.settings ?? DEFAULT_AGENT_SETTINGS;
  agentStage.onStage?.({
    running: `mapping the acceptance criteria with ${agentStage.adapter.agent}`,
    timeoutMs: agentStageTimeoutMs(settings),
    result: shown,
  });
  const mapped = await mapCriteria(shown.parts, criteria, {
    adapter: agentStage.adapter,
    settings,
    root: input.copies.head.path,
    pullRequest: input.pullRequest,
  });
  return { ...shown, criteria: { ...criteria, criteria: mapped.criteria, mapping: mapped.mapping } };
}
