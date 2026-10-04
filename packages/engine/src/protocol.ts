/**
 * Versioned result types shared by the engine and the extension.
 *
 * The engine prints a {@link ReviewResult} as JSON; the extension reads it
 * back over the language-neutral protocol (ADR 0005) and must accept exactly
 * the shape declared here. Bump {@link REVIEW_RESULT_VERSION} whenever the
 * shape changes in a way readers must check.
 */

import type { AgentStamp } from './agent.js';

/** Version of the review result schema. */
export const REVIEW_RESULT_VERSION = 8 as const;

/**
 * Version 2 added the head commit's SHA and each part's noise assessment;
 * version 3 split files into named parts by the entities their hunks touch,
 * with each part's signals and rank, each entity's visibility and how the
 * hunk changes it, and added the lockfile rules lockfile-follows-manifest
 * and lockfile-unexplained; version 4 let a part span files, with each
 * part's origin and the result's grouping; version 5 added the result's
 * ranking; version 6 added the result's story; version 7 added the
 * result's claims; version 8 added each claim's checked verdict, with its
 * evidence and evidence source, and the claims' judging.
 */
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
 * the plain signals the reason cites. The engine ranks every part before
 * printing; a reader that meets a part without one shows it ungrouped
 * rather than guessing an importance for it.
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

/**
 * How the reviewer submits the pending review to GitHub: as a plain
 * comment, an approval, or a request for changes.
 */
export type SubmitKind = 'comment' | 'approve' | 'request changes';

/** The side of the change a comment's line sits on: the base or the head. */
export type CommentSide = 'base' | 'head';

/**
 * A comment the reviewer wrote in the companion and sends to GitHub as
 * part of one pending review (ADR 0002): on one line of the diff, or on a
 * whole part. The companion never posts it anywhere until the reviewer
 * presses send.
 */
export type Comment =
  | {
      /** A comment on one line of the diff. */
      kind: 'line';
      /** The file, by its path on the new side, as GitHub names it. */
      path: string;
      /** The side the line sits on: the base copy or the head copy. */
      side: CommentSide;
      /** The line's 1-based number on that side. */
      line: number;
      /** The comment's text, exactly as the reviewer wrote it. */
      body: string;
    }
  | {
      /** A comment on a whole part, which GitHub anchors to the file. */
      kind: 'part';
      /** The file, by its path on the new side, as GitHub names it. */
      path: string;
      /** The comment's text, exactly as the reviewer wrote it. */
      body: string;
    };

/**
 * The pending review the companion gathers: every comment the reviewer
 * wrote, plus how they submit it and its overall comment on the whole
 * pull request. Nothing in it has reached GitHub yet.
 */
export interface PendingReview {
  /** How the reviewer submits: comment, approve or request changes. */
  submit: SubmitKind;
  /** The review's overall comment on the whole pull request, when it has one. */
  body?: string;
  comments: Comment[];
}

/** The review that reached GitHub, with the link the reviewer reads it at. */
export interface SentReview {
  /** The review's HTML URL on GitHub. */
  url: string;
}

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
   * The named parts in review order: must review, worth reviewing, then
   * context, with the sinking noise parts last. Every changed line of the
   * diff belongs to exactly one part; the engine proves this before
   * printing.
   */
  parts: Part[];
  /** Who grouped the parts: the plain pass, or the agent, and what came of asking it. */
  grouping: Grouping;
  /** Who ranked the parts: the plain rule, or the agent, and what came of asking it. */
  ranking: Ranking;
  /** The story the agent wrote of the parts shown; absent when no agent was asked. */
  story?: Story;
  /** The claims the change makes, as the agent listed them; absent when no agent was asked. */
  claims?: Claims;
}

/**
 * The claims a change makes about how code or a library behaves, as the
 * agent listed them and the engine checked them: every claim quoted from
 * its source, located there and attached to a part, in the order of its
 * source's priority. Each starts as not checked, and keeps that verdict
 * until the agent judges it.
 */
export interface Claims {
  /** The version of the claims prompt. */
  promptVersion: string;
  /**
   * `listed` when the claims are shown, none being a valid list;
   * `fell back` when the agent's answer was missing or failed the
   * checks, so no claim is listed.
   */
  outcome: 'listed' | 'fell back';
  /** One plain line: how the claims were checked, or why there are none. */
  detail: string;
  stamp: AgentStamp;
  /** The claims, in their sources' priority order; empty when the pass fell back. */
  claims: Claim[];
  /** What came of asking the agent to judge the claims; absent until it was asked. */
  judging?: ClaimJudging;
}

