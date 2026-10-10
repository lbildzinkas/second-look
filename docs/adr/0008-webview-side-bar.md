# The side bar is one webview view

The companion's side bar becomes one webview view that carries the whole review path, replacing the native tree of parts. The review path walks the reviewer through eight steps on cards: set up the agent, pick a pull request, follow the review as it runs, read the story and the parts, the claims and their verdicts, the acceptance criteria and unexplained changes, the comments, and sending the review. Each step's card holds its state, its actions and its findings, which a native tree cannot show: a setup form, a pull request list with short descriptions, a progress strip, and finding cards with their buttons. This is the one guided, richer surface chosen for v1.1, drawn in [review-path.html](../ux/review-path.html).

What stays native: every VS Code command stays registered, so the Command Palette and keybindings keep working alongside the side bar; the diff editor, the comment threads and the part banner ([ADR 0007](0007-part-banner-as-a-file-comment.md)) stay VS Code's own, so the reviewer still reads and comments on the real diff. The overview stays its own editor tab, and the agent setting stays reachable from the status bar.

## Considered Options

- The native tree with a section per step: rejected, because a tree row holds a label, a description, an icon and a checkbox, with no room for a form, a description under a pull request, a progress strip or buttons on a finding; the richer look would have to live elsewhere, so the path would not be one guided surface.
- A stepper header above native trees: rejected, because it splits the side bar into a webview strip and trees below it, so the reviewer moves between two kinds of surface with different focus and keyboard behaviour, and the steps' content still has to fit tree rows.

## Consequences

Second Look draws its own checkboxes, focus, keyboard navigation and ARIA roles in the side bar, which VS Code's tree provided for free, so screen readers and keyboard users keep working only as far as the webview implements them. That makes the side bar larger to build and to test than the tree. Colours come from VS Code's theme variables so the side bar follows the reviewer's theme. The reviewed mark keeps one meaning: the checkbox on a part's row, the part banner and the part's menu act through the same commands.
