import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { removeCopy } from '../src/cache.js';
import { SEARCH_TIMEOUT_MS } from '../src/github.js';
import { recordLook } from '../src/last-look.js';
import { PULL_REQUEST_SUMMARY_LENGTH, type ListedPullRequest, type PullRequestList } from '../src/protocol.js';
import { SIGNED_OUT_REASON, SIGN_IN_REFUSED_REASON, isRepositoryName, listPullRequests, pullRequestSummary } from '../src/pull-request-list.js';
import { failingFetch, temporaryCacheDir } from './helpers.js';

const TOKEN = 'ghp_test-token-do-not-print';
const GRAPHQL_URL = 'https://api.github.com/graphql';

/** The recorded answer each group's search is served, by the qualifier that names the group. */
const RECORDED: Record<string, string> = {
  'review-requested:@me': 'review-requested.json',
  'author:@me': 'yours.json',
  'involves:@me': 'involving.json',
  'repo:example-org/example-repo': 'this-repository.json',
};

function recorded(name: string): unknown {
  return JSON.parse(readFileSync(fileURLToPath(new URL(`./fixtures/pull-requests/${name}`, import.meta.url)), 'utf8'));
}

/** One search the fake GitHub served: its query string, whether it asked for the review requests, and the token it carried. */
interface Search {
  search: string;
  waiting: boolean;
  authorization: string | null;
}

/**
 * A fetch that serves each group's search its recorded GraphQL answer,
 * picked by the search's qualifier. Any other request throws, so no test
 * reaches the network.
 */
function searchFetch(): { fetch: typeof fetch; searches: Search[] } {
  const searches: Search[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url !== GRAPHQL_URL || init?.method !== 'POST') throw new Error(`unexpected request to ${url}: tests run against recorded responses only`);
    const { variables } = JSON.parse(String(init.body)) as { variables: { search: string; waiting: boolean } };
    searches.push({ search: variables.search, waiting: variables.waiting, authorization: new Headers(init.headers).get('authorization') });
    const qualifier = Object.keys(RECORDED).find((each) => variables.search.split(' ').includes(each));
    if (qualifier === undefined) throw new Error(`no recorded answer for the search ${variables.search}`);
    return Response.json(recorded(RECORDED[qualifier]!));
  };
  return { fetch: fetchImpl, searches };
}

function listed(list: PullRequestList): { group: string; urls: string[] }[] {
  if (list.outcome !== 'listed') throw new Error(`expected a list, got ${list.outcome}: ${list.reason}`);
  return list.groups.map(({ group, pullRequests }) => ({ group, urls: pullRequests.map(({ url }) => url) }));
}

function pullRequest(list: PullRequestList, url: string): ListedPullRequest {
  if (list.outcome !== 'listed') throw new Error(`expected a list, got ${list.outcome}`);
  const found = list.groups.flatMap(({ pullRequests }) => pullRequests).find((each) => each.url === url);
  if (found === undefined) throw new Error(`${url} is not listed`);
  return found;
}

let cacheDir: string;

beforeEach(() => {
  cacheDir = temporaryCacheDir();
});

afterEach(async () => {
  await removeCopy(cacheDir);
});

