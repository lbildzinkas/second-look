import {
  IMPORTANCE_ORDER,
  isLabelledNoise,
  noiseSinks,
  type Comment,
  type Importance,
  type LabelledNoise,
  type Part,
  type ReviewResult,
} from '@second-look/engine';

/** One part as the tree shows it. */
export interface TreePart {
  /** The part's name in the tree: its path. */
  label: string;
  /** Shown beside the label: the one-line reason, or the noise label with its state. */
  description?: string;
  /** Shown on hover: the part's signals, one per line. */
  tooltip?: string;
  /** Marks the parts that sank below the ones a reviewer must read. */
  kind: 'part' | 'noise';
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

/** The title of the section for parts that arrive without a rank. */
export const NOT_RANKED_YET = 'Not ranked yet';

/** The title of the last section, where the noise parts sink. */
export const NOISE = 'Noise';

/** The title of the section the pending review gathers in, above the parts. */
export const PENDING_REVIEW = 'Pending review';

const SECTION_TITLES: Record<Importance, string> = {
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
 * groups in order, each part with its reason beside it and its signals in
 * its tooltip, then the parts that arrived without a rank, and the noise
 * last with its label and confirmed or claimed state.
 *
 * A part that arrives without a rank sits in its own section — the tree
 * shows whatever the engine returns, never inventing a rank. Empty
 * sections are left out, and snapshots and fixtures never sink, because a
 * change there is a behaviour change.
 */
export function buildTree(result: ReviewResult): TreeSection[] {
  const grouped = new Map<Importance, TreePart[]>(
    IMPORTANCE_ORDER.map((importance) => [importance, []]),
  );
  const notRanked: TreePart[] = [];
  const noise: TreePart[] = [];

  for (const part of result.parts) {
    const assessment = part.noise;
    if (assessment && isLabelledNoise(assessment) && noiseSinks(assessment)) {
      noise.push(noisePart(part, assessment));
      continue;
    }
    if (part.rank) {
      grouped.get(part.rank.importance)!.push(rankedPart(part));
      continue;
    }
    notRanked.push(unrankedPart(part));
  }

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
      label:
        comment.kind === 'line'
          ? `${comment.path}:${comment.line}`
          : `${comment.path} (part)`,
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

/** The line the tooltip adds for a label that never sinks its part. */
function labelledNotSunk(noise: LabelledNoise): string {
  return `${noise.label} · ${noise.state} — ${noise.blindSpot}`;
}

function rankedPart(part: Part): TreePart {
  const label = part.noise && isLabelledNoise(part.noise) ? labelledNotSunk(part.noise) : '';
  return {
    label: part.path,
    description: part.rank!.reason,
    tooltip: [...part.rank!.signals, label].filter((line) => line !== '').join('\n'),
    kind: 'part',
    part,
  };
}

function unrankedPart(part: Part): TreePart {
  const label = part.noise && isLabelledNoise(part.noise) ? labelledNotSunk(part.noise) : '';
  return {
    label: part.path,
    tooltip: label === '' ? undefined : label,
    kind: 'part',
    part,
  };
}

function noisePart(part: Part, noise: LabelledNoise): TreePart {
  return {
    label: part.path,
    description: `${noise.label} · ${noise.state}`,
    tooltip: noise.blindSpot,
    kind: 'noise',
    part,
  };
}