/**
 * The verdicts stage's outcome: the agent judged each claim against the
 * change and the read-only copy, and the engine re-checked every citation.
 */
export interface ClaimJudging {
  /** The version of the verdicts prompt. */
  promptVersion: string;
  /**
   * `judged` when the claims carry the agent's verdicts, as the re-check
   * left them; `fell back` when its answer was missing or invalid, so
   * every claim stays not checked.
   */
  outcome: 'judged' | 'fell back';
  /** One plain line: how the verdicts were checked, or why there are none. */
  detail: string;
  stamp: AgentStamp;
}

/**
 * Where a claim is made, in priority order: the pull request's
 * description, a docstring or a comment the change adds, or the
 * companion's own agent, in the story it wrote.
 */
export type ClaimSource = 'description' | 'docstring' | 'comment' | 'agent';

/** The claim sources in priority order, the order the claims are listed in. */
export const CLAIM_SOURCE_ORDER: readonly ClaimSource[] = ['description', 'docstring', 'comment', 'agent'];

/** Where in its source a claim's quote sits. */
export type ClaimLocation =
  | {
      /** In the pull request's description. */
      kind: 'description';
      /** The 1-based line of the description the quote starts on. */
      line: number;
    }
  | {
      /** In lines the change adds to a file. */
      kind: 'file';
      /** The file, by its path on the new side. */
      path: string;
      /** The 1-based head-side line the quote starts on. */
      line: number;
      /** The 1-based head-side line the quote ends on. */
      endLine: number;
    }
  | {
      /** In the story the companion's agent wrote. */
      kind: 'story';
      /** The sentence, by its index in the story's sentences. */
      sentence: number;
    };

/**
 * Where a verdict's evidence came from (the glossary's evidence source):
 * the change itself — its diff and the read-only copy of its head —
 * library source at the pinned version, a CI log, the issue text, or the
 * model's memory, which never yields verified.
 */
export type EvidenceSource =
  | 'the change itself'
  | 'library source at the pinned version'
  | 'a CI log'
  | 'the issue text'
  | "the model's memory";

/** The evidence sources, in the glossary's order. */
export const EVIDENCE_SOURCES: readonly EvidenceSource[] = [
  'the change itself',
  'library source at the pinned version',
  'a CI log',
  'the issue text',
  "the model's memory",
];

/** A checked verdict's kind: what judging a claim can come to. */
export type CheckedVerdictKind = 'verified' | 'refuted' | 'unverifiable';

/** The checked verdict kinds, the order a reviewer reads them in. */
export const CHECKED_VERDICT_KINDS: readonly CheckedVerdictKind[] = ['refuted', 'unverifiable', 'verified'];

/**
 * One line of the head copy a verdict cites as evidence: the file, the
 * line its quote starts on and the quote. The engine re-reads every
 * citation and keeps only those whose line holds the quote.
 */
export interface Citation {
  /** The file, by its path in the head copy. */
  path: string;
  /** The 1-based line the quote starts on. */
  line: number;
  /** The quote, on one line: runs of white space as one space. */
  quote: string;
}

/**
 * The outcome of checking a claim (the glossary's verdict). A claim is
 * listed before any check runs, so it starts as not checked; once judged,
 * it is verified, refuted or unverifiable, always with its evidence source
 * and its reason.
 */
export type ClaimVerdict =
  | { kind: 'not checked' }
  | {
      kind: CheckedVerdictKind;
      /** Where the evidence came from; the model's memory never yields verified. */
      source: EvidenceSource;
      /** One plain line saying why the claim has this verdict. */
      reason: string;
      /** The lines of the head copy that bear the verdict out, each re-checked by the engine. */
      evidence: Citation[];
      /**
       * The library whose source the claim needs, when the change cannot
       * settle it without; the companion never fetches it on its own
       * (ADR 0003).
       */
      needsLibrary?: string;
      /** Why the engine dropped the agent's verdict to unverifiable, when it did. */
      recheck?: string;
    };

/**
 * A statement about how code or a library behaves (the glossary's claim),
 * quoted from where the change makes it.
 */
