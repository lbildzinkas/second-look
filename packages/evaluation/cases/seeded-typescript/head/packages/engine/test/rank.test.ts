import { describe, expect, it } from 'vitest';
import type { NoiseAssessment, Part, PartSignals } from '../src/protocol.js';
import { rankParts } from '../src/rank.js';

/** A ranked part with the given signals; the rule reads nothing else but noise and syntax. */
function part(name: string, signals: Partial<PartSignals>, extra: Partial<Part> = {}): Part {
  return {
    name,
    path: `${name}.ts`,
    changeKind: 'modification',
    isBinary: false,
    oldMissingFinalNewline: false,
    newMissingFinalNewline: false,
    hunks: [],
    additions: 0,
    deletions: 0,
    noise: { label: 'none', note: 'no rule applied' },
    syntax: { formattingOnly: { status: 'structure-changed', reason: '' }, checksNotRun: [] },
    signals: {
      novelty: 'changed',
      role: 'code',
      changedLines: 4,
      publicSurface: [],
      references: { basis: 'name-based', names: [], files: 0 },
      ...signals,
    },
    ...extra,
  };
}

/** A part every signal pushes to must review: new public code of some size. */
function heavy(name: string, changedLines = 20): Part {
  return part(name, { novelty: 'new', publicSurface: [name], changedLines });
}

const LOCKFILE: NoiseAssessment = {
  label: 'lockfile',
  rule: 'lockfile-name',
  state: 'claimed',
  blindSpot: 'Only known lockfile names are matched.',
};

function levels(parts: Part[]): [string, string][] {
  return parts.map((ranked) => [ranked.name!, ranked.rank!.importance]);
}

describe('rankParts', () => {
  it('scores each signal and cites the ones it used', () => {
    const ranked = rankParts([
      part('surface', { publicSurface: ['Cart.total'], changedLines: 12 }),
      part('referenced', { references: { basis: 'name-based', names: ['load'], files: 6 } }),
      part('fresh', { novelty: 'new' }),
      part('quiet', {}),
    ]);
    expect(ranked.map((p) => [p.name, p.rank!.importance, p.rank!.reason])).toEqual([
      [
        'surface',
        'must review',
        'changes the public surface: Cart.total; code; 12 changed lines',
      ],
      [
        'referenced',
        'worth reviewing',
        'code; changes code named in 6 other files (name-based); 4 changed lines',
      ],
      ['fresh', 'worth reviewing', 'code; new code; 4 changed lines'],
      ['quiet', 'context', 'code; 4 changed lines'],
    ]);
    for (const p of ranked) {
      // The reason is the signals it cites, joined into one line.
      expect(p.rank!.signals.join('; ')).toBe(p.rank!.reason);
    }
  });

  it('counts references for removed code too, and size in two steps', () => {
    const ranked = rankParts([
      part('removed', {
        novelty: 'removed',
        references: { basis: 'name-based', names: ['gone'], files: 1 },
        changedLines: 60,
      }),
    ]);
    expect(ranked[0]!.rank!.importance).toBe('must review');
    expect(ranked[0]!.rank!.reason).toBe(
      'code; removes code named in 1 other file (name-based); 60 changed lines',
    );
  });

  it("gives a test's public functions no surface points", () => {
    const [test] = rankParts([part('test', { role: 'test', publicSurface: ['test_cart'] })]);
    expect(test!.rank!.importance).toBe('context');
    expect(test!.rank!.reason).toBe('test; 4 changed lines');
  });

  it('keeps at most a third of the parts, rounded up, at must review', () => {
    for (const count of [1, 2, 3, 4, 5, 7, 9, 10]) {
      const parts = Array.from({ length: count }, (_, i) => heavy(`p${i}`, 20 + i));
      const ranked = rankParts(parts);
      const must = ranked.filter((p) => p.rank!.importance === 'must review');
      expect(must.length, `${count} parts`).toBe(Math.ceil(count / 3));
      // The largest keep the places; the others say why they lost them.
      expect(must.map((p) => p.name)).toEqual(
        parts.slice(-must.length).reverse().map((p) => p.name),
      );
      for (const demoted of ranked.slice(must.length)) {
        expect(demoted.rank!.importance).toBe('worth reviewing');
        expect(demoted.rank!.reason).toMatch(
          /; must review is kept for the top third of the parts$/,
        );
      }
    }
  });

  it('puts confirmed formatting-only changes at context, citing the check', () => {
    const formatted = heavy('formatted');
    formatted.syntax = {
      formattingOnly: { status: 'confirmed', reason: '' },
      checksNotRun: [],
    };
    const [ranked] = rankParts([formatted]);
    expect(ranked!.rank!.importance).toBe('context');
    expect(ranked!.rank!.reason).toBe(
      'formatting only, confirmed by the syntax trees; code; 20 changed lines',
    );
  });

  it('sinks noise parts to the end in diff order, and counts them out of the cap', () => {
    const ranked = rankParts([
      part('lock-a', {}, { noise: LOCKFILE }),
      heavy('first'),
      part('lock-b', { changedLines: 900 }, { noise: LOCKFILE }),
      heavy('second'),
    ]);
    expect(levels(ranked)).toEqual([
      ['first', 'must review'],
      ['second', 'worth reviewing'],
      ['lock-a', 'context'],
      ['lock-b', 'context'],
    ]);
    expect(ranked[3]!.rank!.reason).toBe('lockfile noise (claimed); 900 changed lines');
  });

  it('ranks snapshots and fixtures with the other parts, since they never sink', () => {
    const snapshot = heavy('snapshot');
    snapshot.noise = { ...LOCKFILE, label: 'snapshot', rule: 'snapshot-name' };
    expect(levels(rankParts([part('quiet', {}), snapshot]))).toEqual([
      ['snapshot', 'must review'],
      ['quiet', 'context'],
    ]);
  });

  it('breaks ties by points, then changed lines, then diff order', () => {
    // All worth reviewing: e scores 3, the rest 2 with different sizes.
    const input = [
      part('b', { novelty: 'new' }),
      part('a', { novelty: 'new' }),
      part('c', { novelty: 'new', changedLines: 9 }),
      part('d', { novelty: 'new', role: 'test', changedLines: 12 }),
      part('e', { novelty: 'new', changedLines: 10 }),
    ];
    expect(rankParts(input).map((p) => p.name)).toEqual(['e', 'd', 'c', 'b', 'a']);
    expect(rankParts([...input].reverse()).map((p) => p.name)).toEqual(['e', 'd', 'c', 'a', 'b']);
  });

  it('gives every part a reason citing at least one signal', () => {
    const ranked = rankParts([
      heavy('a'),
      part('b', {}),
      part('c', { role: 'test' }),
      part('d', {}, { noise: LOCKFILE }),
    ]);
    for (const p of ranked) expect(p.rank!.reason).toMatch(/\d+ changed lines?/);
  });
});
