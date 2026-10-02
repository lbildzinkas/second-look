import { describe, expect, it } from 'vitest';
import { parseDiff } from '@second-look/engine';
import type { NoiseAssessment, Part } from '@second-look/engine';
import type { ExpectedClaim, ExpectedResults } from '../src/case.js';
import { pressFetches } from '../src/claims.js';
import type { PressedClaim } from '../src/claims.js';
import { addTallies, scoresOf, tallyCase } from '../src/score.js';

const DIFF = [
  'diff --git a/package-lock.json b/package-lock.json',
  'index 1111111..2222222 100644',
  '--- a/package-lock.json',
  '+++ b/package-lock.json',
  '@@ -1,2 +1,2 @@',
  '-"lockfileVersion": 2',
  '+"lockfileVersion": 3',
  ' {}',
  'diff --git a/src/cart.ts b/src/cart.ts',
  'index 3333333..4444444 100644',
  '--- a/src/cart.ts',
  '+++ b/src/cart.ts',
  '@@ -1,1 +1,2 @@',
  '-export const total = 1;',
  '+export const total = 2;',
  '+export const tax = 3;',
  'diff --git a/README.md b/README.md',
  'index 5555555..6666666 100644',
  '--- a/README.md',
  '+++ b/README.md',
  '@@ -1,1 +1,1 @@',
  '-old',
  '+new',
  '',
].join('\n');

const LOCKFILE: NoiseAssessment = {
  label: 'lockfile',
  rule: 'lockfile-name',
  state: 'claimed',
  blindSpot: 'x',
};
const NONE: NoiseAssessment = { label: 'none', note: 'no rule applied' };

/** The diff's parts, named after their paths and labelled as given. */
function parts(noise: Record<string, NoiseAssessment>): Part[] {
  return parseDiff(DIFF).files.map((part) => ({
    ...part,
    name: `top-level code in ${part.path}`,
    noise: noise[part.path] ?? NONE,
  }));
}

const EXPECTED: ExpectedResults = {
  noise: {
    'package-lock.json': { label: 'lockfile', state: 'claimed' },
    'src/cart.ts': { label: 'none' },
    'README.md': null,
  },
  importantParts: ['top-level code in src/cart.ts', 'README.md'],
  claims: [],
};

function byName(scores: ReturnType<typeof scoresOf>): Record<string, number> {
  return Object.fromEntries(scores.map((score) => [score.name, score.value]));
}

describe('tallyCase and scoresOf', () => {
  it('scores a result that matches the hand labels', () => {
    const tally = tallyCase(DIFF, EXPECTED, parts({ 'package-lock.json': LOCKFILE }));
    expect(byName(scoresOf(tally))).toEqual({
      coverage: 1,
      'noise-precision:lockfile:claimed': 1,
      'noise-recall:lockfile:claimed': 1,
      'noise-precision:none': 1,
      'noise-recall:none': 1,
      // cart.ts by its name at 2, README.md by its path at 3.
      'rank-median': 2.5,
      'rank-top-3': 1,
    });
  });

  it('gives precision and recall per class and state, skipping unlabelled files', () => {
    // The lockfile is missed: it reads as no rule applied.
    const tally = tallyCase(DIFF, EXPECTED, parts({}));
    const scores = byName(scoresOf(tally));
    expect(scores['noise-recall:lockfile:claimed']).toBe(0);
    expect(scores['noise-precision:lockfile:claimed']).toBeUndefined();
    expect(scores['noise-precision:none']).toBe(0.5);
    expect(scores['noise-recall:none']).toBe(1);
    // README.md is not labelled, so it counts in no noise score.
    expect(tally.noise.get('none')).toEqual({ expected: 1, predicted: 2, matched: 1 });
  });

  it('tells a confirmed label from a claimed one', () => {
    const confirmed: NoiseAssessment = { ...LOCKFILE, state: 'confirmed' };
    const scores = byName(scoresOf(tallyCase(DIFF, EXPECTED, parts({ 'package-lock.json': confirmed }))));
    expect(scores['noise-recall:lockfile:claimed']).toBe(0);
    expect(scores['noise-precision:lockfile:confirmed']).toBe(0);
  });

  it('counts only changed lines covered exactly once', () => {
    const [lockfile, cart] = parts({ 'package-lock.json': LOCKFILE });
    // README.md's two lines are missing; cart.ts's three lines are doubled.
    const tally = tallyCase(DIFF, EXPECTED, [lockfile!, cart!, cart!]);
    expect(tally.changedLines).toBe(7);
    expect(tally.coveredLines).toBe(2);
  });

  it('puts a missing important part after the last part', () => {
    const tally = tallyCase(
      DIFF,
      { noise: {}, importantParts: ['nowhere.ts', 'README.md'], claims: [] },
      parts({}),
    );
    expect(tally.positions).toEqual([4, 3]);
    expect(byName(scoresOf(tally))['rank-top-3']).toBe(0.5);
  });

  it('scores a failed review as covering nothing, and nothing else', () => {
    const scores = scoresOf(tallyCase(DIFF, EXPECTED, undefined));
    expect(scores).toEqual([{ name: 'coverage', value: 0, better: 'higher' }]);
  });

  it('adds tallies across cases, weighing every file and part alike', () => {
    const good = tallyCase(DIFF, EXPECTED, parts({ 'package-lock.json': LOCKFILE }));
    const bad = tallyCase(DIFF, EXPECTED, parts({}));
    const scores = byName(scoresOf(addTallies([good, bad])));
    expect(scores['noise-recall:lockfile:claimed']).toBe(0.5);
    expect(scores['noise-precision:none']).toBe(2 / 3);
    expect(scores['rank-median']).toBe(2.5);
    expect(scoresOf(addTallies([]))).toEqual([]);
  });

  it('marks lower as better only for the median position', () => {
    const scores = scoresOf(tallyCase(DIFF, EXPECTED, parts({})));
    for (const score of scores) {
      expect(score.better).toBe(score.name === 'rank-median' ? 'lower' : 'higher');
    }
  });
});

