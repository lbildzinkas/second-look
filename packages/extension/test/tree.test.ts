import { describe, expect, it } from 'vitest';
import { NO_MARKS, applyMark, changePieces, markedPart, type AgentGrouping, type AgentRanking, type FileSlice, type Hunk, type Part, type ReviewedMarks, type ReviewResult, type SinceLastLook } from '@second-look/engine';
import {
  anchorOf,
  buildTree,
  CHANGED_SINCE_LAST_LOOK,
  CHANGED_SINCE_MARKED,
  claimCountText,
  findingBadge,
  findAnchor,
  NOISE,
  NOT_RANKED_YET,
  partsInReadingOrder,
  reviewBadge,
  reviewStatus,
  sinceLastLookLine,
  treeMessage,
  UNEXPLAINED_BADGE,
} from '../src/tree.js';
import { claimsResult, judgedResult, mixedResult, part, result, unexplainedResult } from './results.js';
import type { TreeFilter, TreePart } from '../src/tree.js';

/** A hunk adding one line at the given place, on both sides. */
function hunkAt(oldStart: number, newStart: number): Hunk {
  return {
    oldStart,
    oldLines: 0,
    newStart,
    newLines: 1,
    lines: [{ kind: 'addition', newLineNumber: newStart, text: 'added' }],
    entities: [],
  };
}

/** One file's share of a part across files. */
function slice(path: string, hunks: Hunk[], overrides: Partial<FileSlice> = {}): FileSlice {
  const { name: _name, signals: _signals, ...file } = part(path, { hunks });
  return { ...file, ...overrides };
}

const STAMP = {
  agent: 'pi',
  agentVersion: '0.86.1',
  model: 'zai/glm-4.6',
  effort: null,
  runAt: '2026-10-02T00:00:00.000Z',
};

function agentGrouping(overrides: Partial<AgentGrouping>): AgentGrouping {
  return { promptVersion: '1', outcome: 'grouped', detail: 'every hunk was placed by the agent', leftOut: 0, stamp: STAMP, ...overrides };
}

function agentRanking(overrides: Partial<AgentRanking>): AgentRanking {
  return { promptVersion: '1', outcome: 'ranked', detail: 'the validator accepted the ranking of 4 parts', stamp: STAMP, ...overrides };
}

