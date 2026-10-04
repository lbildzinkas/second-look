import { GitHubClient, parsePullRequestUrl } from './github.js';
import { positionComments } from './positions.js';
import type { PendingReview, SentReview } from './protocol.js';

export interface SendOptions {
  /** GitHub token, passed in by the caller; never stored or logged. */
  token: string;
  /**
   * Fetch implementation the GitHub client uses. Tests inject a
   * fixture-backed fetch here so no test ever touches the network.
   */
  fetch?: typeof fetch;
}

/**
 * Sends the pending review to GitHub as one review (ADR 0002): the only
 * moment anything of the review reaches GitHub, in one write.
 *
 * The pull request's metadata and full diff are fetched fresh, so the
 * comments are mapped against the diff as GitHub holds it right now and
 * the review is pinned to the head commit that diff was taken at — a pull
 * request that moved underneath the reviewer fails the send plainly, and
 * the companion keeps every comment for them to send again.
 */
export async function sendReview(
  url: string,
  review: PendingReview,
  options: SendOptions,
): Promise<SentReview> {
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
  return client.submitReview(ref, {
    commitId: pullRequest.headSha,
    submit: review.submit,
    ...(review.body !== undefined ? { body: review.body } : {}),
    comments: positionComments(diff, review.comments),
  });
}
