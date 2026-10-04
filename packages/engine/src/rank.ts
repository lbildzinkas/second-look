import { sinks } from './noise.js';
import { filesOfPart } from './parts.js';
import {
  IMPORTANCE_ORDER,
  type Importance,
  type Part,
  type PartRank,
  type PartSignals,
} from './protocol.js';

/**
 * The fixed ranking rule. Each signal adds points:
 *
 * - a public surface change in code: 3 (a test's functions are no one's API);
 * - code rather than a test: 1;
 * - new code: 1;
 * - changed or removed code that other files in the head copy name: 1, or
 *   2 from {@link MANY_REFERENCES} files on (name-based);
 * - size: 1 from {@link SOME_LINES} changed lines, 2 from {@link MANY_LINES}.
 *
 * A part scoring {@link MUST_REVIEW_POINTS} or more is a must-review
 * candidate, one scoring {@link WORTH_REVIEWING_POINTS} or more is worth
 * reviewing, and the rest is context. Only the best third of the ranked
 * parts (rounded up) stay must review; the other candidates are worth
 * reviewing. A confirmed formatting-only change and a sinking noise part
 * are context whatever they score, and the noise comes last.
 */
const MUST_REVIEW_POINTS = 4;
const WORTH_REVIEWING_POINTS = 2;
const MANY_REFERENCES = 5;
const SOME_LINES = 10;
const MANY_LINES = 50;

/** A part's score with the signals it cites, before the must-review cap. */
interface Scored {
  part: Part;
  /** Diff order, the last tie-breaker. */
  index: number;
  points: number;
  importance: Importance;
  cited: string[];
}

function lines(count: number): string {
  return `${count} changed ${count === 1 ? 'line' : 'lines'}`;
}

function files(count: number): string {
  return `${count} other ${count === 1 ? 'file' : 'files'}`;
}

function publicSurface(signals: PartSignals): string {
  return `changes the public surface: ${signals.publicSurface.join(', ')}`;
}

function references(signals: PartSignals): string {
  const verb = { new: 'adds', changed: 'changes', removed: 'removes' }[signals.novelty];
  return `${verb} code named in ${files(signals.references.files)} (name-based)`;
}

const FORMATTING_ONLY = 'formatting only, confirmed by the syntax trees';

/** Whether every file of the part is a formatting-only change the syntax trees confirmed. */
function formattingOnly(part: Part): boolean {
  return filesOfPart(part).every((file) => file.syntax.formattingOnly.status === 'confirmed');
}

/** The key the agent ranking cites a plain signal by. */
export type SignalKey = 'public-surface' | 'role' | 'novelty' | 'references' | 'size' | 'formatting-only' | 'noise';

/** One plain signal of a part: the key it is cited by and the phrase the reviewer reads. */
export interface SignalFact {
  key: SignalKey;
  phrase: string;
}

/**
 * Every plain signal a part has, in the words the plain rule cites them
 * with: the public surface it changes, code or test, new, changed or
 * removed code, how many other files name it, its size, a confirmed
 * formatting-only change, and each noise label that never sinks it.
 */
export function signalFacts(part: Part): SignalFact[] {
  const signals = part.signals!;
  const facts: SignalFact[] = [];
  if (signals.publicSurface.length > 0) facts.push({ key: 'public-surface', phrase: publicSurface(signals) });
  facts.push({ key: 'role', phrase: signals.role });
  facts.push({ key: 'novelty', phrase: `${signals.novelty} code` });
  if (signals.references.files > 0) facts.push({ key: 'references', phrase: references(signals) });
  facts.push({ key: 'size', phrase: lines(signals.changedLines) });
  if (formattingOnly(part)) facts.push({ key: 'formatting-only', phrase: FORMATTING_ONLY });
  const labels = filesOfPart(part).flatMap(({ noise }) =>
    noise && noise.label !== 'none' ? [`${noise.label} noise (${noise.state})`] : [],
  );
  if (labels.length > 0) facts.push({ key: 'noise', phrase: [...new Set(labels)].join(', ') });
  return facts;
}

/** How many of the ranked parts may be must review: a third, rounded up. */
export function mustReviewPlaces(count: number): number {
  return Math.ceil(count / 3);
}

/** The points a part's signals earn, with the phrase citing each signal used. */
function score(signals: PartSignals): { points: number; cited: string[] } {
  let points = 0;
  const cited: string[] = [];
  if (signals.publicSurface.length > 0 && signals.role === 'code') {
    points += 3;
    cited.push(publicSurface(signals));
  }
  if (signals.role === 'code') points += 1;
  cited.push(signals.role);
  const referring = signals.references.files;
  if (signals.novelty === 'new') {
    points += 1;
    cited.push('new code');
  } else if (referring > 0) {
    points += referring >= MANY_REFERENCES ? 2 : 1;
    cited.push(references(signals));
  }
  if (signals.changedLines >= SOME_LINES) points += signals.changedLines >= MANY_LINES ? 2 : 1;
  cited.push(lines(signals.changedLines));
  return { points, cited };
}

/** Scores one ranked part, or fixes it at context when the rule says so. */
function scored(part: Part, index: number): Scored {
  const signals = part.signals!;
  if (formattingOnly(part)) {
    const cited = [FORMATTING_ONLY, signals.role, lines(signals.changedLines)];
    return { part, index, points: 0, importance: 'context', cited };
  }
  const { points, cited } = score(signals);
  const importance: Importance =
    points >= MUST_REVIEW_POINTS
      ? 'must review'
      : points >= WORTH_REVIEWING_POINTS
        ? 'worth reviewing'
        : 'context';
  return { part, index, points, importance, cited };
}

/** Higher level first, then more points, more changed lines, then diff order. */
function byRank(a: Scored, b: Scored): number {
  return (
    IMPORTANCE_ORDER.indexOf(a.importance) - IMPORTANCE_ORDER.indexOf(b.importance) ||
    b.points - a.points ||
    b.part.signals!.changedLines - a.part.signals!.changedLines ||
    a.index - b.index
  );
}

/** A part sinks with the noise when every file it holds hunks of is sinking noise. */
export function sinksPart(part: Part): boolean {
  return filesOfPart(part).every((file) => sinks(file.noise));
}

function withRank(part: Part, importance: Importance, cited: string[]): Part {
  const rank: PartRank = { importance, reason: cited.join('; '), signals: cited };
  return { ...part, rank };
}

/**
 * Ranks parts whose signals are set: gives each its importance with a
 * one-line reason citing the signals it used, keeps at most a third of the
 * ranked parts (rounded up) at must review, and orders them must review,
 * worth reviewing, then context, with the sinking noise parts last in diff
 * order. The same parts always give the same order.
 */
export function rankParts(parts: readonly Part[]): Part[] {
  const ranked = parts
    .map((part, index) => ({ part, index }))
    .filter(({ part }) => !sinksPart(part))
    .map(({ part, index }) => scored(part, index))
    .sort(byRank);
  ranked.slice(mustReviewPlaces(ranked.length)).forEach((entry) => {
    if (entry.importance !== 'must review') return;
    entry.importance = 'worth reviewing';
    entry.cited.push('must review is kept for the top third of the parts');
  });
  ranked.sort(byRank);
  const noise = parts.flatMap((part) => {
    const { noise: assessment, signals } = part;
    if (!sinksPart(part) || !sinks(assessment)) return [];
    const cited = [`${assessment.label} noise (${assessment.state})`, lines(signals!.changedLines)];
    return [withRank(part, 'context', cited)];
  });
  return [...ranked.map((entry) => withRank(entry.part, entry.importance, entry.cited)), ...noise];
}