describe('buildTree', () => {
  it('shows the importance groups in order, with the reason beside each part and the signals in its tooltip', () => {
    const sections = buildTree(mixedResult());

    expect(sections.map((section) => section.label)).toEqual([
      'Must review',
      'Worth reviewing',
      'Context',
      NOT_RANKED_YET,
      NOISE,
    ]);

    const mustReview = sections[0]!;
    expect(mustReview.parts).toHaveLength(1);
    expect(mustReview.parts[0]!.label).toBe('src/retry.py');
    expect(mustReview.parts[0]!.description).toBe(
      'New code the send path now runs on every delivery.',
    );
    expect(mustReview.parts[0]!.tooltip).toBe(
      'new code\n2 callers\nno tests before this pull request\nPlain ranking',
    );
    expect(mustReview.parts[0]!.kind).toBe('part');
  });

  it('shows parts the engine has not ranked in a plain section above the noise', () => {
    const sections = buildTree(mixedResult());

    const notRanked = sections[3]!;
    expect(notRanked.label).toBe(NOT_RANKED_YET);
    expect(notRanked.parts.map((part) => part.label)).toEqual([
      'src/legacy.ts',
      '__tests__/retry.test.ts.snap',
    ]);
  });

  it('keeps snapshots and fixtures above the noise, with their label and state in the tooltip', () => {
    const sections = buildTree(mixedResult());

    const snapshot = sections[3]!.parts[1]!;
    expect(snapshot.label).toBe('__tests__/retry.test.ts.snap');
    expect(snapshot.kind).toBe('part');
    expect(snapshot.tooltip).toBe(
      'snapshot · claimed — Only known snapshot names are matched.',
    );
    expect(sections[4]!.parts.map((part) => part.label)).not.toContain(
      '__tests__/retry.test.ts.snap',
    );
  });

  it('sinks the noise last, with its label and confirmed or claimed state beside it', () => {
    const sections = buildTree(mixedResult());

    expect(sections.at(-1)!.label).toBe(NOISE);
    expect(
      sections.at(-1)!.parts.map((node) => ({
        label: node.label,
        description: node.description,
        tooltip: node.tooltip,
        kind: node.kind,
      })),
    ).toEqual([
      {
        label: 'uv.lock',
        description: 'lockfile · claimed',
        tooltip: 'Only known lockfile names are matched.',
        kind: 'noise',
      },
      {
        label: 'transport.py',
        description: 'moved or renamed · confirmed',
        tooltip: 'Identical content proves only the move.',
        kind: 'noise',
      },
    ]);
    // Every row carries the part it opens in the diff editor.
    expect(
      sections
        .at(-1)!
        .parts.map((node) => ('part' in node ? node.part : undefined)),
    ).toEqual(mixedResult().parts.slice(5));
  });

  it('gives every reading part its payload, but the placeholder none', () => {
    const sections = buildTree(mixedResult());

    const every = [...sections.flatMap((section) => section.parts)];
    expect(every).toHaveLength(7);
    expect(every.every((node) => 'part' in node && node.part?.path === node.label)).toBe(true);
  });

  it('lists the parts in the order the reviewer reads them, noise last', () => {
    const reading = partsInReadingOrder(mixedResult());

    expect(reading.map((part) => part.path)).toEqual([
      'src/retry.py',
      'src/settings.ts',
      'CHANGELOG.md',
      'src/legacy.ts',
      '__tests__/retry.test.ts.snap',
      'uv.lock',
      'transport.py',
    ]);
  });

  it('leaves empty sections out and keeps the order of the ones that remain', () => {
    const sections = buildTree(
      result([
        part('docs/notes.md', {
          rank: { importance: 'context', reason: 'Release note only.', signals: ['documentation only'] },
        }),
        part('package-lock.json', {
          noise: {
            label: 'lockfile',
            rule: 'lockfile-name',
            state: 'confirmed',
            blindSpot: 'Only known lockfile names are matched.',
          },
        }),
      ]),
    );

    expect(sections.map((section) => section.label)).toEqual(['Context', NOISE]);
  });

  it('shows every part of an unranked result in the plain section, until ranking lands', () => {
    const sections = buildTree(
      result([part('src/one.ts'), part('src/two.ts'), part('src/three.ts')]),
    );

    expect(sections.map((section) => section.label)).toEqual([NOT_RANKED_YET]);
    expect(sections[0]!.parts.map((part) => part.label)).toEqual([
      'src/one.ts',
      'src/two.ts',
      'src/three.ts',
    ]);
    expect(sections[0]!.parts[0]!.description).toBeUndefined();
  });

  it('returns no sections for a result with no parts', () => {
    expect(buildTree(result([]))).toEqual([]);
  });
});

describe('claim counts in the tree', () => {
  it('shows each part its claim count beside the label, and in the tooltip that none is checked yet', () => {
    const [mustReview, worthReviewing, context] = buildTree(claimsResult());

    expect(mustReview!.parts[0]).toMatchObject({
      claims: 3,
      description: '3 claims · New code the send path now runs on every delivery.',
      tooltip: 'new code\n2 callers\nno tests before this pull request\nPlain ranking\n3 claims, not checked yet; the overview lists them',
    });
    expect(worthReviewing!.parts[0]).toMatchObject({ claims: 1, description: '1 claim · Changed code that the retry policy reads.' });
    expect(context!.parts[0]).not.toHaveProperty('claims');
    expect(context!.parts[0]!.description).toBe('Release note only.');
  });

  it('counts nothing before the claims arrive, or when they fell back', () => {
    const shown = claimsResult();
    const fellBack = { ...shown, claims: { ...shown.claims!, outcome: 'fell back' as const, claims: [] } };
    for (const each of [mixedResult(), fellBack]) {
      const nodes = buildTree(each).flatMap((section) => section.parts);
      expect(nodes.every((node) => !('claims' in node))).toBe(true);
    }
  });

  it('says the count in words', () => {
    expect([claimCountText(1), claimCountText(2)]).toEqual(['1 claim', '2 claims']);
    expect([findingBadge(1), findingBadge(2)]).toEqual(['⚠ 1 finding', '⚠ 2 findings']);
  });

  it('badges each part with its findings once the claims are judged', () => {
    const [mustReview, worthReviewing] = buildTree(judgedResult());

    expect(mustReview!.parts[0]).toMatchObject({
      claims: 3,
      findings: 2,
      description: '⚠ 2 findings · 3 claims · New code the send path now runs on every delivery.',
    });
    expect(mustReview!.parts[0]!.tooltip).toContain('3 claims, 2 refuted or unverifiable, each a thread on the diff; the overview lists them');
    expect(worthReviewing!.parts[0]).toMatchObject({ claims: 1, findings: 1, description: '⚠ 1 finding · 1 claim · Changed code that the retry policy reads.' });
  });

  it('badges no part whose judged claims are all verified', () => {
    const shown = judgedResult();
    const [verified] = shown.claims!.claims;
    const allVerified = { ...shown, claims: { ...shown.claims!, claims: [verified!] } };
    const [mustReview] = buildTree(allVerified);
    expect(mustReview!.parts[0]).not.toHaveProperty('findings');
    expect(mustReview!.parts[0]!.description).toBe('1 claim · New code the send path now runs on every delivery.');
    expect(mustReview!.parts[0]!.tooltip).toContain('1 claim, all verified; the overview lists them');
  });
});

