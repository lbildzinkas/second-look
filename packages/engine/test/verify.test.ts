import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ASKS, askAboutPart } from '../src/asks.js';
import { REVIEW_RESULT_VERSION, type Claim, type ReviewResult } from '../src/protocol.js';
import { VERDICTS_PROMPT_ID, VERDICTS_PROMPT_VERSION, copyReader } from '../src/verdicts.js';
import { MAX_SELECTION, isAskedClaim, selectedClaim, withVerifiedClaim } from '../src/verify.js';
import { changedPart, scriptedAgent } from './helpers.js';

const RETRY = ['def send_with_retry(send):', '    # Retries three times,', '    # whatever the status.', '    return retry(send, 3)', ''].join('\n');

const HASH = 'a'.repeat(64);

/** A head copy holding the retry file, and a requirements file that pins httpx with a hash. */
function headCopy(): string {
  const root = mkdtempSync(join(tmpdir(), 'second-look-verify-'));
  mkdirSync(join(root, 'app'));
  writeFileSync(join(root, 'app', 'retry.py'), RETRY);
  writeFileSync(join(root, 'requirements.txt'), `httpx==0.27.2 --hash=sha256:${HASH}\n`);
  return root;
}

/** The claim the claims pass listed about the retry part, not checked yet. */
const LISTED: Claim = {
  quote: 'Retries three times, whatever the status.',
  source: 'comment',
  location: { kind: 'file', path: 'app/retry.py', line: 2, endLine: 3 },
  part: 0,
  verdict: { kind: 'not checked' },
};

function reviewed(root: string, claims: Claim[] = [LISTED]): ReviewResult {
  const stamp = { agent: 'fake', agentVersion: '1.2.3', model: 'fake/model', effort: null, runAt: '2026-10-02T00:00:00.000Z' };
  return {
    version: REVIEW_RESULT_VERSION,
    pullRequest: {
      url: 'https://github.com/example-org/example-repo/pull/42',
      number: 42,
      title: 'Retry sends',
      author: 'author',
      description: 'Retries failed sends.',
      base: 'master',
      head: 'retry',
      baseCommit: 'b'.repeat(40),
      headSha: 'h'.repeat(40),
    },
    copies: { base: { commit: 'b'.repeat(40), path: '/cache/base', reused: false }, head: { commit: 'h'.repeat(40), path: root, reused: false } },
    parseTimeMs: 0,
    parts: [
      { ...changedPart({ path: 'app/retry.py', head: RETRY, added: [2, 3, 4] }), name: 'send_with_retry in app/retry.py' },
      { ...changedPart({ path: 'app/config.py', head: 'MAX_ATTEMPTS = 5', added: [1] }), name: 'top-level code in app/config.py' },
    ],
    grouping: { by: 'plain' },
    ranking: { by: 'plain' },
    pipeline: { attestation: 'missing', detail: 'none', steps: [], findings: [] },
    claims: { promptVersion: '1', outcome: 'listed', detail: 'listed', stamp, claims },
  };
}

/** The verdicts pass's answer for the one claim it is shown. */
function verdictAnswer(verdict: Record<string, unknown>): string {
  return JSON.stringify({ verdicts: [{ id: 'c1', library: null, repository: null, ...verdict }] });
}

const REFUTED = verdictAnswer({
  verdict: 'refuted',
  source: 'the change itself',
  reason: '`send_with_retry` always passes 3, but `retry` stops on a 4xx status.',
  evidence: [{ file: 'app/retry.py', line: 4, quote: 'return retry(send, 3)' }],
});

const SELECTION = { path: 'app/retry.py', line: 2, endLine: 3, text: '# Retries three times,\n    # whatever the status.' };

describe('isAskedClaim', () => {
  it('reads a claim by its index, or a selection with its file, lines and text', () => {
    expect(isAskedClaim({ index: 0 })).toBe(true);
    expect(isAskedClaim({ selection: SELECTION })).toBe(true);
    expect(isAskedClaim({ index: -1 })).toBe(false);
    expect(isAskedClaim({ index: 1.5 })).toBe(false);
    expect(isAskedClaim({ selection: { ...SELECTION, line: '2' } })).toBe(false);
    expect(isAskedClaim({})).toBe(false);
    expect(isAskedClaim('c1')).toBe(false);
  });
});

