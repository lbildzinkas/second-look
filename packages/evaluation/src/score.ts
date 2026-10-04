import { filesOfPart, parseDiff } from '@second-look/engine';
import type { Claim, FileSlice, NoiseAssessment, Part, StoryChecks } from '@second-look/engine';
import type { ExpectedClaim, ExpectedNoise, ExpectedResults, Verdict } from './case.js';
import type { LibraryFetchOffer, PressedClaim } from './claims.js';

/** How many leading parts count as the top of the ranking. */
export const TOP_K = 3;

/** The scores of a ranking: the median and top-k rank position of the known important parts. */
export const RANK_SCORES: readonly string[] = ['rank-median', `rank-top-${TOP_K}`];

/** The score of a grouping against the hand labels: pairwise hunk agreement. */
export const GROUPING_AGREEMENT = 'grouping-agreement';

/**
 * The plain checks of a story: the share of must-review parts it links,
 * the share of stories that first mention the parts in reading order, and
 * the share of the file and code names it uses that the change shows.
 */
export const STORY_SCORES: readonly string[] = ['story-must-review', 'story-order', 'story-names'];

/**
 * The scores of the claims the agent lists, against the hand lists: the
 * share of the hand-listed claims it found, and the share of the claims it
 * listed that the hand lists hold.
 */
export const CLAIM_SCORES: readonly string[] = ['claims-recall', 'claims-precision'];

/** One score of a run, with the direction in which it improves. */
export interface Score {
  /** The score's name, such as `coverage` or `noise-recall:lockfile:claimed`. */
  name: string;
  value: number;
  better: 'higher' | 'lower';
  /** A plain caveat the report prints beside the value, such as why a failing score is expected. */
  note?: string;
}

/** Counts behind a noise class's precision and recall. */
interface NoiseCounts {
  expected: number;
  predicted: number;
  matched: number;
}

/** Counts behind one verdict kind's claim check. */
interface VerdictCounts {
  expected: number;
  matched: number;
}

/** The counts behind the claim checks, over the hand-labelled claims that carry a verdict. */
export interface ClaimTally {
  /** Hand-labelled claims with a verdict the run expected. */
  expected: number;
  /** Expected claims the review reported, matched by exact text. */
  found: number;
  /** Counts by expected verdict kind, like the noise classes. */
  verdicts: Map<Verdict, VerdictCounts>;
  /** Expected claims whose verdict's evidence matched. */
  evidence: number;
  /** Expected claims wanting a library fetch whose pressed offer matched the pin. */
  fetchOffered: number;
  /** Expected claims wanting a library fetch. */
  fetchWanted: number;
  /** Claims the review reported, whether expected or not. */
  reported: number;
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
  /** The 1-based rank position of each known important part, counted only over results with at least {@link TOP_K} parts. */
  positions: number[];
  /** The claim checks' counts. */
  claims: ClaimTally;
  /**
   * Pairs of hand-labelled hunks, and the pairs the parts treat as the
   * labels do: together in one part when labelled together, apart when not.
   */
  pairs: { total: number; agreed: number };
  /** The counts behind the story's plain checks. */
  story: StoryTally;
  /** The counts behind the claims the agent listed, against the hand lists. */
  finding: FindingTally;
}

/**
 * The counts behind the claims the agent listed: the hand-listed claims a
 * reviewer must see and those it found, and the claims it listed that
 * match a required hand-listed claim or none at all. A listed claim that
 * matches only an optional one counts in neither.
 */
export interface FindingTally {
  required: number;
  found: number;
  /** Listed claims that match a required hand-listed claim. */
  listedRight: number;
  /** Listed claims that match no hand-listed claim. */
  listedWrong: number;
}

function noFinding(): FindingTally {
  return { required: 0, found: 0, listedRight: 0, listedWrong: 0 };
}

/** Text as claims are matched: on one line, its runs of white space as one space. */
function matchText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * Whether a listed claim is a hand-listed one: made in the same place —
 * the same file, or the description — with the one's text holding the
 * other's, so a quote of one sentence matches a hand-listed paragraph and
 * a quote of two sentences matches each one listed alone.
 */
export function sameClaim(listed: Claim, wanted: ExpectedClaim): boolean {
  const samePlace =
    'file' in wanted.origin
      ? listed.location.kind === 'file' && listed.location.path === wanted.origin.file
      : listed.location.kind === 'description';
  if (!samePlace) return false;
  const [quote, text] = [matchText(listed.quote), matchText(wanted.text)];
  return quote.includes(text) || text.includes(quote);
}