describe('unexplained parts in the tree', () => {
  it('badges a part neither the description nor a linked issue explains, with its reason in the tooltip', () => {
    const [mustReview, worthReviewing] = buildTree(unexplainedResult());
    const reason = 'Raises the timeout from 10 to 30 seconds, which <b>nothing</b> mentions.';

    expect(worthReviewing!.parts[0]).toMatchObject({
      unexplained: reason,
      description: `${UNEXPLAINED_BADGE} · Changed code that the retry policy reads.`,
    });
    expect((worthReviewing!.parts[0] as { tooltip: string }).tooltip.split('\n').at(-1)).toBe(`Unexplained: ${reason}`);
    expect(mustReview!.parts[0]).not.toHaveProperty('unexplained');
  });

  it('badges nothing before the comparison arrives, or when it fell back or had nothing to compare with', () => {
    const shown = unexplainedResult();
    const fellBack = { ...shown, unexplained: { ...shown.unexplained!, outcome: 'fell back' as const, parts: [], described: [] } };
    for (const each of [mixedResult(), fellBack]) {
      const nodes = buildTree(each).flatMap((section) => section.parts);
      expect(nodes.every((node) => !('unexplained' in node))).toBe(true);
    }
  });
});

describe('parts across files', () => {
  const across = part('app/fresh.py', {
    name: 'fresh, with its test',
    hunks: [hunkAt(0, 1)],
    origin: 'agent',
    otherFiles: [slice('tests/test_fresh.py', [hunkAt(0, 1)], {
      noise: { label: 'fixture', rule: 'fixture-path', state: 'claimed', blindSpot: 'Only fixture folders are matched.' },
    })],
    rank: { importance: 'must review', reason: 'new code', signals: ['new code'] },
  });

  it('labels a part by its name and lists its files and their labels in the tooltip', () => {
    const [section] = buildTree(result([across]));
    expect(section!.parts[0]).toMatchObject({
      label: 'fresh, with its test',
      tooltip: [
        'new code',
        'Plain ranking',
        'across app/fresh.py, tests/test_fresh.py',
        'tests/test_fresh.py: fixture · claimed — Only fixture folders are matched.',
      ].join('\n'),
    });
  });

  it('finds the part that now holds the first hunk of the part the reviewer was on', () => {
    const plain = part('tests/test_fresh.py', { hunks: [hunkAt(0, 1)] });
    const regrouped = buildTree(result([part('src/other.py', { hunks: [hunkAt(3, 3)] }), across]));

    expect(anchorOf(plain)).toEqual({ path: 'tests/test_fresh.py', hunk: { oldStart: 0, newStart: 1 } });
    expect(findAnchor(regrouped, anchorOf(plain))?.part).toBe(across);
    expect(findAnchor(regrouped, { path: 'gone.py', hunk: { oldStart: 1, newStart: 1 } })).toBeUndefined();
    // A file without hunks, such as a binary, is found by its path alone.
    const binary = part('assets/logo.png', { isBinary: true });
    expect(findAnchor(buildTree(result([binary])), anchorOf(binary))?.part).toBe(binary);
  });
});

