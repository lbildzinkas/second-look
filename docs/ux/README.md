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
