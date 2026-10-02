/**
 * Versioned result types shared by the engine and the extension.
 *
 * The engine prints a {@link ReviewResult} as JSON; the extension reads it
 * back over the language-neutral protocol (ADR 0005) and must accept exactly
 * the shape declared here. Bump {@link REVIEW_RESULT_VERSION} whenever the
 * shape changes in a way readers must check.
 */

/** Version of the review result schema. */
export const REVIEW_RESULT_VERSION = 2 as const;

/** Version 2 added the head commit's SHA and each part's noise assessment. */
export type ReviewResultVersion = typeof REVIEW_RESULT_VERSION;

/**
 * The level a part is given for review: **must review**, **worth
 * reviewing**, or **context** (the glossary's importance), always with a
 * one-line reason.
 */
export type Importance = 'must review' | 'worth reviewing' | 'context';

/** The importance levels in the order a reviewer reads them. */
export const IMPORTANCE_ORDER: readonly Importance[] = [
  'must review',
  'worth reviewing',
  'context',
];

/**
 * A part's ranking: its importance, the one-line reason beside it, and
 * the plain signals the reason cites. Absent while the engine does not
 * rank parts yet; a reader then shows the part ungrouped rather than
 * guessing an importance for it.
 */
export interface PartRank {
  importance: Importance;
  /** One line saying why the part has this importance. */
  reason: string;
  /** The plain, model-free facts about the part that the reason cites. */
  signals: string[];
}

/** How one file changed, as told by its diff header. */
export type ChangeKind =
  /** A newly added file. */
  | 'addition'
  /** A deleted file. */
  | 'deletion'
  /** An edited file that kept its path. */
  | 'modification'
  /** A file whose path changed, with or without edits. */
  | 'rename'
  /** A file copied from another path, with or without edits. */
  | 'copy';

/** The review result the engine produces for one pull request. */
export interface ReviewResult {
  /** Schema version; compare against {@link REVIEW_RESULT_VERSION}. */
  version: ReviewResultVersion;
  pullRequest: PullRequestSummary;
  /** The read-only copies of the base and head versions the engine read. */
  copies: ChangeCopies;
  /** Time spent parsing syntax trees across all parts, in milliseconds. */
  parseTimeMs: number;
  /**
   * One part per changed file at this step. Every changed line of the diff
   * belongs to exactly one part; the engine proves this before printing.
   */
  parts: Part[];
}

/** Pull request metadata the companion keeps alongside the parts. */
export interface PullRequestSummary {
  /** The pull request's HTML URL, as given to the engine. */
  url: string;
  number: number;
  title: string;
  /** Author login, or the empty string when GitHub does not report one. */
  author: string;
  /** The full description, exactly as GitHub stores it, never truncated. */
  description: string;
  /** Name of the branch the change is based on. */
  base: string;
  /** Name of the branch the change comes from. */
  head: string;
  /** Commit at the tip of the base branch the pull request compares with. */
  baseCommit: string;
  /**
   * The head commit's full SHA; the head copy is taken here and the noise
   * attributes are read at it.
   */
  headSha: string;
}

/**
 * The read-only copies of the change, downloaded as archives into a
 * per-pull-request cache. Nothing is checked out in the reviewer's
 * workspace and nothing from the pull request runs.
 */
export interface ChangeCopies {
  /** The base version: the merge base the diff is computed against. */
  base: ChangeCopy;
  /** The head version: the pull request's head commit. */
  head: ChangeCopy;
}

/** One read-only copy of the repository at one commit. */
export interface ChangeCopy {
  commit: string;
  /** Absolute path of the copy in the engine's cache. */
  path: string;
  /** True when an earlier run's copy at the same commit was reused. */
  reused: boolean;
}

/**
 * One noise label the rules can attach to a part. A part whose label is
 * lockfile, generated, vendored or moved or renamed sinks below the parts
 * a reviewer must read; snapshot and fixture parts are labelled but never
 * sunk, because a change there is a behaviour change.
 */
export type NoiseLabel =
  /** A dependency lock file, such as a lockfile or a checksum file. */
  | 'lockfile'
  /** A file a tool wrote, or third-party code vendored into the repository. */
  | 'generated'
  | 'vendored'
  /** A file that only moved or was renamed, with identical content. */
  | 'moved or renamed'
  /** A recorded expected output, such as a test snapshot. */
  | 'snapshot'
  /** Fixed input a test runs against. */
  | 'fixture';

/** The rule that attached a label; named for the reviewer to read. */
export type NoiseRule =
  | 'rename-identical'
  | 'snapshot-name'
  | 'fixture-path'
  | 'linguist-generated'
  | 'linguist-vendored'
  | 'lockfile-name'
  | 'generated-name'
  | 'generated-header';

/**
 * How a label was established: **confirmed** when a check proved it (here,
 * a rename whose diff shows no other change), **claimed** when a rule
 * matched and nothing was checked.
 */
export type NoiseState = 'confirmed' | 'claimed';

/**
 * A noise assessment some rule attached, as opposed to the plain "none"
 * verdict: a label with its rule, state and blind spot.
 */
export type LabelledNoise = Extract<NoiseAssessment, { rule: NoiseRule }>;

