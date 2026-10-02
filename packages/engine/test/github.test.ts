import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { GitHubClient, parsePullRequestUrl } from '../src/github.js';
import { PR_URL, SENT_REVIEW_URL, fixtureFetch } from './helpers.js';

const recordedJson = JSON.parse(
  readFileSync(fileURLToPath(new URL('./fixtures/pull-42.json', import.meta.url)), 'utf8'),
) as { body: string };

describe('parsePullRequestUrl', () => {
  it('accepts a plain pull request URL', () => {
    expect(parsePullRequestUrl(PR_URL)).toEqual({
      owner: 'example-org',
      repo: 'example-repo',
      number: 42,
    });
  });

  it('accepts a URL with a trailing path such as /files', () => {
    expect(
      parsePullRequestUrl('https://github.com/example-org/example-repo/pull/42/files'),
    ).toEqual({ owner: 'example-org', repo: 'example-repo', number: 42 });
  });

  it('rejects anything that is not a GitHub pull request URL', () => {
    expect(parsePullRequestUrl('https://gitlab.com/a/b/merge_requests/1')).toBeNull();
    expect(parsePullRequestUrl('https://github.com/example-org/example-repo/issues/42')).toBeNull();
    expect(parsePullRequestUrl('example-org/example-repo#42')).toBeNull();
    expect(parsePullRequestUrl('')).toBeNull();
  });
});

describe('GitHubClient against recorded responses', () => {
  const ref = { owner: 'example-org', repo: 'example-repo', number: 42 };

  it('reads the metadata and keeps the description in full', async () => {
    const transport = fixtureFetch();
    const client = new GitHubClient({ token: 'test-token', fetch: transport.fetch });
    const summary = await client.getPullRequestSummary(ref);

    expect(summary.url).toBe('https://github.com/example-org/example-repo/pull/42');
    expect(summary.number).toBe(42);
    expect(summary.title).toBe('Update dependencies and rename the config module');
    expect(summary.author).toBe('reviewer-login');
    expect(summary.base).toBe('master');
    expect(summary.head).toBe('update-deps');
    expect(summary.headSha).toBe('f00dcafe1234567890abcdef1234567890abcdef');
    // The description arrives exactly as recorded, byte for byte, however
    // long it is; the engine never truncates it.
    expect(summary.description).toBe(recordedJson.body);
    expect(summary.description).toHaveLength(8082);
    expect(summary.description.endsWith('END-OF-DESCRIPTION')).toBe(true);
    expect(transport.requests).toHaveLength(1);
    expect(transport.requests[0]!.accept).toContain('vnd.github.v3+json');
  });

  it('fetches the full diff through the diff media type', async () => {
    const transport = fixtureFetch();
    const client = new GitHubClient({ token: 'test-token', fetch: transport.fetch });
    const diff = await client.getPullRequestDiff(ref);

    const recordedDiff = readFileSync(
      fileURLToPath(new URL('./fixtures/pull-42.diff', import.meta.url)),
      'utf8',
    );
    expect(diff).toBe(recordedDiff);
    // The lockfile hunk keeps every one of its lines.
    expect(diff).toContain('+    "new-dep-0001": {');
    expect(diff).toContain('+    "new-dep-0012": {');
    expect(diff).toContain('Binary files a/assets/logo.png and b/assets/logo.png differ');
    // The request asked for the diff media type, which returns the full
    // patch even when the REST file list would omit a large file's patch.
    expect(transport.requests[0]!.accept).toContain('application/vnd.github.v3.diff');
  });

  it('sends the token only as the request authorization header', async () => {
    const transport = fixtureFetch();
    const client = new GitHubClient({ token: 'test-token', fetch: transport.fetch });
    await client.getPullRequestSummary(ref);
    expect(transport.requests[0]!.authorization).toBe('token test-token');
  });

  it('refuses to serve URLs outside the recorded pull request', async () => {
    const transport = fixtureFetch();
    const client = new GitHubClient({ token: 'test-token', fetch: transport.fetch });
    await expect(
      client.getPullRequestSummary({ owner: 'other', repo: 'repo', number: 1 }),
    ).rejects.toThrow(/recorded responses only/);
  });

  it("reads the root .gitattributes at the head commit, without a checkout", async () => {
    const transport = fixtureFetch();
    const client = new GitHubClient({ token: 'test-token', fetch: transport.fetch });
    const attributes = await client.getGitAttributesAt(
      ref,
      'f00dcafe1234567890abcdef1234567890abcdef',
    );

    expect(attributes).toBe(
      [
        '# Tell GitHub\'s classifier how to read this repository.',
        'src/generated/** linguist-generated=true',
        'vendor/** linguist-vendored',
        'docs/* linguist-documentation',
        '',
      ].join('\n'),
    );
    expect(transport.requests).toHaveLength(1);
    expect(transport.requests[0]!.url).toBe(
      'https://api.github.com/repos/example-org/example-repo/contents/.gitattributes' +
        '?ref=f00dcafe1234567890abcdef1234567890abcdef',
    );
  });

  it('reports a missing .gitattributes as null, and passes other failures through', async () => {
    const notFound = async (): Promise<Response> =>
      new Response('{"message": "Not Found"}', {
        status: 404,
        headers: { 'content-type': 'application/json' },
      });
    const client = new GitHubClient({ token: 'test-token', fetch: notFound });
    expect(await client.getGitAttributesAt(ref, 'missing0000000000000000000000000000000')).toBeNull();

    const forbidden = async (): Promise<Response> =>
      new Response('{"message": "Forbidden"}', {
        status: 403,
        headers: { 'content-type': 'application/json' },
      });
    const denied = new GitHubClient({ token: 'test-token', fetch: forbidden });
    await expect(
      denied.getGitAttributesAt(ref, 'forbidden00000000000000000000000000000'),
    ).rejects.toThrow();
  });

  it('submits one review: every comment in one POST, answered with its link', async () => {
    const transport = fixtureFetch();
    const client = new GitHubClient({ token: 'test-token', fetch: transport.fetch });
    const sent = await client.submitReview(ref, {
      commitId: 'f00dcafe1234567890abcdef1234567890abcdef',
      submit: 'request changes',
      body: 'One deliberate pass over the change.',
      comments: [
        { path: 'src/settings.ts', body: 'why remove this?', position: 2 },
        { path: 'README.md', body: 'reads well now', subjectType: 'file' },
      ],
    });

    expect(sent).toEqual({ url: SENT_REVIEW_URL });
    expect(transport.requests).toHaveLength(1);
    expect(transport.requests[0]).toMatchObject({
      url: 'https://api.github.com/repos/example-org/example-repo/pulls/42/reviews',
      method: 'POST',
      authorization: 'token test-token',
    });
    expect(transport.requests[0]!.body).toEqual({
      commit_id: 'f00dcafe1234567890abcdef1234567890abcdef',
      body: 'One deliberate pass over the change.',
      event: 'REQUEST_CHANGES',
      comments: [
        { path: 'src/settings.ts', position: 2, body: 'why remove this?' },
        { path: 'README.md', subject_type: 'file', body: 'reads well now' },
      ],
    });
  });
});
