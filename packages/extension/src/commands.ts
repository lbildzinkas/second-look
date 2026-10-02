/** The commands the companion contributes, and the tree view it fills. */
export const REVIEW_COMMAND = 'second-look.reviewPullRequest' as const;

/** The side-bar tree view that ranks the parts. */
export const REVIEW_TREE_VIEW = 'second-look.reviewTree' as const;

/** Opens one part's files in the multi-file diff editor. */
export const OPEN_PART_COMMAND = 'second-look.openPart' as const;

/** Opens the whole change in the multi-file diff editor, in ranked order. */
export const OPEN_ALL_PARTS_COMMAND = 'second-look.openAllParts' as const;
