import {
  IMPORTANCE_ORDER,
  NO_MARKS,
  changedSinceLastLook,
  claimCounts,
  filesOfPart,
  findingCounts,
  isLabelledNoise,
  noiseSinks,
  partsLeft,
  reviewedState,
  unexplainedReasons,
  type AgentStamp,
  type ClaimJudging,
  type Claims,
  type Comment,
  type FileSlice,
  type Importance,
  type LabelledNoise,
  type Part,
  type Ranking,
  type ReviewedMarks,
  type ReviewedState,
  type ReviewResult,
  type SinceLastLook,
} from '@second-look/engine';
import { commentLocation } from './comments.js';

/** One part as the tree shows it. */
export interface TreePart {
  /** The part's name in the tree: the entities it touches, or its path. */
  label: string;
  /** Shown beside the label: the one-line reason, or the noise label with its state. */
  description?: string;
  /** Shown on hover: the part's cited signals, one per line, then which ranking is shown. */
  tooltip?: string;
  /** Marks the parts that sank below the ones a reviewer must read. */
  kind: 'part' | 'noise';
  /** How many claims are attached to the part; absent when it has none. */
  claims?: number;
  /** How many of its claims are findings, refuted or unverifiable; absent when none is. */
  findings?: number;
  /** Why neither the description nor a linked issue explains the part; absent when the comparison does not flag it. */
  unexplained?: string;
  /** Where the part stands against the reviewed marks, which its checkbox shows. */
  reviewed?: ReviewedState;
  /** True when the part changed since the reviewer's last look. */
  changedSinceLastLook?: true;
  /** The part itself, which clicking opens in the diff editor. */
  part?: Part;
}

/** One pending comment as the tree shows it, in the pending review's section. */
export interface TreeComment {
  /** Where the comment points: `path:line`, or `path (part)`. */
  label: string;
  /** Shown beside the label: the comment's first line. */
  description?: string;
  /** Shown on hover: the comment in full. */
  tooltip?: string;
  kind: 'comment';
}

/** One section of the tree: an importance group, the unranked parts, noise, or the pending review. */
export interface TreeSection {
  /** The section's title. */
  label: string;
  /** What the section means, shown on hover. */
  tooltip: string;
  parts: (TreePart | TreeComment)[];
}

/** Which parts the tree shows. */
export interface TreeFilter {
  /** Only the parts that changed since the reviewer's last look, when the result knows of one. */
  onlyChangedSinceLastLook?: boolean;
}

/** The title of the section for parts that arrive without a rank. */
export const NOT_RANKED_YET = 'Not ranked yet';

/** The title of the last section, where the noise parts sink. */
export const NOISE = 'Noise';

/** The title of the section the pending review gathers in, above the parts. */
export const PENDING_REVIEW = 'Pending review';

/** Each importance as the reviewer reads it: a section's title, and the banner's first word. */
export const SECTION_TITLES: Record<Importance, string> = {
  'must review': 'Must review',
  'worth reviewing': 'Worth reviewing',
  context: 'Context',
};

const SECTION_TOOLTIPS: Record<Importance, string> = {
  'must review': 'The parts to read first.',
  'worth reviewing': 'The parts worth a careful read.',
  context: 'The parts that only give background to the change.',
};

/**
 * Builds the tree the reviewer reads from a review result: the importance
 * groups in order, each part with its reason beside it and in its tooltip
 * the signals the reason cites and whether the plain or the agent ranking
 * is shown, then the parts that arrived without a rank, and the noise
 * last with its label and confirmed or claimed state.
 *
 * A part that arrives without a rank sits in its own section — the tree
 * shows whatever the engine returns, never inventing a rank. Empty
 * sections are left out, and snapshots and fixtures never sink, because a
 * change there is a behaviour change. A part the listed claims are
 * attached to shows their count beside it, and a badge counting its
 * findings once the claims are judged or the Verify this claim ask
 * judged one of them. A part neither the description nor
 * a linked issue explains carries the unexplained badge, its one-line
 * reason in the tooltip. Every part carries its reviewed state for its
 * checkbox, and a part whose content changed since the reviewer marked it
 * says so first. A part that changed since the reviewer's last look says
 * so too, and the filter shows only those parts.
 */
