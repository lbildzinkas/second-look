import {
  DEFAULT_AGENT_SETTINGS,
  agentStageTimeoutMs,
  type AgentAdapter,
  type AgentSettings,
} from './agent.js';
import { ensureCopy } from './cache.js';
import { findClaims } from './claims.js';
import { validateCoverage } from './coverage.js';
import { parseDiff, type ParsedDiff } from './diff.js';
import { GitHubClient, parsePullRequestUrl } from './github.js';
import { groupingItems, groupWithAgent } from './grouping.js';
import { confirmLockfileNoise } from './lockfile.js';
import { applyNoiseRules } from './noise.js';
import { groupParts } from './parts.js';
import { REVIEW_RESULT_VERSION } from './protocol.js';
import type { ChangeCopies, Part, PullRequestSummary, ReviewResult } from './protocol.js';
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
  /** Asks the agent to group and rank the parts, write the story and list the claims too, after the plain pass; see {@link reviewChange}. */
  agentStage?: AgentStageOptions;
}

/**
 * Everything a review reads about one pull request, fetched once: the
 * metadata, the full diff, the root `.gitattributes` at the head commit,
 * and the read-only copies of both versions. A review of it touches no
 * network, so an evaluation case can replay a recorded one offline.
 */
export interface ReviewInput {
  pullRequest: PullRequestSummary;
  /** The full diff, from the diff media type. */
  diff: string;
  /** The root `.gitattributes` as stored at the head commit, or null when there is none. */
  gitAttributes: string | null;
  copies: ChangeCopies;
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
  return reviewChange(await fetchChange(url, options), options.agentStage);
}

/**
 * Fetches what a review reads: the pull request's metadata and full diff,
 * the repository's linguist attributes at the head commit (with no
 * checkout), and read-only copies of the base and head versions.
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
  const [pullRequest, diff] = await Promise.all([
    client.getPullRequestSummary(ref),
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
  const [base, head] = await Promise.all([copy(mergeBase), copy(pullRequest.headSha)]);
  return { pullRequest, diff, gitAttributes, copies: { base, head } };
}

/**
 * The agent stages, grouping, ranking, the story then the claims, when a
 * review asks the agent to group and rank the parts, write the story and
 * list the claims too.
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
  /** Whether the agent lists the claims last; true when absent. */
  claims?: boolean;
}

/** A stage of the review starting, with the result so far. */
export interface ReviewStage {
  /** The stage now running, in words for the reviewer. */
  running: string;
  /** The stage ends within this many milliseconds. */
  timeoutMs: number;
  /** The result so far: the plain pass's, then the grouping, ranking and story stages' in turn. */
  result: ReviewResult;
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
 * part, sets each part's signals, ranks the parts with the noise last, and
 * returns the typed, versioned result.
 *
 * With an agent stage, the plain result goes to `onStage` first, then the
 * agent groups related hunks across files and its checked parts are
 * signalled and ranked the same way. When its answer is missing or
 * invalid, or its parts fail the coverage check, the plain grouping stays
 * and the result says why. The parts shown then go to `onStage` again
 * while the agent ranks them, see {@link rankStage}, once more while it
 * writes their story, see {@link storyStage}, and last while it lists
 * the claims the change makes, see {@link claimsStage}.
 */
export async function reviewChange(
  input: ReviewInput,
  agentStage?: AgentStageOptions,
): Promise<ReviewResult> {
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
  };
  if (!agentStage) return plain;
  const ranked = await groupAndRank(plain, agentStage, input, parsed, files);
  const told = agentStage.story === false ? ranked : await storyStage(ranked, agentStage, input);
  return agentStage.claims === false ? told : claimsStage(told, agentStage, input);
}

/**
 * The agent grouping stage, then the ranking stage on whichever parts it
 * leaves shown: the agent's when they pass the coverage check, else the
 * plain ones with the reason they stayed.
 */
async function groupAndRank(
  plain: ReviewResult,
  agentStage: AgentStageOptions,
  input: ReviewInput,
  parsed: ParsedDiff,
  files: Part[],
): Promise<ReviewResult> {
  const { head } = input.copies;
  if (groupingItems(files).length < 2) return rankStage(plain, agentStage, input);

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
  if (!grouped) return rankStage({ ...plain, grouping: { by: 'plain', agent: grouping } }, agentStage, input);
  const uncovered = coverageProblems(parsed, grouped);
  if (uncovered) {
    const detail = `the agent's parts failed the coverage check: ${uncovered}`;
    const fellBack: ReviewResult = {
      ...plain,
      grouping: { by: 'plain', agent: { ...grouping, outcome: 'fell back', detail } },
    };
    return rankStage(fellBack, agentStage, input);
  }
  const regrouped: ReviewResult = {
    ...plain,
    parts: rankParts(await signalParts(grouped, head.path)),
    grouping: { by: 'agent', agent: grouping },
  };
  return rankStage(regrouped, agentStage, input);
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
 * The story stage, last: the agent writes the story of the parts the
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
 * The claims stage, last: the agent lists the claims the change makes
 * about how code or a library behaves, from the description, the
 * docstrings and comments the change adds, and the story when one was
 * written, each attached to a part and not checked yet. A change with no
 * parts makes no claim.
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
  return { ...shown, claims };
}
