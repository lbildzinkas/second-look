import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { GitHubClient, parsePullRequestUrl } from '../src/github.js';
import { PR_URL, fixtureFetch } from './helpers.js';

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
});
