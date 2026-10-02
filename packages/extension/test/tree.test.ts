import { describe, expect, it } from 'vitest';
import { buildTree, NOISE, NOT_RANKED_YET, partsInReadingOrder } from '../src/tree.js';
import { mixedResult, part, result } from './results.js';

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
      'new code\n2 callers\nno tests before this pull request',
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