describe('listPullRequests', () => {
  it('lists the groups in order from one search per group, each pull request once, in its first group', async () => {
    const github = searchFetch();

    const list = await listPullRequests({ token: TOKEN, repository: 'example-org/example-repo', cacheDir, fetch: github.fetch });

    expect(listed(list)).toEqual([
      {
        group: 'review requested',
        urls: [
          'https://github.com/example-org/auth/pull/62',
          'https://github.com/example-org/payments/pull/412',
          'https://github.com/example-org/example-repo/pull/42',
        ],
      },
      { group: 'yours', urls: ['https://github.com/example-org/example-repo/pull/7'] },
      { group: 'involving you', urls: ['https://github.com/example-org/example-repo/pull/8'] },
      { group: 'this repository', urls: ['https://github.com/example-org/example-repo/pull/9'] },
    ]);
    const open = 'is:pr is:open archived:false sort:updated-desc';
    expect(github.searches.map(({ search, waiting }) => ({ search, waiting })).sort((a, b) => a.search.localeCompare(b.search))).toEqual([
      { search: `${open} author:@me`, waiting: false },
      { search: `${open} involves:@me`, waiting: false },
      { search: `${open} repo:example-org/example-repo`, waiting: false },
      { search: `${open} review-requested:@me`, waiting: true },
    ]);
    expect(github.searches.every(({ authorization }) => authorization === `token ${TOKEN}`)).toBe(true);
  });

  it('lists no repository group when no repository is open, with one search fewer', async () => {
    const github = searchFetch();

    const list = await listPullRequests({ token: TOKEN, cacheDir, fetch: github.fetch });

    expect(listed(list).map(({ group }) => group)).toEqual(['review requested', 'yours', 'involving you']);
    expect(github.searches).toHaveLength(3);
  });

  it('returns each pull request with its repository, author, summary, review state and size', async () => {
    const list = await listPullRequests({ token: TOKEN, repository: 'example-org/example-repo', cacheDir, fetch: searchFetch().fetch });

    expect(pullRequest(list, 'https://github.com/example-org/example-repo/pull/42')).toEqual({
      url: 'https://github.com/example-org/example-repo/pull/42',
      repository: 'example-org/example-repo',
      number: 42,
      title: 'Retry failed webhook sends',
      author: 'maria-k',
      updatedAt: '2026-10-09T16:20:00Z',
      summary: 'Retries a webhook send that fails, three times with a one-second wait. Logs each retry with the reason it was needed.',
      review: { requested: true, approvals: 2, changesRequested: 1, draft: false },
      size: { additions: 84, deletions: 12, files: 5 },
      newCommitsSinceLastLook: false,
      waitingSince: '2026-10-08T10:00:00Z',
    });
    expect(pullRequest(list, 'https://github.com/example-org/auth/pull/62')).toMatchObject({
      author: '',
      summary: '',
      review: { requested: true, approvals: 0, changesRequested: 0, draft: true },
    });
    const yours = pullRequest(list, 'https://github.com/example-org/example-repo/pull/7');
    expect(yours.review).toEqual({ requested: false, approvals: 0, changesRequested: 0, draft: true });
    expect(yours.waitingSince).toBeUndefined();
    expect(pullRequest(list, 'https://github.com/example-org/example-repo/pull/9').review).toEqual({
      requested: false,
      approvals: 0,
      changesRequested: 1,
      draft: false,
    });
  });

  it('sorts review requested by how long the reviewer kept each waiting: by name, else through a team, else since it opened', async () => {
    const list = await listPullRequests({ token: TOKEN, cacheDir, fetch: searchFetch().fetch });

    if (list.outcome !== 'listed') throw new Error(list.reason);
    expect(list.groups[0]!.pullRequests.map(({ number, waitingSince }) => ({ number, waitingSince }))).toEqual([
      { number: 62, waitingSince: '2026-10-03T07:15:00Z' },
      { number: 412, waitingSince: '2026-10-05T09:30:00Z' },
      { number: 42, waitingSince: '2026-10-08T10:00:00Z' },
    ]);
  });

  it('flags new commits from the last-look record alone, and stores nothing', async () => {
    const at = '2026-10-01T09:00:00Z';
    await recordLook(cacheDir, { owner: 'example-org', repo: 'example-repo', number: 42 }, { commit: 'a'.repeat(40), at });
    await recordLook(cacheDir, { owner: 'example-org', repo: 'example-repo', number: 7 }, { commit: '7'.repeat(40), at });
    const before = readdirSync(cacheDir, { recursive: true }).sort();

    const list = await listPullRequests({ token: TOKEN, repository: 'example-org/example-repo', cacheDir, fetch: searchFetch().fetch });

    expect(pullRequest(list, 'https://github.com/example-org/example-repo/pull/42').newCommitsSinceLastLook).toBe(true);
    expect(pullRequest(list, 'https://github.com/example-org/example-repo/pull/7').newCommitsSinceLastLook).toBe(false);
    expect(pullRequest(list, 'https://github.com/example-org/example-repo/pull/9').newCommitsSinceLastLook).toBe(false);
    expect(readdirSync(cacheDir, { recursive: true }).sort()).toEqual(before);
  });

  it('says the reviewer is not signed in, in plain words, without asking GitHub', async () => {
    const github = searchFetch();

    expect(await listPullRequests({ cacheDir, fetch: github.fetch })).toEqual({ outcome: 'signed out', reason: SIGNED_OUT_REASON });
    expect(await listPullRequests({ token: '', cacheDir, fetch: github.fetch })).toEqual({ outcome: 'signed out', reason: SIGNED_OUT_REASON });
    expect(github.searches).toEqual([]);
  });

  it('says the sign-in was refused when GitHub does not accept the token', async () => {
    const refusing: typeof fetch = async () => Response.json({ message: 'Bad credentials' }, { status: 401 });

    expect(await listPullRequests({ token: TOKEN, cacheDir, fetch: refusing })).toEqual({ outcome: 'signed out', reason: SIGN_IN_REFUSED_REASON });
  });

  it('says GitHub could not be reached when the connection fails, naming why', async () => {
    const offline = failingFetch(new TypeError('fetch failed', { cause: new Error('getaddrinfo ENOTFOUND api.github.com') }));

    expect(await listPullRequests({ token: TOKEN, cacheDir, fetch: offline })).toEqual({
      outcome: 'unreachable',
      reason: 'GitHub could not be reached (getaddrinfo ENOTFOUND api.github.com): check the connection and try again.',
    });
  });

  it('says GitHub could not be reached when it does not answer in time', async () => {
    const silent = failingFetch(new DOMException('The operation was aborted due to timeout', 'TimeoutError'));

    expect(await listPullRequests({ token: TOKEN, cacheDir, fetch: silent })).toEqual({
      outcome: 'unreachable',
      reason: `GitHub could not be reached: it did not answer within ${SEARCH_TIMEOUT_MS / 1000} seconds.`,
    });
  });

  it('fails with GitHub’s own message when it answers a search with an error', async () => {
    const limited: typeof fetch = async () => Response.json({ data: null, errors: [{ message: 'API rate limit exceeded' }] });

    await expect(listPullRequests({ token: TOKEN, cacheDir, fetch: limited })).rejects.toThrow("GitHub's pull-request search failed: API rate limit exceeded");
  });
});

