import { validateCoverage } from './coverage.js';
import { parseDiff } from './diff.js';
import { GitHubClient, parsePullRequestUrl } from './github.js';
import { REVIEW_RESULT_VERSION } from './protocol.js';
import type { ReviewResult } from './protocol.js';

export interface ReviewOptions {
  /** GitHub token, passed in by the caller; never stored or logged. */
  token: string;
  /**
   * Fetch implementation the GitHub client uses. Tests inject a
   * fixture-backed fetch here so no test ever touches the network.
   */
  fetch?: typeof fetch;
}

/**
 * Reviews one pull request: fetches its metadata and full diff, parses the
 * diff into files and hunks, proves every changed line belongs to exactly
 * one part, and returns the typed, versioned result.
 *
 * The description is kept exactly as GitHub stores it, never truncated, and
 * the diff comes from the diff media type so large files keep every line.
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

  const parsed = parseDiff(diffText);
  const coverage = validateCoverage(parsed, parsed.files);
  if (!coverage.ok) {
    const details = coverage.problems
      .map((problem) => `${problem.file}: ${problem.description}`)
      .join('; ');
    throw new Error(`diff coverage check failed: ${details}`);
  }

  return {
    version: REVIEW_RESULT_VERSION,
    pullRequest,
    parts: parsed.files,
  };
}
