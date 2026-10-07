import type { AskKind } from '@second-look/engine';

/** The commands the companion contributes, and the tree view it fills. */
export const REVIEW_COMMAND = 'second-look.reviewPullRequest' as const;

/** The side-bar tree view that ranks the parts. */
export const REVIEW_TREE_VIEW = 'second-look.reviewTree' as const;

/** Opens one part's files in the multi-file diff editor. */
export const OPEN_PART_COMMAND = 'second-look.openPart' as const;

/** Toggles the tree between every part and only the parts changed since the reviewer's last look. */
export const FILTER_CHANGED_COMMAND = 'second-look.filterChangedSinceLastLook' as const;

/** Opens the whole change in the multi-file diff editor, in ranked order. */
export const OPEN_ALL_PARTS_COMMAND = 'second-look.openAllParts' as const;

/**
 * Submits the pending review to GitHub as one review: comment, approve or
 * request changes. The protocol's one write happens here and only here.
 */
export const SUBMIT_REVIEW_COMMAND = 'second-look.submitReview' as const;

/**
 * Adds the comment the reviewer wrote in a diff editor's thread to the
 * pending review. The editor's comment input runs this command when it
 * submits, so nothing reaches GitHub until the review is sent.
 */
export const ADD_COMMENT_COMMAND = 'second-look.addComment' as const;

/** Starts a comment on a whole part, gathered in the pending review. */
export const COMMENT_ON_PART_COMMAND = 'second-look.commentOnPart' as const;

/** Discards one pending comment, removing it from the review to send. */
export const DISCARD_COMMENT_COMMAND = 'second-look.discardComment' as const;

/** The id of the companion's comment controller in the editor. */
export const COMMENT_CONTROLLER_ID = 'second-look' as const;

/** The context value the companion's pending comment threads carry. */
export const PENDING_THREAD_CONTEXT = 'second-look-pending' as const;

/** Opens the review's overview: the story, the description and who made each result. */
export const OPEN_OVERVIEW_COMMAND = 'second-look.openOverview' as const;

/** Opens the overview's story at one part: the tree's "why this matters" on each part. */
export const WHY_THIS_MATTERS_COMMAND = 'second-look.whyThisMatters' as const;

/** The id of the comment controller the companion shows its findings with. */
export const FINDINGS_CONTROLLER_ID = 'second-look.findings' as const;

/** The context value the companion's finding threads carry. */
export const FINDING_THREAD_CONTEXT = 'second-look-finding' as const;

/**
 * Presses one finding's library fetch: the engine downloads the library
 * at its pinned version — or the tag the agent named — and judges the
 * claim again. Runs only from the link in the finding's thread, which
 * the reviewer presses.
 */
export const FETCH_LIBRARY_COMMAND = 'second-look.fetchLibrary' as const;

/** Opens one file a verdict cites in a fetched library's source, read-only, at the cited line. */
export const OPEN_LIBRARY_EVIDENCE_COMMAND = 'second-look.openLibraryEvidence' as const;

/**
 * Drafts a comment from one finding: the engine's agent writes a short
 * draft from the finding and its evidence, which the reviewer edits and
 * adds to the pending review, or discards. Runs from the link in a
 * finding's thread and the overview's buttons, which the reviewer presses.
 */
export const DRAFT_COMMENT_COMMAND = 'second-look.draftComment' as const;

/** Adds a draft comment, as the reviewer edited it, to the pending review. */
export const ADD_DRAFT_COMMAND = 'second-look.addDraft' as const;

/** Discards a draft comment, thread and all, before it joins the pending review. */
export const DISCARD_DRAFT_COMMAND = 'second-look.discardDraft' as const;

/** The context value the companion's draft comments carry while the reviewer edits them. */
export const DRAFT_COMMENT_CONTEXT = 'second-look-draft' as const;

/**
 * The command that makes one ask (the glossary's ask) about a part, from
 * the part's context menu in the tree: one command for each kind in the
 * engine's ask registry, which the manifest declares with the ask's title.
 */
export function askCommand(kind: AskKind): string {
  return `second-look.ask.${kind}`;
}