export function buildTree(result: ReviewResult, marks: ReviewedMarks = NO_MARKS, filter: TreeFilter = {}): TreeSection[] {
  const grouped = new Map<Importance, TreePart[]>(
    IMPORTANCE_ORDER.map((importance) => [importance, []]),
  );
  const notRanked: TreePart[] = [];
  const noise: TreePart[] = [];

  const counts = claimCounts(result.claims, result.parts.length);
  const findings = findingCounts(result.claims, result.parts.length);
  const asked = askedCounts(result.claims, result.parts.length);
  const judged = result.claims?.judging?.outcome === 'judged';
  const unexplained = unexplainedReasons(result.unexplained, result.parts.length);
  const since = result.sinceLastLook;
  const changed = result.parts.map((part) => since !== undefined && changedSinceLastLook(part, since));
  const withBadges = (node: TreePart, index: number): TreePart => {
    const reviewed = reviewedState(result.parts[index]!, marks);
    const badged = withUnexplained(withClaims(node, counts[index]!, findings[index]!, judged, asked[index]!, result.claims?.judging), unexplained[index]);
    return withReviewed(changed[index] ? withLastLook(badged, since!, reviewed) : badged, reviewed);
  };
  result.parts.forEach((part, index) => {
    if (filter.onlyChangedSinceLastLook && since !== undefined && !changed[index]) return;
    const assessment = part.noise;
    if (assessment && isLabelledNoise(assessment) && noiseSinks(assessment)) {
      noise.push(withBadges(noisePart(part, assessment), index));
      return;
    }
    if (part.rank) {
      grouped.get(part.rank.importance)!.push(withBadges(rankedPart(part, result.ranking), index));
      return;
    }
    notRanked.push(withBadges(unrankedPart(part), index));
  });

  const sections: TreeSection[] = [];
  for (const importance of IMPORTANCE_ORDER) {
    const parts = grouped.get(importance)!;
    if (parts.length > 0) {
      sections.push({
        label: SECTION_TITLES[importance],
        tooltip: SECTION_TOOLTIPS[importance],
        parts,
      });
    }
  }
  if (notRanked.length > 0) {
    sections.push({
      label: NOT_RANKED_YET,
      tooltip: 'The engine has not ranked these parts yet.',
      parts: notRanked,
    });
  }
  if (noise.length > 0) {
    sections.push({
      label: NOISE,
      tooltip: 'Changes that need no careful reading; the label says whether it was confirmed or only claimed.',
      parts: noise,
    });
  }
  return sections;
}

/**
 * The parts in the order the reviewer reads them, straight from the tree:
 * the importance groups in order, then the parts the engine has not ranked
 * yet, then the noise last.
 */
export function partsInReadingOrder(result: ReviewResult): Part[] {
  return buildTree(result)
    .flatMap((section) => section.parts)
    .filter((entry): entry is TreePart => 'part' in entry && entry.part !== undefined)
    .map((entry) => entry.part!);
}

/**
 * The section the pending review gathers in: every comment the reviewer
 * wrote, where each points, kept until they submit it as one review.
 */
export function pendingReviewSection(comments: readonly Comment[]): TreeSection {
  return {
    label: PENDING_REVIEW,
    tooltip: 'The comments you wrote, sent to GitHub as one review on submit.',
    parts: comments.map((comment) => ({
      label: commentLocation(comment),
      description: preview(comment.body),
      tooltip: comment.body,
      kind: 'comment' as const,
    })),
  };
}

/** The comment's first line, cut short for the row beside it. */
function preview(body: string): string {
  const firstLine = body.split('\n')[0] ?? '';
  return firstLine.length > 60 ? `${firstLine.slice(0, 57)}…` : firstLine;
}

/**
 * The lines the tooltip adds about a part's files: which files it spans,
 * when it groups hunks across files, and each label that never sinks its
 * part, with its blind spot.
 */
