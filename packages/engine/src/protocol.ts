/**
 * Versioned result types shared by the engine and the extension.
 *
 * The engine prints a {@link ReviewResult} as JSON; the extension reads it
 * back over the language-neutral protocol (ADR 0005) and must accept exactly
 * the shape declared here. Bump {@link REVIEW_RESULT_VERSION} whenever the
 * shape changes in a way readers must check.
 */

/** Version of the review result schema. */
export const REVIEW_RESULT_VERSION = 1 as const;

export type ReviewResultVersion = typeof REVIEW_RESULT_VERSION;

/** How one file changed, as told by its diff header. */
export type ChangeKind =
  /** A newly added file. */
  | 'addition'
  /** A deleted file. */
  | 'deletion'
  /** An edited file that kept its path. */
  | 'modification'
  /** A file whose path changed, with or without edits. */
  | 'rename';

/** The review result the engine produces for one pull request. */
export interface ReviewResult {
  /** Schema version; compare against {@link REVIEW_RESULT_VERSION}. */
  version: ReviewResultVersion;
  pullRequest: PullRequestSummary;
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
}

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