/** Tallies the claims the agent listed against the hand lists: recall over the required claims, precision over what it listed. */
export function tallyFinding(expected: readonly ExpectedClaim[], listed: readonly Claim[]): FindingTally {
  const required = expected.filter((wanted) => wanted.optional !== true);
  const tally: FindingTally = { ...noFinding(), required: required.length };
  tally.found = required.filter((wanted) => listed.some((claim) => sameClaim(claim, wanted))).length;
  for (const claim of listed) {
    if (required.some((wanted) => sameClaim(claim, wanted))) tally.listedRight++;
    else if (!expected.some((wanted) => sameClaim(claim, wanted))) tally.listedWrong++;
  }
  return tally;
}

/** The counts behind a story's plain checks; a story that was not written counts as failing them. */
export interface StoryTally {
  /** Stories asked for, written or not. */
  stories: number;
  /** Stories whose parts are first mentioned in reading order. */
  inOrder: number;
  /** Must-review parts, and those a story links. */
  mustReview: number;
  mentioned: number;
  /** File and code names the stories use, and those the change shows. */
  names: number;
  namesInChange: number;
}

function noStory(): StoryTally {
  return { stories: 0, inOrder: 0, mustReview: 0, mentioned: 0, names: 0, namesInChange: 0 };
}

/**
 * Tallies one story's plain checks: whether every must-review part is
 * linked, whether the parts are first mentioned in reading order, and how
 * many of its names the change shows. A story that was not written fails
 * them: it links no part and keeps no order.
 */
export function tallyStory(checks: StoryChecks, written: boolean): StoryTally {
  const outside = new Set(checks.names.outside);
  return {
    stories: 1,
    inOrder: written && checks.inOrder ? 1 : 0,
    mustReview: checks.mustReview.ids.length,
    mentioned: written ? checks.mustReview.mentioned.length : 0,
    names: checks.names.used.length,
    namesInChange: checks.names.used.filter((name) => !outside.has(name)).length,
  };
}

function noiseClass(noise: NoiseAssessment | ExpectedNoise): string {
  return noise.label === 'none' ? 'none' : `${noise.label}:${noise.state}`;
}

/** Each changed line of a diff, keyed by file and side, such as `a.ts|new:12`. */
function changedLineKeys(files: readonly FileSlice[]): string[] {
  return files.flatMap((part) =>
    part.hunks.flatMap((hunk) =>
      hunk.lines.flatMap((line) => {
        if (line.kind === 'deletion') return [`${part.path}|old:${line.oldLineNumber}`];
        if (line.kind === 'addition') return [`${part.path}|new:${line.newLineNumber}`];
        return [];
      }),
    ),
  );
}

/** Whether a fetch offer names the library the claim is about at the version the project pins. */
function matchesPin(wanted: ExpectedClaim, fetch: LibraryFetchOffer | undefined): boolean {
  return (
    fetch !== undefined &&
    wanted.library !== undefined &&
    fetch.library === wanted.library.name &&
    fetch.pinnedVersion === wanted.library.pinnedVersion
  );
}

/**
 * Whether a reported claim's verdict carries the expected evidence: the
 * same file, line and source, with library source counting only behind a
 * pressed fetch of the pinned library, since that is the only way the
 * check may read it (ADR 0003).
 */
function evidenceMatches(wanted: ExpectedClaim, got: PressedClaim): boolean {
  const evidence = got.verdict?.evidence;
  if (!evidence || !wanted.verdict) return false;
  const expected = wanted.verdict.evidence;
  if (
    evidence.file !== expected.file ||
    evidence.line !== expected.line ||
    evidence.source !== expected.source
  ) {
    return false;
  }
  return (
    evidence.source !== 'library source at the pinned version' ||
    matchesPin(wanted, got.pressedFetch)
  );
}

/**
 * Tallies the claim checks: each hand-labelled claim with a verdict
 * against what the review reported, after the reviewer's fetch presses.
 * A claim the case lists without a verdict counts only in the claims the
 * agent lists ({@link tallyFinding}).
 */
export function tallyClaims(
  labelled: readonly ExpectedClaim[],
  reported: readonly PressedClaim[],
): ClaimTally {
  const expected = labelled.filter((wanted): wanted is ExpectedClaim & { verdict: NonNullable<ExpectedClaim['verdict']> } => wanted.verdict !== undefined);
  const tally: ClaimTally = {
    expected: expected.length,
    found: 0,
    verdicts: new Map(),
    evidence: 0,
    fetchOffered: 0,
    fetchWanted: 0,
    reported: reported.length,
  };
  const counts = (kind: Verdict): VerdictCounts => {
    let found = tally.verdicts.get(kind);
    if (!found) tally.verdicts.set(kind, (found = { expected: 0, matched: 0 }));
    return found;
  };
  for (const wanted of expected) {
    const verdicts = counts(wanted.verdict.kind);
    verdicts.expected++;
    if (wanted.libraryFetch) tally.fetchWanted++;
    const got = reported.find((claim) => claim.text === wanted.text);
    if (!got) continue;
    tally.found++;
    if (got.verdict?.kind === wanted.verdict.kind) verdicts.matched++;
    if (evidenceMatches(wanted, got)) tally.evidence++;
    if (wanted.libraryFetch && matchesPin(wanted, got.pressedFetch)) tally.fetchOffered++;
  }
  return tally;
}

