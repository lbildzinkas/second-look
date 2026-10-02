import { parseDiff } from '@second-look/engine';
import type { NoiseAssessment, Part } from '@second-look/engine';
import type { ExpectedNoise, ExpectedResults } from './case.js';

/** How many leading parts count as the top of the ranking. */
export const TOP_K = 3;

/** One score of a run, with the direction in which it improves. */
export interface Score {
  /** The score's name, such as `coverage` or `noise-recall:lockfile:claimed`. */
  name: string;
  value: number;
  better: 'higher' | 'lower';
}

/** Counts behind a noise class's precision and recall. */
interface NoiseCounts {
  expected: number;
  predicted: number;
  matched: number;
}

/**
 * The counts a case's scores come from. Counts add up across cases, so
 * a run's overall scores weigh every file and part alike.
 */
export interface Tally {
  changedLines: number;
  /** Changed lines that belong to exactly one part. */
  coveredLines: number;
  /** Counts by noise class: `none`, or a label and its state, such as `lockfile:claimed`. */
  noise: Map<string, NoiseCounts>;
  /** The 1-based rank position of each known important part. */
  positions: number[];
}

function noiseClass(noise: NoiseAssessment | ExpectedNoise): string {
  return noise.label === 'none' ? 'none' : `${noise.label}:${noise.state}`;
}

/** Each changed line of a diff, keyed by file and side, such as `a.ts|new:12`. */
function changedLineKeys(parts: readonly Part[]): string[] {
  return parts.flatMap((part) =>
    part.hunks.flatMap((hunk) =>
      hunk.lines.flatMap((line) => {
        if (line.kind === 'deletion') return [`${part.path}|old:${line.oldLineNumber}`];
        if (line.kind === 'addition') return [`${part.path}|new:${line.newLineNumber}`];
        return [];
      }),
    ),
  );
}

/**
 * Tallies one case: the diff's changed lines the result's parts cover
 * exactly once, each hand-labelled file's expected and actual noise
 * class, and where each known important part ranks. A review that failed
 * has no parts, so it covers no line and is not scored further.
 */
export function tallyCase(
  diff: string,
  expected: ExpectedResults,
  parts: readonly Part[] | undefined,
): Tally {
  const changed = changedLineKeys(parseDiff(diff).files);
  const tally: Tally = { changedLines: changed.length, coveredLines: 0, noise: new Map(), positions: [] };
  if (!parts) return tally;

  const owners = new Map<string, number>();
  for (const key of changedLineKeys(parts)) owners.set(key, (owners.get(key) ?? 0) + 1);
  tally.coveredLines = changed.filter((key) => owners.get(key) === 1).length;

  const counts = (name: string): NoiseCounts => {
    let found = tally.noise.get(name);
    if (!found) tally.noise.set(name, (found = { expected: 0, predicted: 0, matched: 0 }));
    return found;
  };
  for (const [path, wanted] of Object.entries(expected.noise)) {
    if (wanted === null) continue;
    counts(noiseClass(wanted)).expected++;
    const actual = parts.find((part) => part.path === path)?.noise;
    if (!actual) continue;
    counts(noiseClass(actual)).predicted++;
    if (noiseClass(actual) === noiseClass(wanted)) counts(noiseClass(wanted)).matched++;
  }

  for (const important of expected.importantParts) {
    const byName = parts.findIndex((part) => part.name === important);
    const index = byName >= 0 ? byName : parts.findIndex((part) => part.path === important);
    tally.positions.push(index >= 0 ? index + 1 : parts.length + 1);
  }
  return tally;
}

/** Adds tallies up, for a run's overall scores. */
export function addTallies(tallies: readonly Tally[]): Tally {
  const total: Tally = { changedLines: 0, coveredLines: 0, noise: new Map(), positions: [] };
  for (const tally of tallies) {
    total.changedLines += tally.changedLines;
    total.coveredLines += tally.coveredLines;
    total.positions.push(...tally.positions);
    for (const [name, counts] of tally.noise) {
      const sum = total.noise.get(name) ?? { expected: 0, predicted: 0, matched: 0 };
      sum.expected += counts.expected;
      sum.predicted += counts.predicted;
      sum.matched += counts.matched;
      total.noise.set(name, sum);
    }
  }
  return total;
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

/**
 * The plain scores a tally gives: coverage, noise-label precision and
 * recall per class and state, and the median and top-k rank position of
 * the known important parts. A score with nothing to count is left out
 * rather than given a value it did not earn.
 */
export function scoresOf(tally: Tally): Score[] {
  const scores: Score[] = [];
  if (tally.changedLines > 0) {
    scores.push({ name: 'coverage', value: tally.coveredLines / tally.changedLines, better: 'higher' });
  }
  for (const name of [...tally.noise.keys()].sort()) {
    const { expected, predicted, matched } = tally.noise.get(name)!;
    if (predicted > 0) {
      scores.push({ name: `noise-precision:${name}`, value: matched / predicted, better: 'higher' });
    }
    if (expected > 0) {
      scores.push({ name: `noise-recall:${name}`, value: matched / expected, better: 'higher' });
    }
  }
  if (tally.positions.length > 0) {
    scores.push({ name: 'rank-median', value: median(tally.positions), better: 'lower' });
    const top = tally.positions.filter((position) => position <= TOP_K).length;
    scores.push({ name: `rank-top-${TOP_K}`, value: top / tally.positions.length, better: 'higher' });
  }
  return scores;
}