export interface Claim {
  /**
   * The quote, exactly as its source has it, on one line: runs of white
   * space as one space, and each line's leading comment marker dropped.
   */
  quote: string;
  source: ClaimSource;
  location: ClaimLocation;
  /** The part the claim is about, by its index in the result's parts. */
  part: number;
  verdict: ClaimVerdict;
}

/**
 * The story: a few sentences at the top of the review that tell what the
 * change does, in the order the parts should be read, each part it
 * mentions linked. The agent writes it of the parts the result shows,
 * after they are grouped and ranked, and the engine checks it before
 * showing any.
 */
export interface Story {
  /** The version of the story prompt. */
  promptVersion: string;
  /**
   * `written` when the story is shown; `fell back` when the agent's
   * answer was missing or failed the checks, so there is no story.
   */
  outcome: 'written' | 'fell back';
  /** One plain line: how the story was checked, or why there is none. */
  detail: string;
  stamp: AgentStamp;
  /** The sentences in reading order; empty when the story fell back. */
  sentences: StorySentence[];
}

/** One sentence of the story, as runs of text. */
export interface StorySentence {
  segments: StorySegment[];
}

/**
 * A run of a story sentence: plain text, a code or file name the change
 * shows, or the words that link a part.
 */
export interface StorySegment {
  text: string;
  /** The linked part, by its index in the result's parts. */
  part?: number;
  /** True for a code or file name, which the reader sees set as code. */
  code?: boolean;
}

/**
 * Who grouped a result's parts. The plain pass always runs first; when
 * the agent is asked to group too, its outcome says whether its parts
 * replaced the plain ones or why the plain grouping stayed.
 */
export interface Grouping {
  /** The pass whose parts the result shows. */
  by: 'plain' | 'agent';
  /** What came of asking the agent; absent when it was not asked. */
  agent?: AgentGrouping;
}

/** The agent grouping stage's outcome, stamped with who answered. */
export interface AgentGrouping {
  /** The version of the grouping prompt the agent was given. */
  promptVersion: string;
  /**
   * `grouped` when the agent's parts are shown; `fell back` when its
   * answer was missing or invalid, so the plain grouping stayed.
   */
  outcome: 'grouped' | 'fell back';
  /** One plain line: why the plain grouping stayed, or how the agent's parts were checked. */
  detail: string;
  /** Hunks the agent left out, which went to a part marked not grouped by the agent. */
  leftOut: number;
  stamp: AgentStamp;
}

/**
 * Who ranked a result's parts. The plain rule always ranks first; with an
 * agent, its ranking is shown only when its answer passed the validator
 * and the agent, model and effort are ones whose evaluation matched or
 * beat the plain ranking. The sinking noise parts keep their plain rank
 * either way.
 */
export interface Ranking {
  /** The ranking the result shows. */
  by: 'plain' | 'agent';
  /** What came of the agent ranking stage; absent when there was none. */
  agent?: AgentRanking;
}

