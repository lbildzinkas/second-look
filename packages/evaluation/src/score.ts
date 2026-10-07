import { filesOfPart, parseDiff } from '@second-look/engine';
import type {
  AcceptanceCriterion,
  Claim,
  ClaimVerdict,
  DescribedChange,
  DraftChecks,
  ExplainChecks,
  FileSlice,
  LinkedIssue,
  NoiseAssessment,
  Part,
  StoryChecks,
  UnexplainedChanges,
} from '@second-look/engine';
import type { ExpectedClaim, ExpectedCriterion, ExpectedDescribed, ExpectedNoise, ExpectedResults, ExpectedUnexplained, Verdict } from './case.js';
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

/**
 * The scores of the verdicts the agent gives the hand-labelled claims:
 * the share it gave the hand verdict, and the share of the claims that do
 * not deserve verified that it verified anyway.
 */
export const VERDICT_SCORES: readonly string[] = ['verdict-accuracy', 'false-verified'];

/**
 * The scores of the unexplained changes the agent finds, against the hand
 * labels, in both directions: recall and precision of the parts it flags
 * as unexplained, and of the described changes it lists as missing from
 * the diff.
 */
export const UNEXPLAINED_SCORES: readonly string[] = ['unexplained-recall', 'unexplained-precision', 'described-recall', 'described-precision'];

/**
 * The scores of the verdicts the agent gives the acceptance criteria,
 * against the hand labels: the share given a verdict the labels accept,
 * the share of the criteria that do not deserve met that it called met
 * anyway, and the share of the labelled code files, test files and
 * manual checks its verdicts cite.
 */
export const CRITERIA_SCORES: readonly string[] = [
  'criteria-accuracy',
  'criteria-false-met',
  'criteria-code-recall',
  'criteria-tests-recall',
  'criteria-manual-recall',
];

/**
 * The plain checks of the drafts the agent writes from the hand-written
 * findings: the share that cite one of the finding's evidence locations,
 * the share that add no claim the finding lacks — no file or code name,
 * place or number it does not hold — and the share that stay within the
 * length cap.
 */
export const DRAFT_SCORES: readonly string[] = ['draft-cites-evidence', 'draft-no-new-claim', 'draft-under-cap'];

/**
 * The plain checks of the explanations the agent gives of the labelled
 * parts: the share that cite lines of the part and only lines the part
 * shows, and the share that name no file or code the change does not
 * show.
 */
export const EXPLAIN_SCORES: readonly string[] = ['explain-cites-part', 'explain-names-in-change'];

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
  /** The counts behind the verdicts the agent gave the hand-labelled claims. */
  judging: JudgingTally;
  /** The counts behind the unexplained changes the agent found, against the hand labels. */
  unexplained: UnexplainedTally;
  /** The counts behind the verdicts the agent gave the acceptance criteria, against the hand labels. */
  criteria: CriteriaTally;
  /** The counts behind the plain checks of the drafts the agent wrote. */
  drafts: DraftTally;
  /** The counts behind the plain checks of the explanations the agent gave. */
  explanations: ExplainTally;
}

/**
 * The counts behind the explanations' plain checks: the parts explained,
 * and the explanations that cite only lines the part shows, at least
 * one, and that name only what the change shows.
 */
export interface ExplainTally {
  parts: number;
  citesPart: number;
  namesInChange: number;
}

function noExplanations(): ExplainTally {
  return { parts: 0, citesPart: 0, namesInChange: 0 };
}

/**
 * Tallies the explanations' plain checks, one per part: a part the agent
 * gave no explanation of fails every check.
 */
export function tallyExplanations(checks: readonly (ExplainChecks | undefined)[]): ExplainTally {
  const tally = noExplanations();
  for (const each of checks) {
    tally.parts++;
    if (each === undefined) continue;
    if (each.cited.length > 0 && each.refused.length === 0) tally.citesPart++;
    if (each.names.outside.length === 0) tally.namesInChange++;
  }
  return tally;
}

/**
 * The counts behind the drafts' plain checks: the findings drafted from,
 * and the drafts that cite an evidence location, add nothing the finding
 * lacks, and stay within the length cap.
 */
export interface DraftTally {
  findings: number;
  cited: number;
  noNewClaim: number;
  underCap: number;
}

function noDrafts(): DraftTally {
  return { findings: 0, cited: 0, noNewClaim: 0, underCap: 0 };
}

/**
 * Tallies the drafts' plain checks, one per finding: a finding the agent
 * wrote no draft for fails every check.
 */