function fileLines(part: Part): string[] {
  const files = filesOfPart(part);
  const spans = files.length > 1 ? [`across ${files.map((file) => file.path).join(', ')}`] : [];
  const labels = files.flatMap(({ path, noise }) => {
    if (!noise || !isLabelledNoise(noise)) return [];
    const where = files.length > 1 ? `${path}: ` : '';
    return [`${where}${noise.label} · ${noise.state} — ${noise.blindSpot}`];
  });
  return [...spans, ...labels];
}

/** A part's name in the tree; the engine names every part, so the path is only a fallback. */
function partLabel(part: Part): string {
  return part.name ?? part.path;
}

/** Which ranking a part's rank comes from, as its tooltip and the banner above its diff say. */
export function rankingLine(ranking: Ranking): string {
  const agent = ranking.agent;
  if (ranking.by === 'plain' || agent?.stamp === undefined) return 'Plain ranking';
  return `Agent ranking: ${agent.stamp.agent}${modelAndEffort(agent.stamp)} (ranking prompt v${agent.promptVersion})`;
}

/** The model and the effort that answered, as a stamp's tail: the effort shows even when it was the agent's default. */
function modelAndEffort(stamp: AgentStamp): string {
  const model = stamp.model === null ? '' : ` · ${stamp.model}`;
  return `${model} · ${stamp.effort === null ? 'default effort' : `effort ${stamp.effort}`}`;
}

/** A claim count in words, such as `2 claims`. */
export function claimCountText(count: number): string {
  return `${count} claim${count === 1 ? '' : 's'}`;
}

/** A finding count as the part's badge, such as `⚠ 2 findings`. */
export function findingBadge(count: number): string {
  return `⚠ ${count} finding${count === 1 ? '' : 's'}`;
}

/**
 * A part's node with its claim count and, once the claims are judged or
 * the Verify this claim ask judged one of them, the badge counting its
 * findings: first beside the label, and in the tooltip with the claims'
 * state. A part with no claim is left as it is.
 */
function withClaims(node: TreePart, count: number, findings: number, judged: boolean, asked: number, judging: ClaimJudging | undefined): TreePart {
  if (count === 0) return node;
  const badge = findings > 0 ? `${findingBadge(findings)} · ` : '';
  const text = `${badge}${claimCountText(count)}`;
  const state = judged
    ? findings > 0
      ? `${findings} refuted or unverifiable, each a thread on the diff; the overview lists them`
      : 'all verified; the overview lists them'
    : asked > 0
      ? `${asked} checked by the Verify this claim ask${findings > 0 ? `, ${findings} refuted or unverifiable, each a thread on the diff` : ''}, the ${judging === undefined ? 'verdicts pass did not run' : 'judging pass fell back'}; the overview lists them`
      : 'not checked yet; the overview lists them';
  const line = `${claimCountText(count)}, ${state}`;
  return {
    ...node,
    claims: count,
    ...(findings > 0 ? { findings } : {}),
    description: node.description === undefined ? text : `${text} · ${node.description}`,
    tooltip: node.tooltip === undefined ? line : `${node.tooltip}\n${line}`,
  };
}

/** How many claims each part holds that the Verify this claim ask judged alone, by the part's index. */
function askedCounts(claims: Claims | undefined, partCount: number): number[] {
  const counts = new Array<number>(partCount).fill(0);
  for (const claim of claims?.claims ?? []) {
    if (claim.asked === true && claim.part >= 0 && claim.part < partCount) counts[claim.part]!++;
  }
  return counts;
}

/** What a part whose content changed since the reviewer marked it says. */
export const CHANGED_SINCE_MARKED = 'changed since you marked it';

/**
 * A part's node with its reviewed state, and, when its content changed
 * since the reviewer marked it, the note saying so first beside the label
 * and in the tooltip.
 */
function withReviewed(node: TreePart, reviewed: ReviewedState): TreePart {
  if (reviewed !== 'changed since marked') return { ...node, reviewed };
  const line = `Unmarked: its content changed since you marked it reviewed.`;
  return {
    ...node,
    reviewed,
    description: node.description === undefined ? CHANGED_SINCE_MARKED : `${CHANGED_SINCE_MARKED} · ${node.description}`,
    tooltip: node.tooltip === undefined ? line : `${node.tooltip}\n${line}`,
  };
}