/** The agent ranking stage's outcome. */
export interface AgentRanking {
  /** The version of the ranking prompt. */
  promptVersion: string;
  /**
   * `ranked` when the agent's ranking is shown; `fell back` when its
   * answer was missing or the validator rejected it; `not tested` when
   * the agent, model or effort has no evaluation in which the agent
   * ranking matched or beat the plain one. The plain ranking stays unless ranked.
   */
  outcome: 'ranked' | 'fell back' | 'not tested';
  /** One plain line: why the plain ranking stayed, or how the agent's was checked. */
  detail: string;
  /** Who answered; absent when the agent was not asked. */
  stamp?: AgentStamp;
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

/**
 * The rule that attached a label; named for the reviewer to read. The
 * lockfile rules: `lockfile-name` claims the label from the file's name
 * alone (no check for that lockfile), `lockfile-follows-manifest`
 * confirms it with the parse-only check, and `lockfile-unexplained`
 * keeps it claimed with the entries the manifest change does not explain
 * named in the blind spot.
 */
export type NoiseRule =
  | 'rename-identical'
  | 'snapshot-name'
  | 'fixture-path'
  | 'linguist-generated'
  | 'linguist-vendored'
  | 'lockfile-name'
  | 'lockfile-follows-manifest'
  | 'lockfile-unexplained'
  | 'generated-name'
  | 'generated-header';

/**
 * How a label was established: **confirmed** when a check proved it (a
 * rename whose diff shows no other change, or the parse-only lock file
 * check), **claimed** when a rule matched and nothing was checked.
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
 * Who grouped a part's hunks: the plain pass (one file's hunks that touch
 * the same entities), the agent (related hunks across files), or nobody,
 * for the hunks the agent left out.
 */
export type PartOrigin = 'plain' | 'agent' | 'not grouped by the agent';

/** One file's share of a part: the file's own fields and the hunks of it the part holds. */
export type FileSlice = Omit<Part, 'name' | 'signals' | 'rank' | 'origin' | 'otherFiles'>;

/**
 * A named group of related edits. The plain pass gives a part the hunks of
 * one file that touch the same entities, so a file splits into one part
 * per group of entities, plus one part for the hunks that touch no entity;
 * the agent's parts can group related hunks across files. The part's own
 * file fields (path, change kind, modes, hunks, line counts, noise,
 * syntax) describe its first file, and {@link Part.otherFiles} holds the
 * rest. Every changed line belongs to exactly one part.
 */
export interface Part {
  /**
   * The part's name: the entities its hunks touch and the file, such as
   * `Cart.total in web/cart.ts`; `top-level code in app/x.py` for hunks
   * outside every entity; the bare path when the file's entities could not
   * be named. The engine sets it on every part before printing; the diff
   * parser's parts have none yet.
   */
  name?: string;
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
  /** The plain facts ranking cites; set on every part before printing. */
  signals?: PartSignals;
  /**
   * The part's ranking: its importance with its reason and the signals
   * the reason cites. The engine sets it on every part before printing;
   * a reader that meets a part without one shows it ungrouped rather than
   * guessing an importance for it.
   */
  rank?: PartRank;
  /** Who grouped the part's hunks; set on every part before printing. */
  origin?: PartOrigin;
  /**
   * The part's share of further files, in diff order, when it groups
   * hunks across files; absent when the part stays within one file.
   */
  otherFiles?: FileSlice[];
}

/** Whether a part's code is new, changed or removed. */
export type Novelty =
  /** The file is added, or every entity the part touches is added and no line is removed. */
  | 'new'
  /** The file is deleted, or every entity the part touches is removed and no line is added. */
  | 'removed'
  /** Anything else: the part edits code that was already there. */
  | 'changed';

/** Whether a part's file is a test, by its path. */
export type PartRole = 'test' | 'code';

/**
 * How many other files in the head copy mention the part's entity names.
 * The count matches names as whole words in any file's text, without
 * resolving what a name refers to, and is labelled so.
 */
export interface ReferenceSignal {
  basis: 'name-based';
  /** The names searched for: each entity's own name, the type's for a dunder method. */
  names: string[];
  /** Number of other files in the head copy that contain any of the names. */
  files: number;
}

/** The plain, model-free facts about a part that ranking must cite. */
export interface PartSignals {
  novelty: Novelty;
  role: PartRole;
  /** Added plus removed lines. */
  changedLines: number;
  /**
   * The public entities the part adds, removes, or whose declaration it
   * changes, in order of first appearance; empty when it changes none or
   * when the file's entities could not be named.
   */
  publicSurface: string[];
  references: ReferenceSignal;
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

/** How a hunk's changed lines change an entity. */
export type EntityChange =
  /** The head declares the entity and the base did not. */
  | 'added'
  /** The base declared the entity and the head does not. */
  | 'removed'
  /**
   * A changed line falls on the entity's declaration: its header, from any
   * decorator or modifier to where its body opens, or the whole of a type,
   * interface, enum, struct or trait, whose members are its surface.
   */
  | 'declaration'
  /** Only lines inside the entity's body changed. */
  | 'body';

/** A named code entity, such as a function, class or method. */
export interface Entity {
  kind: EntityKind;
  /** Name qualified by its enclosing entities, outermost first: `Cart.total`. */
  name: string;
  /**
   * True when the language's visibility rules let other modules use the
   * entity and every entity enclosing it: exported in TypeScript and
   * JavaScript, public or protected in C# and Java, `pub` in Rust, a
   * capitalised name in Go, no leading underscore in Python. An entity
   * inside a function, method or property is never public.
   */
  public: boolean;
  /** How the hunk changes it; the strongest change wins across its lines. */
  change: EntityChange;
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
