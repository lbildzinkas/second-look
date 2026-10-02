import {
  IMPORTANCE_ORDER,
  isLabelledNoise,
  noiseSinks,
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

/** One section of the tree: an importance group, the unranked parts, or noise. */
export interface TreeSection {
  /** The section's title. */
  label: string;
  /** What the section means, shown on hover. */
  tooltip: string;
  parts: TreePart[];
}

/** The title of the section for parts that arrive without a rank. */
export const NOT_RANKED_YET = 'Not ranked yet';

/** The title of the last section, where the noise parts sink. */
export const NOISE = 'Noise';

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
    .filter((part) => part.part !== undefined)
    .map((part) => part.part!);
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