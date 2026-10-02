import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { reviewPullRequest } from '../src/review.js';
import { sendReview } from '../src/send.js';
import type { Comment, PendingReview } from '../src/protocol.js';
import { removeCopy } from '../src/cache.js';
import {
  PR_URL,
  SENT_REVIEW_URL,
  fixtureFetch,
  pull42,
  temporaryCacheDir,
} from './helpers.js';

/** A pending review with these comments, submitted one way or another. */
function pendingReview(
  comments: Comment[],
  submit: PendingReview['submit'] = 'comment',
  body?: string,
): PendingReview {
  return { submit, comments, ...(body !== undefined ? { body } : {}) };
}

let cacheDir: string;

beforeAll(() => {
  cacheDir = temporaryCacheDir();
});

afterAll(async () => {
  await removeCopy(cacheDir);
});

describe('sendReview against recorded responses', () => {
  it('sends the pending review as one review: one POST carrying everything', async () => {
    const transport = fixtureFetch();
    const sent = await sendReview(
      PR_URL,
      pendingReview(
        [
          { kind: 'line', path: 'src/settings.ts', side: 'base', line: 3, body: 'why remove this?' },
          { kind: 'line', path: 'src/settings.ts', side: 'head', line: 3, body: 'what does this add?' },
          { kind: 'part', path: 'README.md', body: 'the guide reads well now' },
        ],
        'comment',
        'One deliberate pass over the change.',
      ),
      { token: 'test-token', fetch: transport.fetch },
    );

    expect(sent).toEqual({ url: SENT_REVIEW_URL });
    const writes = transport.requests.filter((request) => request.method === 'POST');
    expect(writes).toHaveLength(1);
    expect(writes[0]!.url).toBe('https://api.github.com/repos/example-org/example-repo/pulls/42/reviews');
    // The review is pinned to the head commit whose diff the comments'
    // positions were mapped against, and the renamed file travels under
    // its new-side path.
    expect(writes[0]!.body).toEqual({
      commit_id: pull42().headSha,
      body: 'One deliberate pass over the change.',
      event: 'COMMENT',
      comments: [
        { path: 'src/settings.ts', position: 2, body: 'why remove this?' },
        { path: 'src/settings.ts', position: 3, body: 'what does this add?' },
        { path: 'README.md', subject_type: 'file', body: 'the guide reads well now' },
      ],
    });
    expect(writes[0]!.authorization).toBe('token test-token');
  });

  it('submits each of the three kinds', async () => {
    for (const [submit, event] of [
      ['comment', 'COMMENT'],
      ['approve', 'APPROVE'],
      ['request changes', 'REQUEST_CHANGES'],
    ] as const) {
      const transport = fixtureFetch();
      await sendReview(
        PR_URL,
        pendingReview(
          [{ kind: 'line', path: 'src/fresh.ts', side: 'head', line: 1, body: 'first!' }],
          submit,
        ),
        { token: 'test-token', fetch: transport.fetch },
      );

      const write = transport.requests.find((request) => request.method === 'POST')!;
      expect(write.body).toMatchObject({ event });
    }
  });

  it('writes nothing before send: reviewing and mapping only read', async () => {
    const transport = fixtureFetch();
    // The whole read path a review takes; the comments gathered over it
    // are held in the companion, not on GitHub.
    await reviewPullRequest(PR_URL, {
      token: 'test-token',
      fetch: transport.fetch,
      cacheDir,
    });
    const pending = pendingReview([
      { kind: 'line', path: 'README.md', side: 'head', line: 14, body: 'ready to send' },
    ]);
    const before = transport.requests.length;
    expect(transport.requests.every((request) => request.method === 'GET')).toBe(true);

    await sendReview(PR_URL, pending, { token: 'test-token', fetch: transport.fetch });

    // The reads the send itself takes, then exactly one write, first at
    // the moment of sending.
    expect(transport.requests.slice(before, -1).every((request) => request.method === 'GET')).toBe(true);
    expect(transport.requests.at(-1)).toMatchObject({ method: 'POST' });
  });

  it('reads the pull request again before sending, sending only what maps', async () => {
    const transport = fixtureFetch();
    await sendReview(PR_URL, pendingReview([], 'approve'), {
      token: 'test-token',
      fetch: transport.fetch,
    });

    expect(transport.requests.map((request) => request.url)).toEqual([
      'https://api.github.com/repos/example-org/example-repo/pulls/42',
      'https://api.github.com/repos/example-org/example-repo/pulls/42',
      'https://api.github.com/repos/example-org/example-repo/pulls/42/reviews',
    ]);
  });

  it('fails plainly when a comment cannot be mapped, writing nothing', async () => {
    const transport = fixtureFetch();
    await expect(
      sendReview(
        PR_URL,
        pendingReview([
          { kind: 'line', path: 'src/gone.ts', side: 'head', line: 1, body: 'stale comment' },
        ]),
        { token: 'test-token', fetch: transport.fetch },
      ),
    ).rejects.toThrow('the diff touches no file at src/gone.ts');
    expect(transport.requests.some((request) => request.method === 'POST')).toBe(false);
  });

  it('fails plainly when GitHub refuses the send', async () => {
    const refusing: typeof fetch = async () =>
      Response.json({ message: 'Validation Failed' }, { status: 422 });
    await expect(
      sendReview(PR_URL, pendingReview([], 'comment', 'tried and failed'), {
        token: 'test-token',
        fetch: refusing,
      }),
    ).rejects.toThrow();
  });

  it('refuses a URL that is not a pull request', async () => {
    const transport = fixtureFetch();
    await expect(
      sendReview('https://gitlab.com/a/b/merge_requests/1', pendingReview([]), {
        token: 'test-token',
        fetch: transport.fetch,
      }),
    ).rejects.toThrow('not a GitHub pull request URL');
    expect(transport.requests).toHaveLength(0);
  });
});