/**
 * Tallies one case: the diff's changed lines the result's parts cover
 * exactly once, each hand-labelled file's expected and actual noise
 * class, where each known important part ranks, how the parts group the
 * hand-labelled hunks, and each hand-labelled claim against what the
 * review reported. A review that failed has no parts, so it covers no
 * line and is not scored further. A result with fewer than {@link TOP_K}
 * parts is never tallied for rank: every part of so small a ranking is
 * trivially at the top, so its positions are fixed by the part count,
 * not by how the review ranked.
 */
export function tallyCase(
  diff: string,
  expected: ExpectedResults,
  parts: readonly Part[] | undefined,
  claims: readonly PressedClaim[] = [],
): Tally {
  const diffFiles = parseDiff(diff).files;
  const changed = changedLineKeys(diffFiles);
  const tally: Tally = {
    changedLines: changed.length,
    coveredLines: 0,
    noise: new Map(),
    positions: [],
    claims: tallyClaims(expected.claims, claims),
    pairs: { total: 0, agreed: 0 },
    story: noStory(),
    finding: noFinding(),
  };
  if (!parts) return tally;

  const files = parts.flatMap(filesOfPart);
  const owners = new Map<string, number>();
  for (const key of changedLineKeys(files)) owners.set(key, (owners.get(key) ?? 0) + 1);
  tally.coveredLines = changed.filter((key) => owners.get(key) === 1).length;

  const counts = (name: string): NoiseCounts => {
    let found = tally.noise.get(name);
    if (!found) tally.noise.set(name, (found = { expected: 0, predicted: 0, matched: 0 }));
    return found;
  };
  for (const [path, wanted] of Object.entries(expected.noise)) {
    if (wanted === null) continue;
    counts(noiseClass(wanted)).expected++;
    const actual = files.find((file) => file.path === path)?.noise;
    if (!actual) continue;
    counts(noiseClass(actual)).predicted++;
    if (noiseClass(actual) === noiseClass(wanted)) counts(noiseClass(wanted)).matched++;
  }

  if (parts.length >= TOP_K) {
    for (const important of expected.importantParts) {
      const byName = parts.findIndex((part) => part.name === important);
      const index =
        byName >= 0
          ? byName
          : parts.findIndex((part) => filesOfPart(part).some((file) => file.path === important));
      tally.positions.push(index >= 0 ? index + 1 : parts.length + 1);
    }
  }
  if (expected.groups) tally.pairs = pairAgreement(expected.groups, hunkOwners(diffFiles, parts));
  return tally;
}

/** A hunk's reference in hand labels: `path#n`, or the bare path of a file without hunks. */
function hunkRef(path: string, index: number | undefined): string {
  return index === undefined ? path : `${path}#${index + 1}`;
}

/**
 * Which part holds each hunk, by the hunk's reference. A hunk the agent
 * left out is in no group: it counts as a part of its own.
 */
function hunkOwners(diffFiles: readonly FileSlice[], parts: readonly Part[]): Map<string, string> {
  const owners = new Map<string, string>();
  parts.forEach((part, partIndex) => {
    for (const file of filesOfPart(part)) {
      const diffHunks = diffFiles.find((each) => each.path === file.path)?.hunks ?? [];
      const refs =
        file.hunks.length === 0
          ? [hunkRef(file.path, undefined)]
          : file.hunks.map((hunk) =>
              hunkRef(
                file.path,
                diffHunks.findIndex((each) => each.oldStart === hunk.oldStart && each.newStart === hunk.newStart),
              ),
            );
      for (const ref of refs) {
        owners.set(ref, part.origin === 'not grouped by the agent' ? `left out ${ref}` : `part ${partIndex}`);
      }
    }
  });
  return owners;
}

/**
 * Pairwise hunk agreement with the hand labels: over every pair of
 * labelled hunks, whether the parts put them together exactly when the
 * labels do.
 */
