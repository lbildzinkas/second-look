import { DEFAULT_AGENT_SETTINGS, type AgentAdapter, type AgentSettings } from './agent.js';
import { ensureCopy } from './cache.js';
import { validateCoverage } from './coverage.js';
import { parseDiff, type ParsedDiff } from './diff.js';
import { GitHubClient, parsePullRequestUrl } from './github.js';
import { groupingItems, groupingStageTimeoutMs, groupWithAgent } from './grouping.js';
import { confirmLockfileNoise } from './lockfile.js';
import { applyNoiseRules } from './noise.js';
import { groupParts } from './parts.js';
import { REVIEW_RESULT_VERSION } from './protocol.js';
import type { ChangeCopies, Part, PullRequestSummary, ReviewResult } from './protocol.js';
import { rankParts } from './rank.js';
import { signalParts } from './signals.js';
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
  /** Asks the agent to group the parts too, after the plain pass; see {@link reviewChange}. */
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

/** The agent grouping stage, when a review asks the agent to group the parts too. */
export interface AgentStageOptions {
  adapter: AgentAdapter;
  settings?: AgentSettings;
  /** Hears the plain result as soon as it is ready, with the stage that runs next. */
  onStage?: (stage: ReviewStage) => void;
}

/** A stage of the review starting, with the result so far. */
export interface ReviewStage {
  /** The stage now running, in words for the reviewer. */
  running: string;
  /** The stage ends within this many milliseconds. */
  timeoutMs: number;
  /** The result so far: the plain pass's. */
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
 * and the result says why.
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
  };
  if (!agentStage || groupingItems(files).length < 2) return plain;

  const settings = agentStage.settings ?? DEFAULT_AGENT_SETTINGS;
  agentStage.onStage?.({
    running: `grouping related hunks with ${agentStage.adapter.agent}`,
    timeoutMs: groupingStageTimeoutMs(settings),
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
