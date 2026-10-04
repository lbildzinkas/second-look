import { ALL_CASES, NO_AGENT, STAMP_FIELDS } from './run.js';
import type { ResultRow, RunResults } from './run.js';

/** Scores are deterministic; this only absorbs floating-point rounding. */
const TOLERANCE = 1e-9;

/** A row whose score moved from its baseline. */
export interface ScoreChange {
  row: ResultRow;
  baseline: number;
}

/** How a run compares with a stored baseline. */
export interface Comparison {
  drops: ScoreChange[];
  gains: ScoreChange[];
  unchanged: number;
  /** Rows, in the run or the baseline, missing a stamp field: never compared. */
  unstamped: number;
  /** Run rows with no baseline row to compare with. */
  withoutBaseline: ResultRow[];
  /**
   * Baseline rows of a case this run scored that the run no longer gives,
   * such as a precision whose class the engine stopped predicting.
   */
  missing: ResultRow[];
}

/** True when the row carries every stamp field. */
export function hasStamp(row: Partial<ResultRow>): boolean {
  return STAMP_FIELDS.every((field) => {
    const value = row[field];
    return field === 'promptVersions'
      ? typeof value === 'object' && value !== null
      : typeof value === 'string' && value !== '';
  });
}

/**
 * The rows that may be compared: the same case and score, run by the same
 * agent and model at the same effort. Prompt and companion versions may
 * differ, since those are what a comparison tests.
 */
function comparisonKey(row: ResultRow): string {
  return JSON.stringify([row.case, row.name, row.agent, row.model, row.effort]);
}

/** The case and agent a row was scored for, whatever its score. */
function runKey(row: ResultRow): string {
  return JSON.stringify([row.case, row.agent, row.model, row.effort]);
}

/**
 * Compares a run's rows with a stored baseline's, row by row. Rows missing
 * any stamp field are never compared, and neither are the overall rows,
 * whose case set changes whenever a case is added or a subset runs.
 */
export function compareWithBaseline(
  rows: readonly ResultRow[],
  baseline: readonly Partial<ResultRow>[],
): Comparison {
  const comparison: Comparison = {
    drops: [],
    gains: [],
    unchanged: 0,
    unstamped: 0,
    withoutBaseline: [],
    missing: [],
  };
  const stored = new Map<string, ResultRow>();
  for (const row of baseline) {
    if (!hasStamp(row)) comparison.unstamped++;
    else stored.set(comparisonKey(row as ResultRow), row as ResultRow);
  }
  for (const row of rows) {
    if (!hasStamp(row)) {
      comparison.unstamped++;
      continue;
    }
    if (row.case === ALL_CASES) continue;
    const before = stored.get(comparisonKey(row));
    if (!before) {
      comparison.withoutBaseline.push(row);
      continue;
    }
    const delta = row.better === 'higher' ? row.value - before.value : before.value - row.value;
    if (delta < -TOLERANCE) comparison.drops.push({ row, baseline: before.value });
    else if (delta > TOLERANCE) comparison.gains.push({ row, baseline: before.value });
    else comparison.unchanged++;
  }
  const given = new Set(rows.filter(hasStamp).map(comparisonKey));
  const scored = new Set(rows.filter(hasStamp).map((row) => runKey(row)));
  for (const [key, row] of stored) {
    if (row.case !== ALL_CASES && scored.has(runKey(row)) && !given.has(key)) {
      comparison.missing.push(row);
    }
  }
  return comparison;
}

/** The case and agent a fallback was recorded for, whatever its detail. */
function fallbackKey(entry: { case: string; agent: string }): string {
  return JSON.stringify([entry.case, entry.agent]);
}

/**
 * A stored baseline with a run's rows written over it: the run replaces
 * every stored row of each case, agent, model and effort it scored, and
 * every other stored row stays, so one baseline file keeps the plain
 * pass's rows beside each agent and model tried. A stored ranking
 * comparison stays unless the run ranked with the same agent, model and
 * effort.
 */
export function mergeBaseline(stored: RunResults, run: RunResults): RunResults {
  const scored = new Set(run.rows.map(runKey));
  const kept = stored.rows.filter((row) => !scored.has(runKey(row)));
  const cases = new Set(run.rows.map((row) => row.case));
  const scoredFallbacks = new Set(run.rows.map(fallbackKey));
  // The plain pass's rows first, then each agent's, each in its own order.
  const rows = [...kept, ...run.rows].sort(
    (a, b) => Number(a.agent !== NO_AGENT) - Number(b.agent !== NO_AGENT),
  );
  return {
    rows,
    failures: [...stored.failures.filter((failure) => !cases.has(failure.case)), ...run.failures],
    fallbacks: [
      ...(stored.fallbacks ?? []).filter((fallback) => !scoredFallbacks.has(fallbackKey(fallback))),
      ...(run.fallbacks ?? []),
    ],
    rankings: [
      ...(stored.rankings ?? []).filter(
        (ranking) =>
          !(run.rankings ?? []).some(
            (each) => each.agent === ranking.agent && each.model === ranking.model && each.effort === ranking.effort,
          ),
      ),
      ...(run.rankings ?? []),
    ],
  };
}
