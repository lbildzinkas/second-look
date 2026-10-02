import { ensureCopy } from './cache.js';
import { validateCoverage } from './coverage.js';
import { parseDiff } from './diff.js';
import { GitHubClient, parsePullRequestUrl } from './github.js';
import { applyNoiseRules } from './noise.js';
import { groupParts } from './parts.js';
import { REVIEW_RESULT_VERSION } from './protocol.js';
import type { ReviewResult } from './protocol.js';
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
}

/**
 * Reviews one pull request: fetches its metadata and full diff, parses the
 * diff into files and hunks, takes read-only copies of the base and head
 * versions, runs the syntax pass on every file, labels the noise in every
 * file with its state and blind spot (reading the repository's linguist
 * attributes at the head commit, with no checkout), groups the hunks into
 * parts named after the entities they touch, proves every changed line
 * belongs to exactly one part, sets each part's signals, ranks the parts
 * with the noise last, and returns the typed, versioned result.
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
  const ref = parsePullRequestUrl(url);
  if (!ref) {
    throw new Error(
      `not a GitHub pull request URL: ${url}\n` +
        'expected the form https://github.com/{owner}/{repo}/pull/{number}',
    );
  }

  const client = new GitHubClient({ token: options.token, fetch: options.fetch });
  const [pullRequest, diffText] = await Promise.all([
    client.getPullRequestSummary(ref),
    client.getPullRequestDiff(ref),
  ]);
  const gitAttributes = await client.getGitAttributesAt(ref, pullRequest.headSha);

  const parsed = parseDiff(diffText);
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
  const { parseTimeMs } = await analyseParts(parsed.files, { base: base.path, head: head.path });

  const parts = groupParts(applyNoiseRules(parsed.files, gitAttributes));
  const coverage = validateCoverage(parsed, parts);
  if (!coverage.ok) {
    const details = coverage.problems
      .map((problem) => `${problem.file}: ${problem.description}`)
      .join('; ');
    throw new Error(`diff coverage check failed: ${details}`);
  }

  return {
    version: REVIEW_RESULT_VERSION,
    pullRequest,
    copies: { base, head },
    parseTimeMs,
    parts: rankParts(await signalParts(parts, head.path)),
  };
}