describe('the claim checks', () => {
  const CLAIM: ExpectedClaim = {
    text: 'Any redirect on the way is followed.',
    origin: { file: 'app/doc_links.py', line: 9 },
    library: { name: 'httpx', pinnedVersion: '0.27.2', pinnedBy: 'requirements.txt' },
    verdict: {
      kind: 'refuted',
      evidence: { file: 'httpx/_client.py', line: 171, source: 'library source at the pinned version' },
    },
    libraryFetch: true,
  };
  const OFFER = { library: 'httpx', pinnedVersion: '0.27.2', reason: 'needs the library source' };

  function expecting(claims: readonly ExpectedClaim[]): ExpectedResults {
    return { noise: {}, importantParts: [], claims: [...claims] };
  }

  it('marks the claim checks as expected failures while the review reports no claims', () => {
    const scores = scoresOf(tallyCase(DIFF, expecting([CLAIM]), parts({})));
    expect(byName(scores)).toMatchObject({
      'claims-found': 0,
      'claims-verdict:refuted': 0,
      'claims-evidence': 0,
      'claims-fetch-offered': 0,
    });
    const failing = scores.filter((score) => score.name.startsWith('claims'));
    expect(failing).toHaveLength(4);
    for (const score of failing) {
      expect(score.note).toBe('expected failure: the review reports no claims');
    }
  });

  it('scores a claim the review found, refuted with evidence behind a pressed fetch', () => {
    const pressed = pressFetches([
      {
        text: CLAIM.text,
        verdict: { kind: 'refuted', evidence: CLAIM.verdict.evidence },
        fetchOffer: OFFER,
      },
    ]);
    const scores = scoresOf(tallyCase(DIFF, expecting([CLAIM]), parts({}), pressed));
    expect(byName(scores)).toMatchObject({
      'claims-found': 1,
      'claims-verdict:refuted': 1,
      'claims-evidence': 1,
      'claims-fetch-offered': 1,
    });
    for (const score of scores.filter((each) => each.name.startsWith('claims'))) {
      expect(score.note).toBeUndefined();
    }
  });

  it('counts library-source evidence only behind a pressed fetch of the pinned library', () => {
    const unpressed: PressedClaim = {
      text: CLAIM.text,
      verdict: { kind: 'refuted', evidence: CLAIM.verdict.evidence },
    };
    const neverPressed: PressedClaim = { ...unpressed, fetchOffer: OFFER };
    const wrongPin: PressedClaim = {
      ...unpressed,
      pressedFetch: { ...OFFER, pinnedVersion: '0.28.0' },
    };
    for (const got of [unpressed, neverPressed, wrongPin]) {
      const scores = byName(scoresOf(tallyCase(DIFF, expecting([CLAIM]), parts({}), [got])));
      expect(scores['claims-evidence']).toBe(0);
      expect(scores['claims-fetch-offered']).toBe(0);
    }
  });

  it('scores each verdict kind in its own class, like the noise classes', () => {
    const expected: ExpectedClaim = {
      ...CLAIM,
      verdict: {
        kind: 'unverifiable',
        evidence: { file: 'app/doc_links.py', line: 3, source: 'the change itself' },
      },
    };
    const got: PressedClaim = { text: CLAIM.text, verdict: { kind: 'not checked' } };
    const scores = byName(scoresOf(tallyCase(DIFF, expecting([expected]), parts({}), [got])));
    expect(scores['claims-found']).toBe(1);
    expect(scores['claims-verdict:unverifiable']).toBe(0);
    expect(scores['claims-verdict:refuted']).toBeUndefined();
  });
});
