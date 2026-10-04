import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { removeCopy } from '../src/cache.js';
import { checkFailed, ciLogItems, readCi, trimLog } from '../src/ci.js';
import { GitHubClient } from '../src/github.js';
import { reviewPullRequest } from '../src/review.js';
import { PR_URL, fixtureFetch, pull42, temporaryCacheDir } from './helpers.js';

const ref = { owner: 'example-org', repo: 'example-repo', number: 42 };
const HEAD = 'f00dcafe1234567890abcdef1234567890abcdef';
const MERGE = '9f3c2e1a0b4d5c6e7f8091a2b3c4d5e6f7a8b9c0';
const API = 'https://api.github.com/repos/example-org/example-repo';

const recordedLog = readFileSync(fileURLToPath(new URL('./fixtures/ci/job-9001.log', import.meta.url)), 'utf8');

describe('trimLog', () => {
  it('keeps the failing step, from its start to its last error, timestamps removed', () => {
    expect(trimLog(recordedLog)).toEqual({
      step: 'npm test',
      lines: [
        '##[group]Run npm test',
        'npm test',
        '##[endgroup]',
        ' FAIL  test/settings.test.ts > settings > loads the defaults',
        'AssertionError: expected 3000 to be 30',
        ' Tests  1 failed | 41 passed (42)',
        '##[error]Process completed with exit code 1.',
      ],
      detail: 'trimmed to the failing step "npm test", ending at its last error',
    });
  });

  it('keeps at most 200 lines of a long step, ending at its last error', () => {
    const noise = Array.from({ length: 300 }, (_, at) => `test ${at} passed`);
    const log = ['##[group]Run npm test', ...noise, '##[error]first', 'more', '##[error]last', '##[group]Run cleanup', 'done'].join('\n');
    const trimmed = trimLog(log);
    expect(trimmed.lines).toHaveLength(200);
    expect(trimmed.lines[199]).toBe('##[error]last');
    expect(trimmed.detail).toBe('trimmed to the failing step "npm test", its last 200 lines, ending at its last error');
  });

  it('keeps the last lines of a log that marks no error', () => {
    const trimmed = trimLog('2026-09-29T08:31:02.1000000Z one\ntwo\n');
    expect(trimmed).toEqual({ lines: ['one', 'two'], detail: 'the log marks no failing step, so its last 2 lines are kept' });
  });
});