/**
 * What the noise rules decided about one part: a label with its state and
 * one-line blind spot, or the plain statement that no rule applied — the
 * companion states the miss instead of staying silent (ADR 0001).
 */
export type NoiseAssessment =
  | {
      label: 'none';
      /** Always "no rule applied"; the label itself carries no blind spot. */
      note: 'no rule applied';
    }
  | {
      label: NoiseLabel;
      /** The rule that matched. */
      rule: NoiseRule;
      /** Whether a check proved the label or a rule merely claimed it. */
      state: NoiseState;
      /** One line stating what the rule can miss. */
      blindSpot: string;
    };

/**
 * A named group of related edits. At this step every part is exactly one
 * file; later steps may group related files into one part. Every changed
 * line belongs to exactly one part.
 */
export interface Part {
  /** The file's path on the new side (after any rename). */
  path: string;
  /** The file's path on the old side, when the diff renames the file. */
  previousPath?: string;
  changeKind: ChangeKind;
  /** True when the changed content is binary, so there are no hunks to read. */
  isBinary: boolean;
  /** File mode on the old side, when the diff reports one. */
  oldMode?: string;
  /** File mode on the new side, when the diff reports one. */
  newMode?: string;
  /** True when the old side of the file ends without a final newline. */
  oldMissingFinalNewline: boolean;
  /** True when the new side of the file ends without a final newline. */
  newMissingFinalNewline: boolean;
  hunks: Hunk[];
  /** Number of added lines across all hunks. */
  additions: number;
  /** Number of removed lines across all hunks. */
  deletions: number;
  /**
   * The noise rules' verdict on this part. The engine sets it on every
   * part before printing, so a reader of the result never sees a part
   * without one; the type keeps it optional because the diff parser
   * produces parts before any rule has run.
   */
  noise?: NoiseAssessment;
  /** What the syntax trees tell about this file's change. */
  syntax: PartSyntax;
  /**
   * The part's ranking. The engine does not rank parts yet, so this is
   * absent until ranking lands; readers show unranked parts in their own
   * section instead of placing them anywhere.
   */
  rank?: PartRank;
}

/** A check the syntax pass runs on each changed file. */
export type SyntaxCheck =
  /** Naming the entities each hunk touches. */
  | 'entities'
  /** Confirming a change is formatting-only. */
  | 'formatting-only';

/** A check that could not run on a file, and why (ADR 0001). */
export interface CheckNotRun {
  check: SyntaxCheck;
  reason: string;
}

/** The syntax pass's findings for one file. */
export interface PartSyntax {
  /** The grammar that parsed the file, when one applies. */
  language?: string;
  formattingOnly: FormattingOnly;
  /**
   * Checks that could not run on this file, each with its reason. When
   * `entities` is listed, hunks fall back to file level: they name no
   * entities.
   */
  checksNotRun: CheckNotRun[];
}

/** Outcome of the formatting-only check. */
export type FormattingOnlyStatus =
  /**
   * The structural signatures of base and head match, nesting included:
   * the change is confirmed formatting-only noise.
   */
  | 'confirmed'
  /** The structure differs, so the change is not formatting-only. */
  | 'structure-changed'
  /** The check could not run; the reason says why. */
  | 'not-checked';

export interface FormattingOnly {
  status: FormattingOnlyStatus;
  /** One plain line saying why. */
  reason: string;
}

/** The kind of a named code entity. */
export type EntityKind =
  | 'class'
  | 'struct'
  | 'interface'
  | 'enum'
  | 'trait'
  | 'impl'
  | 'type'
  | 'function'
  | 'method'
  | 'property';

/** A named code entity, such as a function, class or method. */
export interface Entity {
  kind: EntityKind;
  /** Name qualified by its enclosing entities, outermost first: `Cart.total`. */
  name: string;
}

/** One hunk of a unified diff: a run of changed lines with surrounding context. */
export interface Hunk {
  /** Line number (1-based) where the hunk starts on the old side. */
  oldStart: number;
  /** Number of lines the hunk spans on the old side. */
  oldLines: number;
  /** Line number (1-based) where the hunk starts on the new side. */
  newStart: number;
  /** Number of lines the hunk spans on the new side. */
  newLines: number;
  /** The section heading git writes after the @@ ranges, when present. */
  heading?: string;
  lines: DiffLine[];
  /**
   * The innermost entities the hunk's changed lines fall in, removed lines
   * read from the base copy and added lines from the head copy, in order of
   * first appearance. Empty when the hunk touches only top-level code or
   * when the file is named at file level.
   */
  entities: Entity[];
}

export type DiffLineKind = 'context' | 'addition' | 'deletion';

/** One line of a hunk. */
export interface DiffLine {
  kind: DiffLineKind;
  /** 1-based line number on the old side; absent on additions. */
  oldLineNumber?: number;
  /** 1-based line number on the new side; absent on deletions. */
  newLineNumber?: number;
  /** The line's content, without its diff prefix. */
  text: string;
  /**
   * True when the side this line ends lacks a final newline; set from the
   * `\ No newline at end of file` marker that follows it.
   */
  endsWithoutNewline?: boolean;
}
