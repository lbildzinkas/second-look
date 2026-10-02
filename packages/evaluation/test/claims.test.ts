import { describe, expect, it } from 'vitest';
import type { ReviewResult } from '@second-look/engine';
import { pressFetches, reportedClaims } from '../src/claims.js';
import type { LibraryFetchOffer, ReportedClaim } from '../src/claims.js';

const OFFER: LibraryFetchOffer = {
  library: 'httpx',
  pinnedVersion: '0.27.2',
  reason: 'the claim needs the library source to be checked',
};

describe('reportedClaims', () => {
  it('reports none while the review result carries no claims', () => {
    expect(reportedClaims({} as ReviewResult)).toEqual([]);
  });

  it('hands back the claims the result reports, skipping ones without text', () => {
    const result = { claims: [{ text: 'a claim' }, { text: '' }, 7] } as unknown as ReviewResult;
    expect(reportedClaims(result)).toEqual([{ text: 'a claim' }]);
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
