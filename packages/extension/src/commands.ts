/** The commands the companion contributes, and the tree view it fills. */
export const REVIEW_COMMAND = 'second-look.reviewPullRequest' as const;

/** The side-bar tree view that ranks the parts. */
export const REVIEW_TREE_VIEW = 'second-look.reviewTree' as const;

/** Opens one part's files in the multi-file diff editor. */
export const OPEN_PART_COMMAND = 'second-look.openPart' as const;

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