describe('reviewStatus', () => {
  it('names the stage still running while the plain parts show', () => {
    expect(reviewStatus(mixedResult(), 'grouping related hunks with pi')).toBe(
      'Plain parts shown; grouping related hunks with pi…',
    );
  });

  it('says who grouped the parts, with the model and the prompt version', () => {
    const grouped = { ...mixedResult(), grouping: { by: 'agent' as const, agent: agentGrouping({}) } };
    expect(reviewStatus(grouped)).toBe(
      'Grouped by pi · zai/glm-4.6 (grouping prompt v1): every hunk was placed by the agent.',
    );
  });

  it('says why the plain grouping stayed', () => {
    const agent = agentGrouping({ outcome: 'fell back', detail: 'the agent gave no usable answer (timeout: too slow)' });
    expect(reviewStatus({ ...mixedResult(), grouping: { by: 'plain', agent } })).toBe(
      'Plain grouping kept: the agent gave no usable answer (timeout: too slow).',
    );
  });

  it('shows no line when the agent was never asked', () => {
    expect(reviewStatus(mixedResult())).toBeUndefined();
  });

  it('names the ranking stage after the grouping it ranks', () => {
    const grouped = { ...mixedResult(), grouping: { by: 'agent' as const, agent: agentGrouping({}) } };
    expect(reviewStatus(grouped, 'ranking the parts with pi')).toBe(
      'Grouped by pi · zai/glm-4.6 (grouping prompt v1): every hunk was placed by the agent. Now ranking the parts with pi…',
    );
  });

  it('says who ranked the parts, or why the plain ranking stayed', () => {
    const ranked = { ...mixedResult(), ranking: { by: 'agent' as const, agent: agentRanking({}) } };
    expect(reviewStatus(ranked)).toBe(
      'Ranked by pi · zai/glm-4.6 (ranking prompt v1): the validator accepted the ranking of 4 parts.',
    );
    const notTested = agentRanking({ outcome: 'not tested', detail: 'pi has none', stamp: undefined });
    expect(reviewStatus({ ...mixedResult(), ranking: { by: 'plain', agent: notTested } })).toBe(
      'Plain ranking kept: pi has none.',
    );
  });
});

describe('the ranking a tooltip names', () => {
  it("names the agent ranking, with its model and prompt version, on every ranked part's tooltip", () => {
    const ranked = { ...mixedResult(), ranking: { by: 'agent' as const, agent: agentRanking({}) } };
    const mustReview = buildTree(ranked)[0]!;

    expect(mustReview.parts[0]!.tooltip).toBe(
      'new code\n2 callers\nno tests before this pull request\nAgent ranking: pi · zai/glm-4.6 (ranking prompt v1)',
    );
  });

  it('names the plain ranking when the agent ranking fell back', () => {
    const fellBack = { ...mixedResult(), ranking: { by: 'plain' as const, agent: agentRanking({ outcome: 'fell back' }) } };
    expect(buildTree(fellBack)[0]!.parts[0]!.tooltip).toMatch(/\nPlain ranking$/);
  });
});

describe('reviewed marks in the tree', () => {
  const NOW = new Date('2026-10-06T12:00:00Z');
  const cart = part('web/cart.ts', { name: 'Cart.total in web/cart.ts', hunks: [hunkAt(10, 10)] });
  const money = part('web/money.ts', { name: 'top-level code in web/money.ts', hunks: [hunkAt(1, 1)] });

  function marked(...parts: Part[]): ReviewedMarks {
    return parts.reduce((marks, each) => applyMark(marks, markedPart(each), true, NOW), NO_MARKS);
  }

  function nodes(marks: ReviewedMarks, parts: Part[] = [cart, money]): TreePart[] {
    return buildTree(result(parts), marks)
      .flatMap((section) => section.parts)
      .filter((node): node is TreePart => node.kind !== 'comment');
  }

  it('gives every part its reviewed state for its checkbox', () => {
    expect(nodes(NO_MARKS).map((node) => node.reviewed)).toEqual(['not reviewed', 'not reviewed']);
    expect(nodes(marked(cart)).map((node) => node.reviewed)).toEqual(['reviewed', 'not reviewed']);
  });

  it('says a part changed since it was marked, beside its label and in its tooltip', () => {
    const edited = { ...cart, hunks: [{ ...hunkAt(10, 10), lines: [{ kind: 'addition' as const, newLineNumber: 10, text: 'edited' }] }] };
    const [node, other] = nodes(marked(cart, money), [edited, money]);

    expect(node!.reviewed).toBe('changed since marked');
    expect(node!.description).toBe(CHANGED_SINCE_MARKED);
    expect(node!.tooltip).toContain('its content changed since you marked it reviewed');
    expect(other!.reviewed).toBe('reviewed');
    expect(other!.description).toBeUndefined();
  });

  it('leaves a part whose lines only moved reviewed', () => {
    const moved = { ...cart, hunks: [hunkAt(30, 30)] };

    expect(nodes(marked(cart), [moved, money])[0]!.reviewed).toBe('reviewed');
  });

  it('counts the parts left to review in the view badge, and shows none once all are reviewed', () => {
    expect(reviewBadge(result([cart, money]), NO_MARKS)).toEqual({ value: 2, tooltip: '2 of 2 parts left to review' });
    expect(reviewBadge(result([cart, money]), marked(cart))).toEqual({ value: 1, tooltip: '1 of 2 parts left to review' });
    expect(reviewBadge(result([cart, money]), marked(cart, money))).toBeUndefined();
  });
});