/** What a part that changed since the reviewer's last look says. */
export const CHANGED_SINCE_LAST_LOOK = 'changed since your last look';

/**
 * A part's node flagged as changed since the reviewer's last look: the
 * note beside the label — unless it already says it changed since it
 * was marked — and in the tooltip, with the commit the look was at.
 */
function withLastLook(node: TreePart, since: SinceLastLook, reviewed: ReviewedState): TreePart {
  const line =
    since.outcome === 'not compared'
      ? `Counts as changed: the change could not be compared with your last look at ${shortCommit(since.commit)}, because that commit is gone or no longer related.`
      : `Changed since your last look at ${shortCommit(since.commit)}.`;
  const description =
    reviewed === 'changed since marked'
      ? node.description
      : node.description === undefined
        ? CHANGED_SINCE_LAST_LOOK
        : `${CHANGED_SINCE_LAST_LOOK} · ${node.description}`;
  return {
    ...node,
    changedSinceLastLook: true,
    ...(description === undefined ? {} : { description }),
    tooltip: node.tooltip === undefined ? line : `${node.tooltip}\n${line}`,
  };
}

/** A commit as the reviewer reads it: its first seven characters. */
function shortCommit(commit: string): string {
  return commit.slice(0, 7);
}

/**
 * What changed since the reviewer's last look, in one line: the commit
 * the look was at, where it comes from and on which day, and how many
 * parts changed — or that the change could not be compared, so every
 * part counts as changed. Absent on the first look.
 */
export function sinceLastLookLine(result: ReviewResult): string | undefined {
  const since = result.sinceLastLook;
  if (since === undefined) return undefined;
  const look = since.from === 'github review' ? 'your last GitHub review' : 'your last look';
  const where = `${shortCommit(since.commit)} on ${since.at.slice(0, 10)}`;
  if (since.outcome === 'not compared') {
    return `The change could not be compared with ${look} at ${where}, because that commit is gone or no longer related: every part counts as changed.`;
  }
  const changed = result.parts.filter((part) => changedSinceLastLook(part, since)).length;
  const total = result.parts.length;
  return `Since ${look} at ${where}: ${changed} of ${total} part${total === 1 ? '' : 's'} changed.`;
}

/**
 * The line above the tree: what changed since the reviewer's last look,
 * saying when the filter shows only those parts, then the review's
 * status; see {@link reviewStatus}.
 */
export function treeMessage(result: ReviewResult, running?: string, filter: TreeFilter = {}): string | undefined {
  const since = sinceLastLookLine(result);
  const shown = since !== undefined && filter.onlyChangedSinceLastLook ? `${since} Showing only those.` : since;
  const lines = [shown, reviewStatus(result, running)].filter((line) => line !== undefined);
  return lines.length === 0 ? undefined : lines.join(' ');
}

/**
 * The tree view's badge: how many parts are left to review, with its
 * tooltip; absent once every part is reviewed.
 */
export function reviewBadge(result: ReviewResult, marks: ReviewedMarks): { value: number; tooltip: string } | undefined {
  const left = partsLeft(result.parts, marks);
  if (left === 0) return undefined;
  return { value: left, tooltip: `${left} of ${result.parts.length} part${result.parts.length === 1 ? '' : 's'} left to review` };
}

/** The badge of a part neither the description nor a linked issue explains. */
export const UNEXPLAINED_BADGE = '? unexplained';

/**
 * A part's node with the unexplained badge first beside the label, and
 * its reason in the tooltip; a part the comparison does not flag is left
 * as it is.
 */
function withUnexplained(node: TreePart, reason: string | undefined): TreePart {
  if (reason === undefined) return node;
  const line = `Unexplained: ${reason}`;
  return {
    ...node,
    unexplained: reason,
    description: node.description === undefined ? UNEXPLAINED_BADGE : `${UNEXPLAINED_BADGE} · ${node.description}`,
    tooltip: node.tooltip === undefined ? line : `${node.tooltip}\n${line}`,
  };
}