export function tallyDrafts(checks: readonly (DraftChecks | undefined)[]): DraftTally {
  const tally = noDrafts();
  for (const each of checks) {
    tally.findings++;
    if (each === undefined) continue;
    if (each.cited.length > 0) tally.cited++;
    if (each.added.length === 0) tally.noNewClaim++;
    if (each.underCap) tally.underCap++;
  }
  return tally;
}

/**
 * The counts behind the criteria verdicts: the labelled criteria and
 * those given a verdict the labels accept, those that do not deserve met
 * and those called met anyway, and the labelled code files, test files
 * and manual checks with those the verdicts cite.
 */
export interface CriteriaTally {
  labelled: number;
  right: number;
  notMet: number;
  falseMet: number;
  codeFiles: number;
  codeCited: number;
  testFiles: number;
  testsCited: number;
  manualChecks: number;
  manualCited: number;
}

function noCriteria(): CriteriaTally {
  return { labelled: 0, right: 0, notMet: 0, falseMet: 0, codeFiles: 0, codeCited: 0, testFiles: 0, testsCited: 0, manualChecks: 0, manualCited: 0 };
}

/**
 * Tallies the verdicts the agent gave the acceptance criteria against
 * the hand labels, each criterion matched by its quote: right when its
 * verdict is the labelled one or one the labels also accept; each
 * labelled code or test file cited when a line of it is cited under that
 * evidence; each labelled manual check cited when a quoted one holds its
 * text or is held by it. A criterion the review did not read, or left not
 * checked, cites nothing and is right about nothing.
 */
export function tallyCriteria(expected: readonly ExpectedCriterion[], mapped: readonly AcceptanceCriterion[]): CriteriaTally {
  const tally = noCriteria();
  for (const wanted of expected) {
    const found = mapped.find((criterion) => matchText(criterion.quote) === matchText(wanted.text));
    const verdict = found === undefined || found.verdict.kind === 'not checked' ? undefined : found.verdict;
    const accepted = [wanted.verdict, ...(wanted.alsoRight ?? [])];
    tally.labelled++;
    if (verdict !== undefined && accepted.includes(verdict.kind)) tally.right++;
    if (!accepted.includes('met')) {
      tally.notMet++;
      if (verdict?.kind === 'met') tally.falseMet++;
    }
    const cites = (files: readonly string[] | undefined, cited: readonly { path: string }[] | undefined): number =>
      (files ?? []).filter((file) => (cited ?? []).some((each) => each.path === file)).length;
    tally.codeFiles += wanted.code?.length ?? 0;
    tally.codeCited += cites(wanted.code, verdict?.code);
    tally.testFiles += wanted.tests?.length ?? 0;
    tally.testsCited += cites(wanted.tests, verdict?.tests);
    for (const check of wanted.manual ?? []) {
      tally.manualChecks++;
      const text = matchText(check.text);
      if ((verdict?.manualChecks ?? []).some((each) => matchText(each.quote).includes(text) || text.includes(matchText(each.quote)))) tally.manualCited++;
    }
  }
  return tally;
}

/**
 * The counts behind the unexplained changes, in each direction: the
 * hand-labelled ones a reviewer must see and those found, and the ones the
 * agent gave that match a required label or none at all. One that matches
 * only an optional label counts in neither.
 */
export interface UnexplainedTally {
  requiredParts: number;
  foundParts: number;
  flaggedRight: number;
  flaggedWrong: number;
  requiredDescribed: number;
  foundDescribed: number;
  listedRight: number;
  listedWrong: number;
}

function noUnexplained(): UnexplainedTally {
  return { requiredParts: 0, foundParts: 0, flaggedRight: 0, flaggedWrong: 0, requiredDescribed: 0, foundDescribed: 0, listedRight: 0, listedWrong: 0 };
}

/** Whether a part is the one a hand label names: by its name as the engine prints it, or by a path it holds. */
function namesPart(part: Part | undefined, label: string): boolean {
  return part !== undefined && (part.name === label || filesOfPart(part).some((file) => file.path === label));
}

/**
 * Whether a described change the agent listed is a hand-labelled one:
 * made in the same place — the description, or the same linked issue —
 * with the one's text holding the other's, as claims are matched.
 */
export function sameDescribed(listed: DescribedChange, wanted: ExpectedDescribed, issues: readonly LinkedIssue[]): boolean {
  const samePlace =
    'in' in wanted.origin
      ? listed.location.kind === 'description'
      : listed.location.kind === 'issue' && issues[listed.location.issue]?.number === wanted.origin.issue;
  if (!samePlace) return false;
  const [quote, text] = [matchText(listed.quote), matchText(wanted.text)];
  return quote.includes(text) || text.includes(quote);
}

