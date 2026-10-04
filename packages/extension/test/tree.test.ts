import { describe, expect, it } from 'vitest';
import type { AgentGrouping, FileSlice, Hunk } from '@second-look/engine';
import {
  anchorOf,
  buildTree,
  findAnchor,
  groupingStatus,
  NOISE,
  NOT_RANKED_YET,
  partsInReadingOrder,
} from '../src/tree.js';
import { mixedResult, part, result } from './results.js';

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

describe('groupingStatus', () => {
  it('names the stage still running while the plain parts show', () => {
    expect(groupingStatus(mixedResult(), 'grouping related hunks with pi')).toBe(
      'Plain parts shown; grouping related hunks with pi…',
    );
  });

  it('says who grouped the parts, with the model and the prompt version', () => {
    const grouped = { ...mixedResult(), grouping: { by: 'agent' as const, agent: agentGrouping({}) } };
    expect(groupingStatus(grouped)).toBe(
      'Grouped by pi · zai/glm-4.6 (grouping prompt v1): every hunk was placed by the agent.',
    );
  });

  it('says why the plain grouping stayed', () => {
    const agent = agentGrouping({ outcome: 'fell back', detail: 'the agent gave no usable answer (timeout: too slow)' });
    expect(groupingStatus({ ...mixedResult(), grouping: { by: 'plain', agent } })).toBe(
      'Plain grouping kept: the agent gave no usable answer (timeout: too slow).',
    );
  });

  it('shows no line when the agent was never asked', () => {
    expect(groupingStatus(mixedResult())).toBeUndefined();
  });
});
