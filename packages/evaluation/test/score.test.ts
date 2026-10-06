import { describe, expect, it } from 'vitest';
import { parseDiff } from '@second-look/engine';
import type { AcceptanceCriterion, Claim, ClaimVerdict, DescribedChange, LinkedIssue, NoiseAssessment, Part, UnexplainedChanges } from '@second-look/engine';
import type { ExpectedClaim, ExpectedCriterion, ExpectedResults, ExpectedUnexplained } from '../src/case.js';
import type { PressedClaim } from '../src/claims.js';
import {
  addTallies,
  sameClaim,
  sameDescribed,
  scoresOf,
  tallyCase,
  tallyCriteria,
  tallyFinding,
  tallyJudging,
  tallyStory,
  tallyUnexplained,
  verdictBeforeFetch,
} from '../src/score.js';

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

  it('skips the rank scores when the result ranks fewer than three parts', () => {
    const [lockfile, cart] = parts({ 'package-lock.json': LOCKFILE });
    for (const small of [[lockfile!], [lockfile!, cart!]]) {
      const tally = tallyCase(DIFF, EXPECTED, small);
      expect(tally.positions).toEqual([]);
      const scores = byName(scoresOf(tally));
      expect(scores['rank-median']).toBeUndefined();
      expect(scores['rank-top-3']).toBeUndefined();
    }
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
    const pressed: PressedClaim[] = [
      {
        text: CLAIM.text,
        verdict: { kind: 'refuted', evidence: CLAIM.verdict!.evidence },
        fetchOffer: OFFER,
        pressedFetch: OFFER,
      },
    ];
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
      verdict: { kind: 'refuted', evidence: CLAIM.verdict!.evidence },
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

describe('the claims the agent lists', () => {
  const REDIRECT: ExpectedClaim = { text: 'Any redirect on the way is followed.', origin: { file: 'app/doc_links.py', line: 9 } };
  const RETURNS: ExpectedClaim = { text: 'Return the page as text.', origin: { file: 'app/doc_links.py', line: 7 } };
  const SUMMARY: ExpectedClaim = { text: 'Fetch pages over HTTP.', origin: { file: 'app/doc_links.py', line: 1 }, optional: true };
  const DESCRIBED: ExpectedClaim = { text: 'Redirects are followed.', origin: { in: 'description', line: 2 } };

  function listed(quote: string, path?: string): Claim {
    return {
      quote,
      source: path === undefined ? 'description' : 'docstring',
      location: path === undefined ? { kind: 'description', line: 2 } : { kind: 'file', path, line: 1, endLine: 1 },
      part: 0,
      verdict: { kind: 'not checked' },
    };
  }

  it('matches a listed claim made in the same place whose text holds the hand-listed one, or is held by it', () => {
    expect(sameClaim(listed('Any redirect on the way is followed.', 'app/doc_links.py'), REDIRECT)).toBe(true);
    expect(sameClaim(listed('Any redirect on the way is followed. Then  the page.', 'app/doc_links.py'), REDIRECT)).toBe(true);
    expect(sameClaim(listed('Any redirect', 'app/doc_links.py'), REDIRECT)).toBe(true);
    expect(sameClaim(listed('Any redirect on the way is followed.', 'app/other.py'), REDIRECT)).toBe(false);
    expect(sameClaim(listed('Any redirect on the way is followed.'), REDIRECT)).toBe(false);
    expect(sameClaim(listed('Redirects are followed.'), DESCRIBED)).toBe(true);
    expect(sameClaim(listed('Redirects are followed.', 'app/doc_links.py'), DESCRIBED)).toBe(false);
  });

  it('scores recall over the required claims, and precision over what was listed, an optional claim counting in neither', () => {
    const tally = tallyFinding(
      [REDIRECT, RETURNS, SUMMARY, DESCRIBED],
      [
        listed('Any redirect on the way is followed.', 'app/doc_links.py'),
        listed('Fetch pages over HTTP.', 'app/doc_links.py'),
        listed('Redirects are followed.'),
        listed('Never raises.', 'app/doc_links.py'),
      ],
    );
    expect(tally).toEqual({ required: 3, found: 2, listedRight: 2, listedWrong: 1 });

    const scores = byName(scoresOf({ ...tallyCase(DIFF, { noise: {}, importantParts: [], claims: [] }, undefined), finding: tally }));
    expect(scores['claims-recall']).toBe(2 / 3);
    expect(scores['claims-precision']).toBe(2 / 3);
  });

  it('gives no precision when nothing was listed, and no recall to a case with no required claim', () => {
    const none = byName(scoresOf({ ...tallyCase(DIFF, { noise: {}, importantParts: [], claims: [] }, undefined), finding: tallyFinding([REDIRECT], []) }));
    expect(none['claims-recall']).toBe(0);
    expect(none['claims-precision']).toBeUndefined();

    const optionalOnly = byName(
      scoresOf({ ...tallyCase(DIFF, { noise: {}, importantParts: [], claims: [] }, undefined), finding: tallyFinding([SUMMARY], [listed('Fetch pages over HTTP.', 'app/doc_links.py')]) }),
    );
    expect(optionalOnly['claims-recall']).toBeUndefined();
    expect(optionalOnly['claims-precision']).toBeUndefined();
  });

  it('adds the listing counts across cases, and leaves them out of the plain scores', () => {
    const one = { ...tallyCase(DIFF, { noise: {}, importantParts: [], claims: [] }, undefined), finding: tallyFinding([REDIRECT], []) };
    const two = { ...one, finding: tallyFinding([RETURNS], [listed('Return the page as text.', 'app/doc_links.py')]) };
    expect(addTallies([one, two]).finding).toEqual({ required: 2, found: 1, listedRight: 1, listedWrong: 0 });

    const plain = scoresOf(tallyCase(DIFF, { noise: {}, importantParts: [], claims: [REDIRECT, RETURNS] }, parts({})));
    expect(plain.filter((score) => score.name.startsWith('claims'))).toEqual([]);
  });
});

describe('the grouping agreement', () => {
  /** The diff's files with hunks, as parts that group them as given. */
  function grouped(groups: string[][], leftOut: string[] = []): Part[] {
    const files = parts({});
    const fileOf = (path: string) => files.find((file) => file.path === path)!;
    const partOf = (paths: string[], origin: Part['origin']): Part => {
      const [first, ...rest] = paths.map(fileOf);
      const others = rest.map(({ name: _name, ...file }) => file);
      return { ...first!, name: paths.join(' + '), origin, ...(others.length > 0 ? { otherFiles: others } : {}) };
    };
    return [
      ...groups.map((paths) => partOf(paths, 'agent')),
      ...leftOut.map((path) => partOf([path], 'not grouped by the agent')),
    ];
  }

  const LABELLED: ExpectedResults = {
    ...EXPECTED,
    groups: [['src/cart.ts#1', 'README.md#1'], ['package-lock.json#1']],
  };

  it('counts the labelled pairs the parts keep together or apart as the labels do', () => {
    const agreed = tallyCase(DIFF, LABELLED, grouped([['src/cart.ts', 'README.md'], ['package-lock.json']]));
    expect(agreed.pairs).toEqual({ total: 3, agreed: 3 });
    expect(byName(scoresOf(agreed))['grouping-agreement']).toBe(1);
    // Parts across files still cover every changed line exactly once.
    expect(byName(scoresOf(agreed))['coverage']).toBe(1);

    const apart = tallyCase(DIFF, LABELLED, grouped([['src/cart.ts'], ['README.md'], ['package-lock.json']]));
    expect(apart.pairs).toEqual({ total: 3, agreed: 2 });

    const merged = tallyCase(DIFF, LABELLED, grouped([['src/cart.ts', 'README.md', 'package-lock.json']]));
    expect(merged.pairs).toEqual({ total: 3, agreed: 1 });
  });

  it('counts each hunk the agent left out as a part of its own', () => {
    const tally = tallyCase(DIFF, LABELLED, grouped([['package-lock.json']], ['src/cart.ts', 'README.md']));
    expect(tally.pairs).toEqual({ total: 3, agreed: 2 });
  });

  it('reads the noise of every file of a part across files, and finds an important file in it', () => {
    const tally = tallyCase(DIFF, EXPECTED, grouped([['src/cart.ts', 'package-lock.json'], ['README.md']]));
    // The lockfile sits in the cart part's further files, where it reads as
    // no rule applied: a none prediction beside cart.ts's own.
    expect(tally.noise.get('none')).toEqual({ expected: 1, predicted: 2, matched: 1 });
    // Two parts are too few for the rank tally to count anything.
    expect(tally.positions).toEqual([]);
    // With a left-out hunk making a third part, the tally runs and finds a
    // file inside a part across files by its path.
    const ranked = tallyCase(
      DIFF,
      { noise: {}, importantParts: ['src/cart.ts'], claims: [] },
      grouped([['src/cart.ts', 'package-lock.json'], ['README.md']], ['package-lock.json']),
    );
    expect(ranked.positions).toEqual([1]);
  });

  it('gives no agreement score to a case without labelled groups', () => {
    expect(byName(scoresOf(tallyCase(DIFF, EXPECTED, parts({}))))['grouping-agreement']).toBeUndefined();
  });
});

describe('the story checks', () => {
  const checks = {
    mustReview: { ids: ['p1', 'p2'], mentioned: ['p1'] },
    mentionOrder: ['p1', 'p3'],
    inOrder: true,
    names: { used: ['fresh', 'web/cart.ts', 'app/totals.py', 'fresh'], outside: ['app/totals.py'] },
  };
  const story = (written: boolean) => ({ ...tallyCase(DIFF, { noise: {}, importantParts: [], claims: [] }, undefined), story: tallyStory(checks, written) });
  const storyScores = (tally: ReturnType<typeof story>) =>
    Object.fromEntries(scoresOf(tally).filter((score) => score.name.startsWith('story-')).map((score) => [score.name, score.value]));

  it('scores the must-review parts linked, the reading order, and the names the change shows', () => {
    expect(storyScores(story(true))).toEqual({ 'story-must-review': 0.5, 'story-order': 1, 'story-names': 0.75 });
  });

  it('fails a story that was not written on the must-review parts and the order', () => {
    const notWritten = { ...story(false), story: tallyStory({ ...checks, mustReview: { ids: ['p1', 'p2'], mentioned: [] }, mentionOrder: [], names: { used: [], outside: [] } }, false) };
    expect(storyScores(notWritten)).toEqual({ 'story-must-review': 0, 'story-order': 0 });
  });

  it('adds the story counts across cases', () => {
    expect(storyScores(addTallies([story(true), story(false)]))).toEqual({ 'story-must-review': 0.25, 'story-order': 0.5, 'story-names': 0.75 });
  });

  it('gives a case without a story no story score', () => {
    expect(storyScores({ ...story(true), story: tallyCase(DIFF, { noise: {}, importantParts: [], claims: [] }, undefined).story })).toEqual({});
  });
});

describe('the verdicts the agent gives', () => {
  const evidence = { file: 'app/x.py', line: 3, source: 'the change itself' as const };
  const verified: ExpectedClaim = { text: 'Returns the page.', origin: { file: 'app/x.py', line: 1 }, verdict: { kind: 'verified', evidence } };
  const refuted: ExpectedClaim = { text: 'Pads on the right.', origin: { in: 'description', line: 1 }, verdict: { kind: 'refuted', evidence } };
  const library: ExpectedClaim = {
    text: 'Redirects are followed.',
    origin: { file: 'app/x.py', line: 2 },
    library: { name: 'httpx', pinnedVersion: '0.27.2', pinnedBy: 'requirements.txt' },
    verdict: { kind: 'refuted', evidence: { file: 'httpx/_client.py', line: 171, source: 'library source at the pinned version' } },
    libraryFetch: true,
  };
  const got = (kind: 'verified' | 'refuted' | 'unverifiable', needsLibrary?: string): ClaimVerdict => ({
    kind,
    source: 'the change itself',
    reason: 'r',
    evidence: [],
    ...(needsLibrary ? { needsLibrary } : {}),
  });

  it('deserve the hand verdict, except that a claim checked behind a library fetch is unverifiable before it, naming the library', () => {
    expect(verdictBeforeFetch(verified)).toEqual({ kind: 'verified' });
    expect(verdictBeforeFetch(library)).toEqual({ kind: 'unverifiable', library: 'httpx' });
    expect(verdictBeforeFetch({ text: 't', origin: { file: 'a', line: 1 } })).toBeUndefined();
  });

  it('score their accuracy and the share of claims not deserving verified that were verified', () => {
    const tally = tallyJudging([
      { wanted: verified, got: got('verified') },
      { wanted: refuted, got: got('verified') },
      { wanted: library, got: got('unverifiable', 'HTTPX') },
      { wanted: { text: 'unlabelled', origin: { file: 'a', line: 1 } }, got: got('verified') },
    ]);
    expect(tally).toEqual({ labelled: 3, right: 2, notVerified: 2, falseVerified: 1 });
    const scores = scoresOf({ ...tallyCase('', { noise: {}, importantParts: [], claims: [] }, undefined), judging: tally });
    expect(scores).toEqual([
      { name: 'verdict-accuracy', value: 2 / 3, better: 'higher' },
      { name: 'false-verified', value: 0.5, better: 'lower' },
    ]);
  });

  it('miss a library claim whose verdict names no library or another one, and a claim left not checked', () => {
    expect(tallyJudging([{ wanted: library, got: got('unverifiable') }]).right).toBe(0);
    expect(tallyJudging([{ wanted: library, got: got('unverifiable', 'requests') }]).right).toBe(0);
    expect(tallyJudging([{ wanted: refuted, got: { kind: 'not checked' } }])).toEqual({ labelled: 1, right: 0, notVerified: 1, falseVerified: 0 });
  });
});

describe('the criteria verdicts the agent gives', () => {
  const LABELS: ExpectedCriterion[] = [
    { text: 'A send  that fails is retried.', verdict: 'met', code: ['app/retry.py'], tests: ['tests/test_retry.py'], manual: [{ text: 'Tested by hand: the third retry gave up.', line: 3 }] },
    { text: 'Each retry is logged.', verdict: 'partly met', alsoRight: ['not met'], code: ['app/retry.py', 'app/log.py'] },
    { text: 'Retries take no longer than a second.', verdict: "can't tell" },
  ];

  const mapped = (kind: 'met' | 'not met' | "can't tell", evidence: Partial<{ code: string[]; tests: string[]; manual: string[] }> = {}): AcceptanceCriterion['verdict'] => ({
    kind,
    reason: 'r',
    code: (evidence.code ?? []).map((path) => ({ path, line: 1, quote: 'x' })),
    tests: (evidence.tests ?? []).map((path) => ({ path, line: 1, quote: 'x' })),
    manualChecks: (evidence.manual ?? []).map((quote) => ({ quote, line: 3 })),
  });

  const criterion = (quote: string, verdict: AcceptanceCriterion['verdict']): AcceptanceCriterion => ({ quote, issue: 0, line: 1, verdict });

  it('counts a verdict the labels accept as right, a met one they do not accept as false, and the labelled evidence the verdicts cite', () => {
    const tally = tallyCriteria(LABELS, [
      criterion('A send that fails is retried.', mapped('met', { code: ['app/retry.py'], tests: ['tests/other.py'], manual: ['the third retry gave up.'] })),
      criterion('Each retry is logged.', mapped('not met', { code: ['app/log.py'] })),
      criterion('Retries take no longer than a second.', mapped('met', { code: ['app/retry.py'] })),
    ]);

    expect(tally).toEqual({
      labelled: 3,
      right: 2,
      notMet: 2,
      falseMet: 1,
      codeFiles: 3,
      codeCited: 2,
      testFiles: 1,
      testsCited: 0,
      manualChecks: 1,
      manualCited: 1,
    });
    const scores = byName(scoresOf({ ...tallyCase(DIFF, { noise: {}, importantParts: [], claims: [] }, undefined), criteria: tally }));
    expect(scores['criteria-accuracy']).toBeCloseTo(2 / 3);
    expect(scores['criteria-false-met']).toBe(0.5);
    expect(scores['criteria-code-recall']).toBeCloseTo(2 / 3);
    expect(scores['criteria-tests-recall']).toBe(0);
    expect(scores['criteria-manual-recall']).toBe(1);
  });

  it('counts a criterion left not checked, or not read, as wrong and citing nothing, and the plain pass gives no criteria score', () => {
    const tally = tallyCriteria(LABELS, [criterion('A send that fails is retried.', { kind: 'not checked' })]);
    expect(tally).toMatchObject({ labelled: 3, right: 0, falseMet: 0, codeCited: 0, manualCited: 0 });
    expect(addTallies([{ ...tallyCase(DIFF, { noise: {}, importantParts: [], claims: [] }, undefined), criteria: tally }]).criteria).toEqual(tally);

    const plain = scoresOf(tallyCase(DIFF, { ...EXPECTED, criteria: LABELS }, parts({})));
    expect(plain.filter((score) => score.name.startsWith('criteria-'))).toEqual([]);
  });
});

describe('the unexplained changes the agent finds', () => {
  const ISSUES: LinkedIssue[] = [
    { number: 30, title: 't', url: 'https://github.com/example-org/example-repo/issues/30', repository: 'example-org/example-repo', body: 'b', link: 'closes' },
  ];
  const EXPECTED_UNEXPLAINED: ExpectedUnexplained = {
    parts: ['src/cart.ts'],
    optionalParts: ['top-level code in README.md'],
    described: [
      { text: 'Each retry is logged.', origin: { in: 'description', line: 3 } },
      { text: 'A send that gives up goes to the dead-letter queue.', origin: { issue: 30, line: 5 } },
      { text: 'Retries are configurable.', origin: { in: 'description', line: 4 }, optional: true },
    ],
  };

  function described(quote: string, location: DescribedChange['location']): DescribedChange {
    return { quote, location, reason: 'r' };
  }

  function found(flagged: number[], listed: DescribedChange[]): UnexplainedChanges {
    return { promptVersion: '1', outcome: 'compared', detail: 'd', parts: flagged.map((part) => ({ part, reason: 'r' })), described: listed };
  }

  it('matches a described change made in the same place, the same issue by its number, whose text holds the label or is held by it', () => {
    const [logged, queued] = EXPECTED_UNEXPLAINED.described as [ExpectedUnexplained['described'][number], ExpectedUnexplained['described'][number]];
    expect(sameDescribed(described('Each retry is logged.', { kind: 'description', line: 3 }), logged, ISSUES)).toBe(true);
    expect(sameDescribed(described('retry is logged', { kind: 'description', line: 9 }), logged, ISSUES)).toBe(true);
    expect(sameDescribed(described('Each retry is logged.', { kind: 'issue', issue: 0, line: 3 }), logged, ISSUES)).toBe(false);
    expect(sameDescribed(described('- [ ] A send that gives up goes to the dead-letter queue.', { kind: 'issue', issue: 0, line: 5 }), queued, ISSUES)).toBe(true);
    expect(sameDescribed(described('A send that gives up goes to the dead-letter queue.', { kind: 'issue', issue: 1, line: 5 }), queued, ISSUES)).toBe(false);
  });

  it('scores recall and precision in each direction, an optional label counting in neither', () => {
    // parts(): package-lock.json, src/cart.ts, README.md.
    const tally = tallyUnexplained(
      EXPECTED_UNEXPLAINED,
      parts({}),
      ISSUES,
      found([0, 1, 2], [described('Each retry is logged.', { kind: 'description', line: 3 }), described('Retries are configurable.', { kind: 'description', line: 4 }), described('Adds a flag.', { kind: 'description', line: 1 })]),
    );
    expect(tally).toEqual({ requiredParts: 1, foundParts: 1, flaggedRight: 1, flaggedWrong: 1, requiredDescribed: 2, foundDescribed: 1, listedRight: 1, listedWrong: 1 });

    const scores = byName(scoresOf({ ...tallyCase(DIFF, { noise: {}, importantParts: [], claims: [] }, undefined), unexplained: tally }));
    expect(scores['unexplained-recall']).toBe(1);
    expect(scores['unexplained-precision']).toBe(0.5);
    expect(scores['described-recall']).toBe(0.5);
    expect(scores['described-precision']).toBe(0.5);
  });

  it('gives no precision when nothing was flagged, adds the counts across cases, and leaves them out of the plain scores', () => {
    const none = { ...tallyCase(DIFF, { noise: {}, importantParts: [], claims: [] }, undefined), unexplained: tallyUnexplained(EXPECTED_UNEXPLAINED, parts({}), ISSUES, found([], [])) };
    const scores = byName(scoresOf(none));
    expect(scores['unexplained-recall']).toBe(0);
    expect(scores['described-recall']).toBe(0);
    expect(scores['unexplained-precision']).toBeUndefined();
    expect(scores['described-precision']).toBeUndefined();
    expect(addTallies([none, none]).unexplained).toMatchObject({ requiredParts: 2, requiredDescribed: 4 });

    const plain = scoresOf(tallyCase(DIFF, { ...EXPECTED, unexplained: EXPECTED_UNEXPLAINED }, parts({})));
    expect(plain.filter((score) => score.name.includes('unexplained') || score.name.startsWith('described'))).toEqual([]);
  });
});
