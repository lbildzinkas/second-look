# Reviewing surface

How a review looks in VS Code. Three options were compared side by side on one invented pull request at six moments; this records the one chosen and why. The mockup of the chosen design is [reviewing-surface.html](reviewing-surface.html), a self-contained page you open in a browser.

## The choice

The **ranked tree** throughout, with a **Send review page** for submitting the review.

- The ranked tree is the accepted base surface: a side-bar tree of parts in importance order with reviewed checkboxes and badges, VS Code's own multi-file diff over read-only files, findings as comment threads on the exact lines, and an overview tab with the story, the acceptance criteria and the checks.
- Sending the review is the one moment taken from another option, the story reader: a page that lists every draft comment for one last pass before the reviewer submits them as one GitHub review.

Sending ships as the **Send review page** — the interim quick pick it first shipped as, the kind then the overall comment, was replaced by the page.

## Main screens

1. **First open, results still arriving.** The overview tab shows the story as soon as it is ready, with a chip for each stage still running. The tree already ranks the parts and shows a spinner on each part whose claims are still being checked. The most important part is checked first.
2. **Reading a must-review part.** Selecting a part opens the multi-file diff for just that part. A banner above the diff gives the importance with its one-line reason, the signals, the three asks and the reviewed checkbox. Findings are comment threads on their lines; verified claims are quiet lines above the code.

   The banner is a read-only comment thread at the top of the part's first file ([ADR 0007](../adr/0007-part-banner-as-a-file-comment.md)); the asks stay in each part's context menu and the reviewed checkbox in the tree as well, and the banner, the context menu and the tree act alike.
3. **A refuted claim and a library fetch.** A refuted claim is a thread on the line that makes it, with its verdict, evidence source and the library source at the pinned version. A claim that needs library source the companion does not have offers the fetch, with its reason; the reviewer starts it.
4. **Acceptance criteria.** The overview tab lists each criterion with its verdict, code, tests and manual checks, then unexplained changes in both directions, then CI results on the merge commit.
5. **Drafting a comment.** A finding becomes a draft comment in its thread. The reviewer edits it and adds it to the pending review, which gathers in its own side-bar section.
6. **Sending the review.** "Submit review…" opens the Send review page: every draft with where it points and which finding it came from, a whole-pull-request comment, a choice of Request changes, Comment or Approve, and one Submit button. Nothing reaches GitHub before that press.
7. **Second visit.** New commits clear the reviewed marks of the parts they touched and mark those parts in the tree. The diff shows only what changed since the last look, and the companion says which findings were resolved and who replied.

Every result carries its model stamp.

## Why

- **The ranked tree keeps the reviewer in VS Code's own editor.** The real diff, comment threads, go to definition and keyboard flow all keep working, and it sits naturally beside the GitHub pull request extension. It is also the closest to the walking skeleton, so it is the cheapest to build.
- **The Send review page makes submitting a deliberate step.** Seeing every draft together, with its source, before choosing the review type serves the rule that the reviewer sends every comment ([ADR 0002](../adr/0002-reviewer-sends-every-comment.md)) better than a quick pick does.

## Options not chosen

- **Story reader.** One editor-wide page that reads like an article: the story, each part in order with its diff and findings inline, then the criteria, then the review to send. It is the easiest start on unfamiliar code, but the diff is a webview copy rather than VS Code's editor, and jumping around breaks the flow. Only its send page was kept.
- **Findings triage.** An inbox of findings sorted by what needs a decision, with each finding's code and evidence on the right. It is fast on large changes, but it invites reviewing only what was flagged, it shrinks the story to one line, and it needs the most custom interface.

## v1.1 review path

The v1.1 design takes the reviewer from first open to sending the review in one guided path in the side bar. The mockup is [review-path.html](review-path.html), a self-contained page you open in a browser; it shows each step on a real review, and its appendix lists every decision, where each command, ask and setting lives, and the colours in four themes. The side bar becomes one webview view in place of the ranked tree ([ADR 0008](../adr/0008-webview-side-bar.md)); the diff editor, the comment threads, the part banner and the Send review page stay as above.

### The eight steps

1. **First open: set up the agent, model and effort.** Step 1's card opens by itself once, with a form for the agent, the model, the effort and an optional account label. The status bar always shows the agent, the model and the effort, and clicking it opens a quick pick to change any of them.
2. **Pick a pull request.** A list in the side bar, with each pull request's short description, review state and size, grouped as review requested, yours, involving you and open in this repository. Pasting a pull request URL works too.
3. **The review starts.** The agent's work shows in the side bar, as a progress strip and a spinner on the running step, and in the overview, as a stage list with placeholders where results are still arriving. A notification appears only when a stage falls back or fails.
4. **Read the story, then review the parts.** The overview tells the story; the side bar lists the parts, must review first, with their reviewed marks and asks.
5. **Claims and verdicts.** Findings come first, as cards with their actions; confirmed claims fold below them. The overview's contents rail jumps to Claims.
6. **Acceptance criteria and unexplained changes.** Each criterion with its verdict and evidence, then unexplained changes in both directions.
7. **Write and edit comments.** Draft comments gather in step 7, where the reviewer edits, adds or discards each one.
8. **Send the review.** Step 8 opens the Send review page.

### The picks

- **Side bar:** one webview view carrying the whole path, with each step's state and actions on its card.
- **Pull request picker:** a list in the side bar with short descriptions.
- **Setup:** a form in step 1's card, plus a quick pick from the status bar for fast changes.
- **Progress:** shown in the side bar and in the overview.
- **Overview:** a dashboard-and-tables style, in a bounded column beside a contents rail of clickable links that jump to each section.

### Options not chosen

- **Side bar:** one native tree with a section per step; a stepper header above native trees.
- **Pull request picker:** a drop-down quick pick (its pasted URL in the same box is kept); a review queue (its waiting order and last-look flag are kept).
- **Setup:** VS Code's Getting Started walkthrough; quick picks only, with no form; the form everywhere, with the status bar opening step 1.
- **Progress:** a progress notification; a timeline in the overview only.
- **Overview style:** semantic accent stripes (kept inside opened finding rows); tinted cards.

The codicon font under [codicons/](codicons/) is VS Code's, licensed CC BY 4.0 ([LICENSE](codicons/LICENSE)).