describe('since your last look in the tree', () => {
  const LOOKED = 'abcdef0123456789abcdef0123456789abcdef01';
  const cart = part('web/cart.ts', { name: 'Cart.total in web/cart.ts', hunks: [hunkAt(10, 10)] });
  const money = part('web/money.ts', { name: 'top-level code in web/money.ts', hunks: [hunkAt(1, 1)] });

  /** The review with cart changed since a look at the given commit, from where it was recorded. */
  function since(overrides: Partial<SinceLastLook> = {}): ReviewResult {
    return {
      ...result([cart, money]),
      sinceLastLook: { commit: LOOKED, from: 'local record', at: '2026-10-01T09:00:00.000Z', outcome: 'compared', changed: changePieces(cart), ...overrides },
    };
  }

  function nodes(review: ReviewResult, filter: TreeFilter = {}, marks: ReviewedMarks = NO_MARKS): TreePart[] {
    return buildTree(review, marks, filter)
      .flatMap((section) => section.parts)
      .filter((node): node is TreePart => node.kind !== 'comment');
  }

  it('flags the parts changed since the last look, beside the label and in the tooltip with its commit', () => {
    const [changed, same] = nodes(since());

    expect(changed!.changedSinceLastLook).toBe(true);
    expect(changed!.description).toBe(CHANGED_SINCE_LAST_LOOK);
    expect(changed!.tooltip).toBe('Changed since your last look at abcdef0.');
    expect(same!.changedSinceLastLook).toBeUndefined();
    expect(same!.description).toBeUndefined();
  });

  it('shows only the changed parts when filtered, and every part without a last look', () => {
    expect(nodes(since(), { onlyChangedSinceLastLook: true }).map((node) => node.label)).toEqual(['Cart.total in web/cart.ts']);
    expect(nodes(since({ changed: [] }), { onlyChangedSinceLastLook: true })).toEqual([]);
    expect(nodes(result([cart, money]), { onlyChangedSinceLastLook: true })).toHaveLength(2);
  });

  it('counts every part as changed when the commit of the last look is gone', () => {
    const gone = since({ outcome: 'commit gone', changed: [] });

    expect(nodes(gone, { onlyChangedSinceLastLook: true }).map((node) => node.changedSinceLastLook)).toEqual([true, true]);
    expect(nodes(gone)[0]!.tooltip).toBe('Counts as changed: GitHub no longer has abcdef0, the commit of your last look.');
    expect(sinceLastLookLine(gone)).toBe('The commit of your last look, abcdef0 on 2026-10-01, is no longer on GitHub: every part counts as changed.');
  });

  it('says which commit the last look was at, where it comes from, and how many parts changed', () => {
    expect(sinceLastLookLine(result([cart, money]))).toBeUndefined();
    expect(sinceLastLookLine(since())).toBe('Since your last look at abcdef0 on 2026-10-01: 1 of 2 parts changed.');
    expect(sinceLastLookLine(since({ from: 'github review' }))).toBe('Since your last GitHub review at abcdef0 on 2026-10-01: 1 of 2 parts changed.');
  });

  it('puts the last look above the review status, saying when the filter is on', () => {
    expect(treeMessage(result([cart, money]))).toBeUndefined();
    expect(treeMessage(since(), 'ranking the parts with pi', { onlyChangedSinceLastLook: true })).toBe(
      'Since your last look at abcdef0 on 2026-10-01: 1 of 2 parts changed. Showing only those. Plain parts shown; ranking the parts with pi…',
    );
  });

  it('says only once that a part changed when it also changed since it was marked', () => {
    const marks = applyMark(NO_MARKS, markedPart(cart), true, new Date('2026-10-01T09:00:00Z'));
    const edited = { ...cart, hunks: [{ ...hunkAt(10, 10), lines: [{ kind: 'addition' as const, newLineNumber: 10, text: 'edited' }] }] };
    const review = { ...since({ changed: changePieces(edited) }), parts: [edited, money] };
    const [node] = nodes(review, {}, marks);

    expect(node!.description).toBe(CHANGED_SINCE_MARKED);
    expect(node!.changedSinceLastLook).toBe(true);
    expect(node!.tooltip).toContain('Changed since your last look at abcdef0.');
  });
});