/**
 * Tallies the unexplained changes the agent found against the hand
 * labels: recall over the required parts and described changes, and
 * precision over what it flagged and listed. A comparison that fell back
 * flags nothing.
 */
export function tallyUnexplained(
  expected: ExpectedUnexplained,
  parts: readonly Part[],
  issues: readonly LinkedIssue[],
  found: UnexplainedChanges,
): UnexplainedTally {
  const flagged = found.parts.map((each) => parts[each.part]);
  const optional = expected.optionalParts ?? [];
  const required = expected.described.filter((wanted) => wanted.optional !== true);
  const tally: UnexplainedTally = { ...noUnexplained(), requiredParts: expected.parts.length, requiredDescribed: required.length };
  tally.foundParts = expected.parts.filter((label) => flagged.some((part) => namesPart(part, label))).length;
  for (const part of flagged) {
    if (expected.parts.some((label) => namesPart(part, label))) tally.flaggedRight++;
    else if (!optional.some((label) => namesPart(part, label))) tally.flaggedWrong++;
  }
  tally.foundDescribed = required.filter((wanted) => found.described.some((listed) => sameDescribed(listed, wanted, issues))).length;
  for (const listed of found.described) {
    if (required.some((wanted) => sameDescribed(listed, wanted, issues))) tally.listedRight++;
    else if (!expected.described.some((wanted) => sameDescribed(listed, wanted, issues))) tally.listedWrong++;
  }
  return tally;
}

/**
 * The counts behind the verdicts the agent gave: the hand-labelled claims
 * judged and those given the hand verdict, and the claims that do not
 * deserve verified and those verified anyway.
 */
export interface JudgingTally {
  labelled: number;
  right: number;
  notVerified: number;
  falseVerified: number;
}

function noJudging(): JudgingTally {
  return { labelled: 0, right: 0, notVerified: 0, falseVerified: 0 };
}

/**
 * The verdict the verdicts pass deserves for a hand-labelled claim, from
 * the change alone: the case's verdict, except that a claim the case
 * checks behind a library fetch is unverifiable until the fetch, and its
 * verdict must name the library (ADR 0003). Undefined for a claim the
 * case gives no verdict.
 */
export function verdictBeforeFetch(wanted: ExpectedClaim): { kind: Verdict; library?: string } | undefined {
  if (wanted.verdict === undefined) return undefined;
  if (wanted.libraryFetch && wanted.library) return { kind: 'unverifiable', library: wanted.library.name };
  return { kind: wanted.verdict.kind };
}

/**
 * Tallies the verdicts the agent gave the hand-labelled claims, each
 * against the verdict it deserves from the change alone: right when the
 * kind matches and, for a claim that needs library source, the verdict
 * names that library.
 */
export function tallyJudging(judged: readonly { wanted: ExpectedClaim; got: ClaimVerdict }[]): JudgingTally {
  const tally = noJudging();
  for (const { wanted, got } of judged) {
    const deserved = verdictBeforeFetch(wanted);
    if (deserved === undefined) continue;
    tally.labelled++;
    const library = got.kind === 'not checked' ? undefined : got.needsLibrary;
    const namesLibrary = deserved.library === undefined || library?.toLowerCase() === deserved.library.toLowerCase();
    if (got.kind === deserved.kind && namesLibrary) tally.right++;
    if (deserved.kind !== 'verified') {
      tally.notVerified++;
      if (got.kind === 'verified') tally.falseVerified++;
    }
  }
  return tally;
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
 * same file and line, or one of the case's other lines, and the same
 * source, with library source, a named repository's or decompiled
 * library code, counting only behind a pressed fetch of the library, since that is the only way the
 * check may read it (ADR 0003).
 */
function evidenceMatches(wanted: ExpectedClaim, got: PressedClaim): boolean {
  const evidence = got.verdict?.evidence;
  if (!evidence || !wanted.verdict) return false;
  const expected = wanted.verdict.evidence;
  const places = [expected, ...(wanted.verdict.otherEvidence ?? [])];
  if (
    !places.some((place) => evidence.file === place.file && evidence.line === place.line) ||
    evidence.source !== expected.source
  ) {
    return false;
  }
  return (
    (evidence.source !== 'library source at the pinned version' && evidence.source !== 'a named repository' && evidence.source !== 'decompiled library code') ||
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
    judging: noJudging(),
    unexplained: noUnexplained(),
    criteria: noCriteria(),
    drafts: noDrafts(),
    explanations: noExplanations(),
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
      const index = labelledPart(parts, important);
      tally.positions.push(index >= 0 ? index + 1 : parts.length + 1);
    }
  }
  if (expected.groups) tally.pairs = pairAgreement(expected.groups, hunkOwners(diffFiles, parts));
  return tally;
}