describe('pullRequestSummary', () => {
  it('takes the first two lines of text a reader sees, skipping headings, blank lines and hidden content', () => {
    const body = '<!-- hidden instructions -->\r\n# Title\n\n  First\u202e line\u200b.  \n\nSecond line.\nThird line.';

    expect(pullRequestSummary(body)).toBe('First line. Second line.');
  });

  it('drops control characters and cuts a long start to the summary length', () => {
    const summary = pullRequestSummary(`${'word '.repeat(100)}\u0007`);

    expect([...summary]).toHaveLength(PULL_REQUEST_SUMMARY_LENGTH);
    expect(summary.endsWith('…')).toBe(true);
    expect(summary).not.toContain('\u0007');
  });

  it('keeps a summary within the length whole, and an empty description empty', () => {
    expect(pullRequestSummary('Short and plain.')).toBe('Short and plain.');
    expect(pullRequestSummary('')).toBe('');
  });
});

describe('isRepositoryName', () => {
  it('accepts owner/name only, so no other search qualifier can ride along', () => {
    expect(isRepositoryName('example-org/example-repo')).toBe(true);
    expect(isRepositoryName('example-org/example-repo is:closed')).toBe(false);
    expect(isRepositoryName('example-repo')).toBe(false);
    expect(isRepositoryName(42)).toBe(false);
  });
});