describe('readCi against recorded responses', () => {
  it('lists the check runs and their annotations, and fetches a log only for the failed Actions job', async () => {
    const transport = fixtureFetch({ ...pull42(), ci: true });
    const ci = await readCi(new GitHubClient({ token: 'test-token', fetch: transport.fetch }), ref, HEAD, MERGE);

    expect(ci).toMatchObject({
      outcome: 'read',
      headSha: HEAD,
      mergeCommit: MERGE,
      detail: '3 check runs at the head commit, 2 failed; logs are read only for failed jobs',
    });
    expect(ci.checks.map((check) => [check.name, check.conclusion])).toEqual([
      ['check / test', 'failure'],
      ['check / lint', 'success'],
      ['external coverage', 'failure'],
    ]);
    const [test, lint, external] = ci.checks;
    expect(test!.url).toBe('https://github.com/example-org/example-repo/actions/runs/700/job/9001');
    expect(test!.annotations).toEqual([
      { path: 'src/settings.ts', startLine: 12, endLine: 12, level: 'failure', message: 'Expected 30 but received 3000', title: 'settings › loads the defaults' },
      { path: '.github', startLine: 1, endLine: 1, level: 'failure', message: 'Process completed with exit code 1.' },
    ]);
    expect(test!.log).toMatchObject({ step: 'npm test' });
    expect(test!.log!.lines).toContain('AssertionError: expected 3000 to be 30');
    expect(lint!.annotations).toEqual([
      { path: 'src/fresh.ts', startLine: 3, endLine: 4, level: 'warning', message: "'unused' is assigned a value but never used.", title: 'no-unused-vars' },
      { path: '.github/workflows/lint.yml', level: 'notice', message: 'The workflow sets no timeout-minutes.' },
    ]);
    // A check that passed has no log, and a failed check of another app has none to read.
    expect(lint!.log).toBeUndefined();
    expect(external!.log).toEqual({ lines: [], detail: 'it is not a GitHub Actions job, so there is no log to read' });

    // Every request is a read; only the failed Actions job's log was asked for.
    expect(transport.requests.every((request) => request.method === 'GET')).toBe(true);
    const logs = transport.requests.filter((request) => request.url.includes('/logs'));
    expect(logs.map((request) => request.url)).toEqual([`${API}/actions/jobs/9001/logs`]);
    // A check run that left no annotations is not asked for any.
    expect(transport.requests.some((request) => request.url.includes('/check-runs/9003/annotations'))).toBe(false);
  });

  it('lists a file-level annotation, whose lines GitHub leaves null, without line fields', async () => {
    const transport = fixtureFetch({ ...pull42(), ci: true });
    const ci = await readCi(new GitHubClient({ token: 'test-token', fetch: transport.fetch }), ref, HEAD, MERGE);
    expect(ci.checks[1]!.annotations).toContainEqual({ path: '.github/workflows/lint.yml', level: 'notice', message: 'The workflow sets no timeout-minutes.' });
  });

  it('gives the failed logs that have lines their ids, for the verdicts prompt', async () => {
    const transport = fixtureFetch({ ...pull42(), ci: true });
    const ci = await readCi(new GitHubClient({ token: 'test-token', fetch: transport.fetch }), ref, HEAD, null);
    expect(ci.mergeCommit).toBeUndefined();
    expect(ciLogItems(ci).map((item) => [item.id, item.check.name])).toEqual([['log1', 'check / test']]);
    expect(ciLogItems(undefined)).toEqual([]);
  });

  it('says why when the check runs cannot be read, and fails nothing', async () => {
    const refused: typeof fetch = async () => Response.json({ message: 'Resource not accessible by integration' }, { status: 403 });
    const ci = await readCi(new GitHubClient({ token: 'test-token', fetch: refused }), ref, HEAD, MERGE);
    expect(ci).toEqual({ outcome: 'unreadable', detail: 'the check runs could not be read: GitHub answered 403', headSha: HEAD, mergeCommit: MERGE, checks: [] });
  });

  it("says why a failed job's log could not be read", async () => {
    const transport = fixtureFetch({ ...pull42(), ci: true });
    const expired: typeof fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.endsWith('/logs')) return Response.json({ message: 'Gone' }, { status: 410 });
      return transport.fetch(input, init);
    };
    const ci = await readCi(new GitHubClient({ token: 'test-token', fetch: expired }), ref, HEAD, MERGE);
    expect(ci.checks[0]!.log).toEqual({ lines: [], detail: 'its log could not be read: GitHub answered 410' });
  });

  it('names a failed conclusion', () => {
    expect(['failure', 'timed_out', 'startup_failure'].every(checkFailed)).toBe(true);
    expect(['success', 'neutral', 'skipped', 'cancelled'].some(checkFailed)).toBe(false);
    expect(checkFailed(null)).toBe(false);
  });
});

describe('reviewPullRequest with CI', () => {
  let cacheDir: string;

  beforeEach(() => {
    cacheDir = temporaryCacheDir();
  });

  afterEach(async () => {
    await removeCopy(cacheDir);
  });

  it('carries the CI at the head commit, labelled with the merge commit, and the pipeline report', async () => {
    const result = await reviewPullRequest(PR_URL, { token: 'test-token', fetch: fixtureFetch({ ...pull42(), ci: true }).fetch, cacheDir });
    expect(result.ci).toMatchObject({ outcome: 'read', headSha: HEAD, mergeCommit: MERGE });
    expect(result.ci!.checks).toHaveLength(3);
    expect(result.pipeline).toEqual({ attestation: 'missing', detail: 'the description carries no no-mistakes attestation', steps: [], findings: [] });
  });

  it('reads no log when no check failed', async () => {
    const transport = fixtureFetch();
    const result = await reviewPullRequest(PR_URL, { token: 'test-token', fetch: transport.fetch, cacheDir });
    expect(result.ci).toMatchObject({ outcome: 'read', checks: [] });
    expect(transport.requests.some((request) => request.url.includes('/logs'))).toBe(false);
  });
});