/** The index of the part a hand label names: by its name as the engine prints it, or else the first part holding a file of that path; -1 for none. */
export function labelledPart(parts: readonly Part[], label: string): number {
  const byName = parts.findIndex((part) => part.name === label);
  return byName >= 0 ? byName : parts.findIndex((part) => filesOfPart(part).some((file) => file.path === label));
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
    judging: noJudging(),
    unexplained: noUnexplained(),
    criteria: noCriteria(),
    drafts: noDrafts(),
    explanations: noExplanations(),
  };
  for (const tally of tallies) {
    total.changedLines += tally.changedLines;
    total.coveredLines += tally.coveredLines;
    total.positions.push(...tally.positions);
    total.pairs.total += tally.pairs.total;
    total.pairs.agreed += tally.pairs.agreed;
    for (const key of Object.keys(total.story) as (keyof StoryTally)[]) total.story[key] += tally.story[key];
    for (const key of Object.keys(total.finding) as (keyof FindingTally)[]) total.finding[key] += tally.finding[key];
    for (const key of Object.keys(total.judging) as (keyof JudgingTally)[]) total.judging[key] += tally.judging[key];
    for (const key of Object.keys(total.unexplained) as (keyof UnexplainedTally)[]) total.unexplained[key] += tally.unexplained[key];
    for (const key of Object.keys(total.criteria) as (keyof CriteriaTally)[]) total.criteria[key] += tally.criteria[key];
    for (const key of Object.keys(total.drafts) as (keyof DraftTally)[]) total.drafts[key] += tally.drafts[key];
    for (const key of Object.keys(total.explanations) as (keyof ExplainTally)[]) total.explanations[key] += tally.explanations[key];
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
 * story's plain checks, the recall and precision of the claims the agent
 * listed, the accuracy and false-verified rate of the verdicts it
 * gave, the recall and precision of the unexplained changes it found
 * in each direction, the accuracy, false-met rate and evidence recall
 * of the verdicts it gave the acceptance criteria, and the plain checks
 * of the drafts it wrote from findings and of the explanations it gave
 * of parts. A score with nothing to
 * count is left out rather than given a value it did not earn.
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
  const { judging } = tally;
  if (judging.labelled > 0) scores.push({ name: 'verdict-accuracy', value: judging.right / judging.labelled, better: 'higher' });
  if (judging.notVerified > 0) scores.push({ name: 'false-verified', value: judging.falseVerified / judging.notVerified, better: 'lower' });
  const { unexplained } = tally;
  const ratio = (name: string, part: number, whole: number): Score[] => (whole > 0 ? [{ name, value: part / whole, better: 'higher' }] : []);
  scores.push(
    ...ratio('unexplained-recall', unexplained.foundParts, unexplained.requiredParts),
    ...ratio('unexplained-precision', unexplained.flaggedRight, unexplained.flaggedRight + unexplained.flaggedWrong),
    ...ratio('described-recall', unexplained.foundDescribed, unexplained.requiredDescribed),
    ...ratio('described-precision', unexplained.listedRight, unexplained.listedRight + unexplained.listedWrong),
  );
  const { criteria } = tally;
  scores.push(
    ...ratio('criteria-accuracy', criteria.right, criteria.labelled),
    ...(criteria.notMet > 0 ? [{ name: 'criteria-false-met', value: criteria.falseMet / criteria.notMet, better: 'lower' as const }] : []),
    ...ratio('criteria-code-recall', criteria.codeCited, criteria.codeFiles),
    ...ratio('criteria-tests-recall', criteria.testsCited, criteria.testFiles),
    ...ratio('criteria-manual-recall', criteria.manualCited, criteria.manualChecks),
  );
  const { drafts } = tally;
  scores.push(
    ...ratio('draft-cites-evidence', drafts.cited, drafts.findings),
    ...ratio('draft-no-new-claim', drafts.noNewClaim, drafts.findings),
    ...ratio('draft-under-cap', drafts.underCap, drafts.findings),
  );
  const { explanations } = tally;
  scores.push(
    ...ratio('explain-cites-part', explanations.citesPart, explanations.parts),
    ...ratio('explain-names-in-change', explanations.namesInChange, explanations.parts),
  );
  return scores;
}

/** Whether a score is one of the claim checks: found, a verdict kind, evidence, or fetch offered. */
export function isClaimCheck(name: string): boolean {
  return ['claims-found', 'claims-evidence', 'claims-fetch-offered'].includes(name) || name.startsWith('claims-verdict:');
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