describe('selectedClaim', () => {
  it("makes the reviewer's selection a claim about the part, each line's comment marker dropped, not checked yet", async () => {
    const root = headCopy();
    const { parts } = reviewed(root);

    expect(await selectedClaim(parts, 0, SELECTION, copyReader(root))).toEqual({
      quote: 'Retries three times, whatever the status.',
      source: 'reviewer',
      location: { kind: 'file', path: 'app/retry.py', line: 2, endLine: 3 },
      part: 0,
      verdict: { kind: 'not checked' },
    });
    expect(await selectedClaim(parts, 0, { path: 'app/retry.py', line: 4, endLine: 4, text: 'retry(send, 3)' }, copyReader(root))).toMatchObject({ quote: 'retry(send, 3)' });
  });

  it('refuses a selection off the part, off the head copy, with no text, too long, or over too many lines', async () => {
    const root = headCopy();
    const { parts } = reviewed(root);
    const read = copyReader(root);

    expect(await selectedClaim(parts, 1, SELECTION, read)).toBe("the selection is not on the head side of this part's diff");
    expect(await selectedClaim(parts, 0, { ...SELECTION, line: 1 }, read)).toBe("the selection is not on the head side of this part's diff");
    expect(await selectedClaim(parts, 0, { ...SELECTION, text: 'Retries five times' }, read)).toBe('the selection is not on lines 2-3 of app/retry.py in the head copy');
    expect(await selectedClaim(parts, 0, { ...SELECTION, text: ' # ' }, read)).toBe('the selection holds no text to verify');
    expect(await selectedClaim(parts, 0, { ...SELECTION, text: 'x'.repeat(MAX_SELECTION + 1) }, read)).toContain(`over ${MAX_SELECTION} characters`);
    expect(await selectedClaim(parts, 0, { ...SELECTION, endLine: 40 }, read)).toBe('select at most 20 lines');
  });
});

