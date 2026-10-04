import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { claimItems, locateClaims, reviewChange } from '@second-look/engine';
import type { Claim, ReviewResult } from '@second-look/engine';
import { caseInput, loadCases } from '../src/case.js';
import { labelledClaims, reportClaims, reportedClaims } from '../src/claims.js';
import type { LibraryFetchOffer } from '../src/claims.js';

const OFFER: LibraryFetchOffer & { pinnedBy: string } = {
  library: 'httpx',
  pinnedVersion: '0.27.2',
  pinnedBy: 'requirements.txt',
  reason: 'the claim needs the library source to be checked',
};

describe('reportedClaims', () => {
  it('reports none while the review result carries no claims, as the plain pass gives it', () => {
    expect(reportedClaims({} as ReviewResult)).toEqual([]);
  });

  it('hands back each claim the agent listed by its quote, with no verdict while none is checked', () => {
    const notChecked = { kind: 'not checked' as const };
    const result = {
      claims: {
        claims: [
          { quote: 'a claim', source: 'docstring', location: { kind: 'file', path: 'a.py', line: 1, endLine: 1 }, part: 0, verdict: notChecked },
          { quote: 'another claim', source: 'description', location: { kind: 'description', line: 2 }, part: 0, verdict: notChecked },
        ],
      },
    } as unknown as ReviewResult;
    expect(reportedClaims(result)).toEqual([{ text: 'a claim' }, { text: 'another claim' }]);
  });

  it('hands back a checked verdict with its first citation as the evidence, under its evidence source', () => {
    const cited = { path: 'app/x.py', line: 4, quote: 'return response.text' };
    const result = {
      claims: {
        claims: [
          { quote: 'a claim', verdict: { kind: 'verified', source: 'the change itself', reason: 'r', evidence: [cited] } },
          { quote: 'another claim', verdict: { kind: 'unverifiable', source: "the model's memory", reason: 'r', evidence: [] } },
        ],
      },
    } as unknown as ReviewResult;
    expect(reportedClaims(result)).toEqual([
      { text: 'a claim', verdict: { kind: 'verified', evidence: { file: 'app/x.py', line: 4, source: 'the change itself' } } },
      { text: 'another claim', verdict: { kind: 'unverifiable' } },
    ]);
  });
});

describe('reportClaims', () => {
  const refuted = { kind: 'unverifiable' as const, source: 'the change itself' as const, reason: 'r', evidence: [] };
  const claim = (verdict: Claim['verdict']): Claim => ({ quote: 'a claim', source: 'docstring', location: { kind: 'file', path: 'a.py', line: 1, endLine: 1 }, part: 0, verdict });

  it('hands back the fetch a verdict offers, unpressed until the claim was judged against the library', () => {
    expect(reportClaims([claim({ ...refuted, libraryFetch: OFFER })])).toEqual([{ text: 'a claim', verdict: { kind: 'unverifiable' }, fetchOffer: OFFER }]);
  });

  it('hands back the pressed offer once the claim was judged against the library, with its library citation', () => {
    const library = { library: 'httpx', pinnedVersion: '0.27.2', pinnedBy: 'requirements.txt', file: 'httpx-0.27.2-py3-none-any.whl', sha256: 'a'.repeat(64), archive: 'wheel' as const, path: '/cache/libraries/httpx', promptVersion: '1', stamp: { agent: 'fake', agentVersion: '1', model: 'fake/model', effort: null, runAt: '2026-10-04T00:00:00.000Z' } };
    const judged = claim({
      kind: 'refuted',
      source: 'library source at the pinned version',
      reason: 'r',
      evidence: [{ path: 'httpx/_client.py', line: 171, quote: 'follow_redirects: bool = False,' }],
      libraryFetch: OFFER,
      library,
    });

    expect(reportClaims([judged])).toEqual([
      {
        text: 'a claim',
        verdict: { kind: 'refuted', evidence: { file: 'httpx/_client.py', line: 171, source: 'library source at the pinned version' } },
        fetchOffer: OFFER,
        pressedFetch: OFFER,
      },
    ]);
  });
});

describe("the claims prompt's hand lists", () => {
  const CASES = fileURLToPath(new URL('../cases', import.meta.url));

  it("quote every claim as its source writes it, at the line the case names, so the engine's own check accepts it", async () => {
    const cases = (await loadCases([CASES])).filter((each) => each.record.prompts.includes('claims'));
    expect(cases.map((each) => each.id)).toEqual(['canary-csharp', 'canary-python', 'encode-httpx-3690', 'pallets-click-3781', 'sindresorhus-ky-880']);
    for (const each of cases) {
      const input = await caseInput(each);
      const { parts } = await reviewChange(input);
      const context = { items: claimItems(parts), description: input.pullRequest.description };
      for (const wanted of each.expected.claims) {
        const inFile = 'file' in wanted.origin ? wanted.origin : undefined;
        const answered = {
          source: inFile ? ('comment' as const) : ('description' as const),
          quote: wanted.text,
          file: inFile?.file ?? null,
          line: inFile?.line ?? null,
          part: inFile ? null : 'p1',
        };
        const { claims, problems } = locateClaims(context, { claims: [answered] });
        expect(problems, `${each.id}: ${wanted.text}`).toEqual([]);
        expect(claims[0]!.location, `${each.id}: ${wanted.text}`).toMatchObject({ line: wanted.origin.line });
      }
    }
  });

  it('each hold a required claim, so every case scores recall', async () => {
    const cases = (await loadCases([CASES])).filter((each) => each.record.prompts.includes('claims'));
    for (const each of cases) expect(each.expected.claims.some((wanted) => wanted.optional !== true), each.id).toBe(true);
  });
});

describe("the verdicts prompt's hand verdicts", () => {
  const CASES = fileURLToPath(new URL('../cases', import.meta.url));

  it('label claims every case locates where it says, each case holding one, across every verdict a pass can give', async () => {
    const cases = (await loadCases([CASES])).filter((each) => each.record.prompts.includes('verdicts'));
    expect(cases.map((each) => each.id)).toEqual([
      'canary-csharp',
      'canary-python',
      'encode-httpx-3690',
      'misstated-python',
      'pallets-click-3781',
      'sindresorhus-ky-880',
    ]);
    const kinds = new Set<string>();
    for (const each of cases) {
      const input = await caseInput(each);
      const { parts } = await reviewChange(input);
      const labelled = labelledClaims(parts, input.pullRequest.description, each.expected.claims);
      expect(labelled.length, each.id).toBeGreaterThan(0);
      for (const { wanted, claim } of labelled) {
        expect(claim.location, `${each.id}: ${wanted.text}`).toMatchObject({ line: wanted.origin.line });
        kinds.add(wanted.libraryFetch ? 'library' : wanted.verdict!.kind);
      }
    }
    expect([...kinds].sort()).toEqual(['library', 'refuted', 'verified']);
  });

  it('refuse a hand-labelled claim that is not where its case says', async () => {
    const [canary] = (await loadCases([CASES])).filter((each) => each.id === 'canary-python');
    const input = await caseInput(canary!);
    const { parts } = await reviewChange(input);
    const moved = canary!.expected.claims.map((wanted) => ({ ...wanted, origin: { file: 'app/missing.py', line: 9 } }));
    expect(() => labelledClaims(parts, input.pullRequest.description, moved)).toThrow('a hand-labelled claim is not where its case says');
  });
});
