import { describe, expect, it } from 'vitest';
import { compareWithBaseline, hasStamp, mergeBaseline } from '../src/baseline.js';
import { ALL_CASES, NO_AGENT } from '../src/run.js';
import type { ResultRow } from '../src/run.js';

function row(overrides: Partial<ResultRow> = {}): ResultRow {
  return {
    case: 'example-7',
    name: 'coverage',
    value: 1,
    better: 'higher',
    companionVersion: '0.1.0',
    promptVersions: {},
    agent: NO_AGENT,
    agentVersion: NO_AGENT,
    model: NO_AGENT,
    effort: NO_AGENT,
    runDate: '2026-10-02T00:00:00.000Z',
    ...overrides,
  };
}

describe('hasStamp', () => {
  it('needs every stamp field', () => {
    expect(hasStamp(row())).toBe(true);
    for (const field of ['companionVersion', 'agent', 'agentVersion', 'model', 'effort', 'runDate']) {
      expect(hasStamp({ ...row(), [field]: undefined })).toBe(false);
      expect(hasStamp({ ...row(), [field]: '' })).toBe(false);
    }
    const { promptVersions: _promptVersions, ...withoutPrompts } = row();
    expect(hasStamp(withoutPrompts)).toBe(false);
  });
});

describe('compareWithBaseline', () => {
  it('finds drops and gains in the direction each score improves', () => {
    const comparison = compareWithBaseline(
      [
        row({ value: 0.5 }),
        row({ name: 'rank-median', value: 2, better: 'lower' }),
        row({ name: 'rank-top-3', value: 0.5 }),
      ],
      [
        row({ value: 1 }),
        row({ name: 'rank-median', value: 3, better: 'lower' }),
        row({ name: 'rank-top-3', value: 0.5 }),
      ],
    );
    expect(comparison.drops.map((change) => [change.row.name, change.baseline])).toEqual([
      ['coverage', 1],
    ]);
    expect(comparison.gains.map((change) => [change.row.name, change.baseline])).toEqual([
      ['rank-median', 3],
    ]);
    expect(comparison.unchanged).toBe(1);
  });

  it('never compares a row without its stamp, on either side', () => {
    const { model: _model, ...unstampedRun } = row({ value: 0 });
    const unstampedBaseline = { ...row({ name: 'rank-top-3', value: 1 }), runDate: '' };
    const comparison = compareWithBaseline(
      [unstampedRun as ResultRow, row({ name: 'rank-top-3', value: 0 })],
      [row({ value: 1 }), unstampedBaseline],
    );
    expect(comparison.drops).toEqual([]);
    expect(comparison.unstamped).toBe(2);
    expect(comparison.withoutBaseline.map((each) => each.name)).toEqual(['rank-top-3']);
  });

  it('compares only rows of the same agent, model and effort', () => {
    const comparison = compareWithBaseline(
      [row({ value: 0, agent: 'claude', agentVersion: '2.0.0', model: 'opus', effort: 'high' })],
      [row({ value: 1 })],
    );
    expect(comparison.drops).toEqual([]);
    expect(comparison.missing).toEqual([]);
    expect(comparison.withoutBaseline).toHaveLength(1);
  });

  it('ignores prompt and companion versions, which a comparison tests', () => {
    const comparison = compareWithBaseline(
      [row({ value: 0, companionVersion: '0.2.0', promptVersions: { story: '2' } })],
      [row({ value: 1 })],
    );
    expect(comparison.drops).toHaveLength(1);
  });

  it('reports baseline rows a scored case no longer gives', () => {
    const comparison = compareWithBaseline(
      [row()],
      [
        row(),
        row({ name: 'noise-precision:lockfile:claimed' }),
        row({ case: 'example-42', name: 'noise-precision:lockfile:claimed' }),
      ],
    );
    // example-42 did not run, so its rows are not missing.
    expect(comparison.missing.map((each) => [each.case, each.name])).toEqual([
      ['example-7', 'noise-precision:lockfile:claimed'],
    ]);
  });

  it('does not compare the overall rows, whose case set can change', () => {
    const comparison = compareWithBaseline(
      [row({ case: ALL_CASES, value: 0 })],
      [row({ case: ALL_CASES, value: 1 }), row({ case: ALL_CASES, name: 'rank-top-3' })],
    );
    expect(comparison).toMatchObject({ drops: [], missing: [], withoutBaseline: [], unchanged: 0 });
  });
});

describe('mergeBaseline', () => {
  const pi = { agent: 'pi', agentVersion: '0.86.1', model: 'zai/glm', effort: 'default' };

  it("replaces the stored rows of each case and agent the run scored, and keeps every other", () => {
    const stored = {
      rows: [
        row({ value: 0.5 }),
        row({ case: 'example-42', value: 0.5 }),
        row({ ...pi, value: 0.5 }),
        row({ name: 'rank-median', value: 3, better: 'lower' }),
      ],
      failures: [{ case: 'example-7', error: 'old' }],
    };
    const run = { rows: [row({ value: 1 })], failures: [], fallbacks: [] };

    expect(mergeBaseline(stored, run)).toEqual({
      // The plain rows first; the run's rows of example-7 replace all its stored plain rows.
      rows: [row({ case: 'example-42', value: 0.5 }), row({ value: 1 }), row({ ...pi, value: 0.5 })],
      failures: [],
      fallbacks: [],
    });
  });

  it('keeps a stored fallback unless the run scored that case with the same agent', () => {
    const stored = {
      rows: [row()],
      failures: [],
      fallbacks: [{ case: 'example-7', agent: 'pi', detail: 'the answer was invalid twice' }],
    };
    const plain = { rows: [row({ value: 1 })], failures: [], fallbacks: [] };
    expect(mergeBaseline(stored, plain).fallbacks).toEqual(stored.fallbacks);

    const another = { rows: [row({ ...pi, agent: 'claude', value: 1 })], failures: [], fallbacks: [] };
    expect(mergeBaseline(stored, another).fallbacks).toEqual(stored.fallbacks);

    const again = { rows: [row({ ...pi, value: 1 })], failures: [], fallbacks: [] };
    expect(mergeBaseline(stored, again).fallbacks).toEqual([]);
  });
});