function pairAgreement(groups: readonly string[][], owners: ReadonlyMap<string, string>): Tally['pairs'] {
  const labelled = groups.flatMap((group, index) => group.map((ref) => ({ ref, group: index })));
  const pairs = { total: 0, agreed: 0 };
  for (const [i, a] of labelled.entries()) {
    for (const b of labelled.slice(i + 1)) {
      pairs.total++;
      const together = owners.get(a.ref) !== undefined && owners.get(a.ref) === owners.get(b.ref);
      if (together === (a.group === b.group)) pairs.agreed++;
    }
  }
  return pairs;
}

/** Adds tallies up, for a run's overall scores. */
export function addTallies(tallies: readonly Tally[]): Tally {
  const total: Tally = {
    changedLines: 0,
    coveredLines: 0,
    noise: new Map(),
    positions: [],
    claims: {
      expected: 0,
      found: 0,
      verdicts: new Map(),
      evidence: 0,
      fetchOffered: 0,
      fetchWanted: 0,
      reported: 0,
    },
    pairs: { total: 0, agreed: 0 },
    story: noStory(),
    finding: noFinding(),
  };
  for (const tally of tallies) {
    total.changedLines += tally.changedLines;
    total.coveredLines += tally.coveredLines;
    total.positions.push(...tally.positions);
    total.pairs.total += tally.pairs.total;
    total.pairs.agreed += tally.pairs.agreed;
    for (const key of Object.keys(total.story) as (keyof StoryTally)[]) total.story[key] += tally.story[key];
    for (const key of Object.keys(total.finding) as (keyof FindingTally)[]) total.finding[key] += tally.finding[key];
    for (const [name, counts] of tally.noise) {
      const sum = total.noise.get(name) ?? { expected: 0, predicted: 0, matched: 0 };
      sum.expected += counts.expected;
      sum.predicted += counts.predicted;
      sum.matched += counts.matched;
      total.noise.set(name, sum);
    }
    const claims = total.claims;
    const each = tally.claims;
    claims.expected += each.expected;
    claims.found += each.found;
    claims.evidence += each.evidence;
    claims.fetchOffered += each.fetchOffered;
    claims.fetchWanted += each.fetchWanted;
    claims.reported += each.reported;
    for (const [kind, counts] of each.verdicts) {
      const sum = claims.verdicts.get(kind) ?? { expected: 0, matched: 0 };
      sum.expected += counts.expected;
      sum.matched += counts.matched;
      claims.verdicts.set(kind, sum);
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
 * recall per class and state, the median and top-k rank position of the
 * known important parts, the grouping's pairwise hunk agreement with
 * the hand labels, the claim checks over the hand-labelled claims, the
 * story's plain checks, and the recall and precision of the claims the
 * agent listed. A score with nothing to count is left out rather than
 * given a value it did not earn.
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
  if (tally.pairs.total > 0) {
    scores.push({ name: GROUPING_AGREEMENT, value: tally.pairs.agreed / tally.pairs.total, better: 'higher' });
  }
  scores.push(...claimScores(tally.claims));
  const { story } = tally;
  if (story.mustReview > 0) scores.push({ name: 'story-must-review', value: story.mentioned / story.mustReview, better: 'higher' });
  if (story.stories > 0) scores.push({ name: 'story-order', value: story.inOrder / story.stories, better: 'higher' });
  if (story.names > 0) scores.push({ name: 'story-names', value: story.namesInChange / story.names, better: 'higher' });
  const { finding } = tally;
  if (finding.required > 0) scores.push({ name: 'claims-recall', value: finding.found / finding.required, better: 'higher' });
  const judged = finding.listedRight + finding.listedWrong;
  if (judged > 0) scores.push({ name: 'claims-precision', value: finding.listedRight / judged, better: 'higher' });
  return scores;
}

/** The claim checks: found, verdict per kind, evidence, and fetch offered. */
function claimScores(claims: ClaimTally): Score[] {
  if (claims.expected === 0) return [];
  const note =
    claims.reported === 0
      ? 'expected failure: the review reports no claims'
      : undefined;
  const scored = (score: Score): Score => (note ? { ...score, note } : score);
  const scores = [
    scored({ name: 'claims-found', value: claims.found / claims.expected, better: 'higher' }),
  ];
  for (const kind of [...claims.verdicts.keys()].sort()) {
    const { expected, matched } = claims.verdicts.get(kind)!;
    if (expected > 0) {
      scores.push(
        scored({ name: `claims-verdict:${kind}`, value: matched / expected, better: 'higher' }),
      );
    }
  }
  scores.push(scored({ name: 'claims-evidence', value: claims.evidence / claims.expected, better: 'higher' }));
  if (claims.fetchWanted > 0) {
    scores.push(
      scored({
        name: 'claims-fetch-offered',
        value: claims.fetchOffered / claims.fetchWanted,
        better: 'higher',
      }),
    );
  }
  return scores;
}
