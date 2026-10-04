import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { claimItems, locateClaims, reviewChange } from '@second-look/engine';
import type { ReviewResult } from '@second-look/engine';
import { caseInput, loadCases } from '../src/case.js';
import { pressFetches, reportedClaims } from '../src/claims.js';
import type { LibraryFetchOffer, ReportedClaim } from '../src/claims.js';

const OFFER: LibraryFetchOffer = {
  library: 'httpx',
  pinnedVersion: '0.27.2',
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
});

describe('pressFetches', () => {
  it('presses every offered fetch, as the reviewer would', () => {
    const offered: ReportedClaim = { text: 'a claim', fetchOffer: OFFER };
    const withoutOffer: ReportedClaim = { text: 'another claim' };
    expect(pressFetches([offered, withoutOffer])).toEqual([
      { text: 'a claim', fetchOffer: OFFER, pressedFetch: OFFER },
      { text: 'another claim', pressedFetch: undefined },
    ]);
  });

  it('keeps the pressed claim independent of the offer it pressed', () => {
    const [pressed] = pressFetches([{ text: 'a claim', fetchOffer: OFFER }]);
    pressed!.pressedFetch!.library = 'mutated';
    expect(OFFER.library).toBe('httpx');
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