function rankedPart(part: Part, ranking: Ranking): TreePart {
  return {
    label: partLabel(part),
    description: part.rank!.reason,
    tooltip: [...part.rank!.signals, rankingLine(ranking), ...fileLines(part)].join('\n'),
    kind: 'part',
    part,
  };
}

function unrankedPart(part: Part): TreePart {
  const lines = fileLines(part);
  return {
    label: partLabel(part),
    tooltip: lines.length === 0 ? undefined : lines.join('\n'),
    kind: 'part',
    part,
  };
}

function noisePart(part: Part, noise: LabelledNoise): TreePart {
  return {
    label: partLabel(part),
    description: `${noise.label} · ${noise.state}`,
    tooltip: noise.blindSpot,
    kind: 'noise',
    part,
  };
}

/**
 * The status line above the tree: who grouped the parts shown — the
 * agent, with its model and the grouping prompt's version, or the plain
 * pass with the reason the agent's grouping was not used — then who
 * ranked them the same way, and the stage still running while one does.
 * A result the agent was never asked about needs no line.
 */
export function reviewStatus(result: ReviewResult, running?: string): string | undefined {
  const lines = [groupingLine(result), rankingStatus(result)].filter((line) => line !== undefined);
  if (running === undefined) return lines.length === 0 ? undefined : lines.join(' ');
  return lines.length === 0 ? `Plain parts shown; ${running}…` : `${lines.join(' ')} Now ${running}…`;
}

function groupingLine(result: ReviewResult): string | undefined {
  const agent = result.grouping.agent;
  if (agent === undefined) return undefined;
  if (agent.outcome === 'fell back') return `Plain grouping kept: ${agent.detail}.`;
  return `Grouped by ${agent.stamp.agent}${modelAndEffort(agent.stamp)} (grouping prompt v${agent.promptVersion}): ${agent.detail}.`;
}

function rankingStatus(result: ReviewResult): string | undefined {
  const agent = result.ranking.agent;
  if (agent === undefined) return undefined;
  if (result.ranking.by === 'plain' || agent.stamp === undefined) return `Plain ranking kept: ${agent.detail}.`;
  return `Ranked by ${agent.stamp.agent}${modelAndEffort(agent.stamp)} (ranking prompt v${agent.promptVersion}): ${agent.detail}.`;
}

/**
 * Where a part starts: its first file and that file's first hunk. Every
 * hunk belongs to exactly one part, so a later grouping of the same change
 * has exactly one part holding it.
 */
export interface PartAnchor {
  path: string;
  /** The first hunk's start on each side; absent for a file without hunks. */
  hunk?: { oldStart: number; newStart: number };
}

/** The anchor of a part: where it starts. */
export function anchorOf(part: Part): PartAnchor {
  const [first] = filesOfPart(part);
  const hunk = first!.hunks[0];
  return { path: first!.path, ...(hunk ? { hunk: { oldStart: hunk.oldStart, newStart: hunk.newStart } } : {}) };
}

/** Whether a file's share of a part holds the anchor's hunk, or is the anchor's hunkless file. */
function holdsAnchor(file: FileSlice, anchor: PartAnchor): boolean {
  if (file.path !== anchor.path) return false;
  const { hunk } = anchor;
  if (hunk === undefined) return file.hunks.length === 0;
  return file.hunks.some((each) => each.oldStart === hunk.oldStart && each.newStart === hunk.newStart);
}

/** The part of a result that holds the anchor's hunk, when one does. */
export function partAtAnchor(parts: readonly Part[], anchor: PartAnchor): Part | undefined {
  return parts.find((part) => filesOfPart(part).some((file) => holdsAnchor(file, anchor)));
}

/**
 * The tree node of the part that holds the anchor's hunk, when the tree
 * has one; the pending review's comments are never a part.
 */
export function findAnchor(sections: readonly TreeSection[], anchor: PartAnchor): TreePart | undefined {
  return sections
    .flatMap((section) => section.parts)
    .filter((node): node is TreePart => node.kind !== 'comment')
    .find(({ part }) => part !== undefined && filesOfPart(part).some((file) => holdsAnchor(file, anchor)));
}