describe('the verify ask', () => {
  it('is the judging pass, run on the claim the reviewer picks or selects', () => {
    expect(ASKS.verify).toMatchObject({ title: 'Verify this claim', promptId: VERDICTS_PROMPT_ID, takesClaim: true });
  });

  it('judges a selection alone, its quote fenced as untrusted, and answers with its verdict, its re-read evidence and the claim after the others', async () => {
    const root = headCopy();
    const agent = scriptedAgent([REFUTED]);

    const answer = await askAboutPart('verify', { result: reviewed(root), part: 0, adapter: agent, claim: { selection: SELECTION } });

    expect(agent.requests).toHaveLength(1);
    expect(agent.requests[0]!.prompt).toContain('[c1] made in text the reviewer selected in the diff of "app/retry.py", lines 2-3, and asked to verify; about part p1');
    expect(agent.requests[0]!.prompt).toMatch(/source="claim c1">\nRetries three times, whatever the status\.\n<\/untrusted-input/);
    const claim: Claim = {
      ...LISTED,
      source: 'reviewer',
      asked: true,
      verdict: {
        kind: 'refuted',
        source: 'the change itself',
        reason: '`send_with_retry` always passes 3, but `retry` stops on a 4xx status.',
        evidence: [{ path: 'app/retry.py', line: 4, quote: 'return retry(send, 3)' }],
      },
    };
    expect(answer).toEqual({
      ask: 'verify',
      part: 0,
      partName: 'send_with_retry in app/retry.py',
      sections: [
        { heading: 'Claim', text: '"Retries three times, whatever the status.", made in text the reviewer selected in the diff of "app/retry.py", lines 2-3, and asked to verify.' },
        { heading: 'Verdict', text: 'refuted, from the change itself: `send_with_retry` always passes 3, but `retry` stops on a 4xx status.' },
      ],
      cited: [{ path: 'app/retry.py', side: 'head', line: 4, quote: 'return retry(send, 3)' }],
      promptVersion: VERDICTS_PROMPT_VERSION,
      stamp: expect.objectContaining({ agent: 'fake', model: 'fake/model' }),
      claim: { index: 1, claim },
    });
  });

  it("re-judges a picked claim in its place, and offers the library fetch a claim needs, downloading nothing", async () => {
    const root = headCopy();
    const agent = scriptedAgent([
      verdictAnswer({ verdict: 'unverifiable', source: "the model's memory", reason: 'It turns on how `httpx` retries.', evidence: [], library: 'httpx' }),
    ]);

    const answer = await askAboutPart('verify', { result: reviewed(root), part: 0, adapter: agent, claim: { index: 0 } });

    expect(answer.claim).toMatchObject({ index: 0, claim: { source: 'comment', asked: true, verdict: { kind: 'unverifiable', needsLibrary: 'httpx', libraryFetch: { library: 'httpx', pinnedVersion: '0.27.2', pinnedBy: 'requirements.txt' } } } });
    expect(answer.sections.at(-1)).toEqual({
      heading: 'Library fetch',
      text:
        'The change alone cannot settle this claim: it turns on how httpx behaves, so checking it needs the source of httpx 0.27.2, as requirements.txt pins it. ' +
        "Press the fetch on the claim's finding to start it.",
    });
    expect(answer.cited).toEqual([]);
  });

  it("refuses a claim that is not the part's, one judged in a library's source, and an ask with no claim", async () => {
    const root = headCopy();
    const fetched: Claim = {
      ...LISTED,
      verdict: {
        kind: 'refuted',
        source: 'library source at the pinned version',
        reason: 'It does not.',
        evidence: [],
        library: { library: 'httpx', pinnedVersion: '0.27.2', pinnedBy: 'requirements.txt', file: 'httpx.whl', sha256: HASH, archive: 'wheel', path: '/cache/httpx', promptVersion: '3', stamp: { agent: 'fake', agentVersion: '1', model: 'm', effort: null, runAt: '2026-10-02T00:00:00.000Z' } },
      },
    };
    const agent = scriptedAgent([]);

    await expect(askAboutPart('verify', { result: reviewed(root), part: 1, adapter: agent, claim: { index: 0 } })).rejects.toThrow("claim 0 is not one of this part's claims");
    await expect(askAboutPart('verify', { result: reviewed(root, [fetched]), part: 0, adapter: agent, claim: { index: 0 } })).rejects.toThrow("judged in its library's source");
    await expect(askAboutPart('verify', { result: reviewed(root), part: 0, adapter: agent })).rejects.toThrow('select the text to verify');
    expect(agent.requests).toHaveLength(0);
  });

  it('gives no answer when the judging falls back', async () => {
    await expect(askAboutPart('verify', { result: reviewed(headCopy()), part: 0, adapter: scriptedAgent(['no json', 'still none']), claim: { index: 0 } })).rejects.toThrow(
      /^no answer: the agent gave no usable answer/,
    );
  });
});

describe('withVerifiedClaim', () => {
  const judged: Claim = { ...LISTED, verdict: { kind: 'verified', source: 'the change itself', reason: 'It does.', evidence: [] } };

  it("puts a picked claim's verdict in its place, and a new selection after every claim", () => {
    const result = reviewed('/cache/head');

    expect(withVerifiedClaim(result, { index: 0, claim: judged })?.claims?.claims).toEqual([judged]);
    const selected = { ...judged, source: 'reviewer' as const };
    expect(withVerifiedClaim(result, { index: 1, claim: selected })?.claims?.claims).toEqual([LISTED, selected]);
  });

  it('says nothing fits when the claims changed meanwhile', () => {
    const result = reviewed('/cache/head');

    expect(withVerifiedClaim(result, { index: 0, claim: { ...judged, quote: 'Another claim.' } })).toBeUndefined();
    expect(withVerifiedClaim(result, { index: 2, claim: judged })).toBeUndefined();
    expect(withVerifiedClaim({ ...result, claims: undefined }, { index: 0, claim: judged })).toBeUndefined();
  });
});
