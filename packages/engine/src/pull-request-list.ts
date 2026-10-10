import { GitHubClient, SEARCH_TIMEOUT_MS, parsePullRequestUrl } from './github.js';
import { readLooks } from './last-look.js';
import {
  PULL_REQUEST_SUMMARY_LENGTH,
  type ListedPullRequest,
  type PullRequestGroup,
  type PullRequestGroupKind,
  type PullRequestList,
} from './protocol.js';
import { redactToken } from './rpc.js';
import { hiddenContent } from './untrusted.js';

/** What listing the reviewer's pull requests needs. */
export interface ListPullRequestsOptions {
  /** The GitHub token from the reviewer's sign-in; absent or empty when they are not signed in. */
  token?: string;
  /** The open folder's GitHub repository as `owner/name`, when it is one; absent lists no "this repository" group. */
  repository?: string;
  /** The engine's cache folder, which holds the last-look records. */
  cacheDir: string;
  /** Fetch implementation the searches use; tests inject recorded answers. */
  fetch?: typeof fetch;
}

/** A repository as `owner/name`, with no room for another search qualifier. */
const REPOSITORY_NAME = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/** True when the value names a GitHub repository as `owner/name`. */
export function isRepositoryName(value: unknown): value is string {
  return typeof value === 'string' && REPOSITORY_NAME.test(value);
}

/** The reason the list gives when the reviewer is not signed in. */
export const SIGNED_OUT_REASON = 'Not signed in to GitHub: sign in to list your pull requests.';

/** The reason the list gives when GitHub refuses the sign-in's token. */
export const SIGN_IN_REFUSED_REASON = 'GitHub did not accept your sign-in: sign in to GitHub again to list your pull requests.';

/**
 * Lists the reviewer's open pull requests with their GitHub sign-in: one
 * search per group — review requested from them, theirs, involving them,
 * and open in the open folder's repository when it is a GitHub one — each
 * pull request in its first group only. The review-requested group lists
 * the one kept waiting longest first; the others list the most recently
 * updated first. Each pull request's new-commits flag comes from the
 * engine's last-look record, which the list only reads: nothing is
 * stored. With no sign-in, a token GitHub refuses, or GitHub out of
 * reach, the list answers with the reason in plain words; any other
 * failure throws.
 */
export async function listPullRequests(options: ListPullRequestsOptions): Promise<PullRequestList> {
  const { token } = options;
  if (token === undefined || token === '') return { outcome: 'signed out', reason: SIGNED_OUT_REASON };
  const client = new GitHubClient({ token, ...(options.fetch ? { fetch: options.fetch } : {}) });
  const searches = groupSearches(options.repository);
  let answers: Awaited<ReturnType<GitHubClient['searchPullRequests']>>[];
  try {
    answers = await Promise.all(searches.map(({ group, search }) => client.searchPullRequests(search, group === 'review requested')));
  } catch (error) {
    const unavailable = unavailableList(error, token);
    if (unavailable === undefined) throw error;
    return unavailable;
  }
  const listed = new Set<string>();
  const groups: PullRequestGroup[] = [];
  for (const [index, { group }] of searches.entries()) {
    const { viewer, nodes } = answers[index]!;
    const pullRequests: ListedPullRequest[] = [];
    for (const node of nodes) {
      const found = searchedPullRequest(node);
      if (found === undefined || listed.has(found.url)) continue;
      listed.add(found.url);
      pullRequests.push(await listedPullRequest(found, group, viewer, options.cacheDir));
    }
    groups.push({ group, pullRequests: group === 'review requested' ? longestWaitingFirst(pullRequests) : pullRequests });
  }
  return { outcome: 'listed', groups };
}

/** The search each group runs, in the groups' order; open pull requests in live repositories only, most recently updated first. */
function groupSearches(repository: string | undefined): { group: PullRequestGroupKind; search: string }[] {
  const open = 'is:pr is:open archived:false sort:updated-desc';
  return [
    { group: 'review requested', search: `${open} review-requested:@me` },
    { group: 'yours', search: `${open} author:@me` },
    { group: 'involving you', search: `${open} involves:@me` },
    ...(repository === undefined ? [] : [{ group: 'this repository' as const, search: `${open} repo:${repository}` }]),
  ];
}

/**
 * The list a failed search leaves: signed out when GitHub refused the
 * token, unreachable when no answer came — the connection failed or
 * GitHub did not answer in time; undefined when GitHub answered with
 * another failure.
 */
function unavailableList(error: unknown, token: string): PullRequestList | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const { status, response, cause, name, message } = error as { status?: unknown; response?: unknown; cause?: unknown; name?: unknown; message?: unknown };
  if (status === 401) return { outcome: 'signed out', reason: SIGN_IN_REFUSED_REASON };
  const timedOut = name === 'TimeoutError' || (cause as { name?: unknown } | undefined)?.name === 'TimeoutError';
  if (timedOut) {
    return { outcome: 'unreachable', reason: `GitHub could not be reached: it did not answer within ${SEARCH_TIMEOUT_MS / 1000} seconds.` };
  }
  // The client reports a request that got no answer as status 500 with no response.
  if (status !== 500 || response !== undefined) return undefined;
  const detail = typeof message === 'string' && message !== '' ? ` (${redactToken(message, token)})` : '';
  return { outcome: 'unreachable', reason: `GitHub could not be reached${detail}: check the connection and try again.` };
}

/** One pull request a search found, with what the list reads of it. */
interface SearchedPullRequest {
  url: string;
  repository: string;
  number: number;
  title: string;
  author: string;
  body: string;
  createdAt: string;
  updatedAt: string;
  draft: boolean;
  additions: number;
  deletions: number;
  files: number;
  head: string;
  /** Each reviewer's latest opinion, as GitHub names its state. */
  opinions: string[];
  /** The review requests the timeline shows, oldest first. */
  requests: { at: string; reviewer: { kind: string; login?: string } }[];
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : 0;
}

function nodes(value: unknown): Record<string, unknown>[] {
  const list = record(value)['nodes'];
  return Array.isArray(list) ? list.map(record) : [];
}

/** A search answer's node read defensively; undefined when it is no pull request the list can name. */
function searchedPullRequest(node: unknown): SearchedPullRequest | undefined {
  const value = record(node);
  const url = value['url'];
  const repository = record(value['repository'])['nameWithOwner'];
  const number = value['number'];
  if (typeof url !== 'string' || typeof repository !== 'string' || typeof number !== 'number' || typeof value['title'] !== 'string') return undefined;
  return {
    url,
    repository,
    number,
    title: value['title'],
    author: text(record(value['author'])['login']),
    body: text(value['body']),
    createdAt: text(value['createdAt']),
    updatedAt: text(value['updatedAt']),
    draft: value['isDraft'] === true,
    additions: count(value['additions']),
    deletions: count(value['deletions']),
    files: count(value['changedFiles']),
    head: text(value['headRefOid']),
    opinions: nodes(value['latestOpinionatedReviews']).map((review) => text(review['state'])),
    requests: nodes(value['timelineItems']).map((event) => {
      const reviewer = record(event['requestedReviewer']);
      const login = reviewer['login'];
      return { at: text(event['createdAt']), reviewer: { kind: text(reviewer['__typename']), ...(typeof login === 'string' ? { login } : {}) } };
    }),
  };
}

async function listedPullRequest(found: SearchedPullRequest, group: PullRequestGroupKind, viewer: string, cacheDir: string): Promise<ListedPullRequest> {
  const requested = group === 'review requested';
  return {
    url: found.url,
    repository: found.repository,
    number: found.number,
    title: found.title,
    author: found.author,
    updatedAt: found.updatedAt,
    summary: pullRequestSummary(found.body),
    review: {
      requested,
      approvals: found.opinions.filter((state) => state === 'APPROVED').length,
      changesRequested: found.opinions.filter((state) => state === 'CHANGES_REQUESTED').length,
      draft: found.draft,
    },
    size: { additions: found.additions, deletions: found.deletions, files: found.files },
    newCommitsSinceLastLook: await newCommitsSinceLastLook(cacheDir, found.url, found.head),
    ...(requested ? { waitingSince: waitingSince(found, viewer) } : {}),
  };
}

/**
 * Since when the reviewer has kept a pull request waiting: the latest
 * request of their review by name, else the latest through a team, else
 * the pull request's creation.
 */
function waitingSince(found: SearchedPullRequest, viewer: string): string {
  const byName = found.requests.filter(({ reviewer }) => reviewer.kind === 'User' && reviewer.login === viewer);
  const byTeam = found.requests.filter(({ reviewer }) => reviewer.kind === 'Team');
  return (byName.at(-1) ?? byTeam.at(-1))?.at ?? found.createdAt;
}

/** The pull requests kept waiting longest first; equal waits keep the search's order. */
function longestWaitingFirst(pullRequests: ListedPullRequest[]): ListedPullRequest[] {
  const since = (pullRequest: ListedPullRequest): number => Date.parse(pullRequest.waitingSince ?? '') || Number.POSITIVE_INFINITY;
  return [...pullRequests].sort((a, b) => since(a) - since(b) || 0);
}

/** True when the last-look record holds a look at another head commit than the pull request's now. */
async function newCommitsSinceLastLook(cacheDir: string, url: string, head: string): Promise<boolean> {
  const ref = parsePullRequestUrl(url);
  if (ref === null || head === '') return false;
  const looks = await readLooks(cacheDir, ref);
  return looks !== null && looks.last.commit !== head;
}

/** Control characters other than line breaks and tabs, which no reader sees as text. */
const CONTROL_CHARACTERS = /(?![\n\r\t])\p{Cc}/gu;

/** A Markdown heading line. */
const HEADING = /^#{1,6}(?:\s|$)/;

/**
 * The start of a pull request's description as the list shows it: the
 * text a reader sees on GitHub — hidden HTML comments and invisible
 * characters left out — as its first two lines of text, headings and
 * blank lines skipped, joined and cut to
 * {@link PULL_REQUEST_SUMMARY_LENGTH} characters.
 */
export function pullRequestSummary(body: string): string {
  const shown = hiddenContent(body)
    .filter((piece) => piece.hidden === undefined)
    .map((piece) => piece.text)
    .join('')
    .replace(CONTROL_CHARACTERS, '');
  const lines = shown
    .split(/\r\n|\r|\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '' && !HEADING.test(line))
    .slice(0, 2);
  const characters = [...lines.join(' ')];
  if (characters.length <= PULL_REQUEST_SUMMARY_LENGTH) return characters.join('');
  return `${characters.slice(0, PULL_REQUEST_SUMMARY_LENGTH - 1).join('').trimEnd()}…`;
}
