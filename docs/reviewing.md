# How a review works

A review starts with the **Second Look: Review pull request** command — the **Review a pull request** button on the Second Look side bar's second step, the pull request button in its title bar, or the Command Palette — and a GitHub pull request URL. The engine — a separate local process the extension starts — fetches the pull request from GitHub with your sign-in, keeps read-only copies of both sides of the change in its cache, and offers its result to the extension, which shows it in the Second Look side bar, opened from its own icon in the Activity Bar, and the overview tab. Nothing is checked out into your workspace, and nothing from the pull request is built, installed or run.

This page follows one review from start to sent. The words are the project's [glossary](../CONTEXT.md) words: story, part, importance, noise, claim, verdict, evidence source, ask, finding.

## The side bar

The side bar walks the review as eight steps, each on a card that shows whether it is **done**, **current**, **running** or still to come: 1 the agent, model and effort every agent pass runs on; 2 the pull request, or the button that starts a review; 3 the story, with a button that opens the overview; 4 the parts; 5 the claims and 6 the acceptance criteria and unexplained changes, each with a button that opens the overview; 7 the pending comments, with a button that opens the diff they are written on; and 8 a button that opens the Send review page. The current step is the first one not done — the story counts as read once you open the overview or move on to the parts — and its card is open while the others fold; any card opens with a click. Every button runs the same command the Command Palette offers. The side bar follows your colour theme, and works from the keyboard: Tab moves between the cards' controls, Space ticks a part's checkbox and Enter opens a part or presses a button ([ADR 0008](adr/0008-webview-side-bar.md) says why it is one webview).

## The ranked parts

The change is cut into **parts**: named groups of related edits, such as `Cart.total in web/cart.ts`, where every changed line belongs to exactly one part. A function, its caller and its test that change in different files can be one part.

Step 4 lists the parts by their **importance** — **must review**, **worth reviewing** or **context** — always with a one-line reason. The tooltip shows the signals the reason cites: plain, model-free facts such as new versus changed code, test versus code, the public entities the part adds or removes, and how many other files mention its entity names. At most a third of the parts (rounded up) sits at must review. It keeps the noise last: parts whose changes need no careful reading, each with its label — lockfile, generated, vendored, moved or renamed, snapshot, fixture — and whether the label is **confirmed**, proven by a check, or only **claimed**, with its one-line blind spot. A snapshot or fixture part is labelled but ranked with the rest, because a change there is a behaviour change.

The parts you read in order come from the ranking the result shows: the agent's, when the chosen agent, model and effort have an evaluation whose ranking matched or beat the plain one, else the plain rule's. Each part's tooltip says which.

## The stages a review runs through

Results arrive in stages, and the side bar fills in as they land. A status line above the parts names the stage still running:

1. **The plain parts** show first, from the engine's own parse of the diff.
2. **Grouping** — "grouping related hunks with pi" — the agent groups related hunks across files into parts; the side bar updates in place, and the status line says who grouped them.
3. **Ranking** — the agent ranks the parts, or the plain ranking stays and the line says why.
4. **The story** — a few sentences telling what the change does, in the parts' reading order.
5. **The comparison** — each part neither the description nor a linked issue explains is marked unexplained.
6. **The claims** — the statements the change makes about how code or a library behaves, each quoted from its source.
7. **The verdicts** — each claim judged, with its evidence.
8. **The criteria** — each acceptance criterion of the linked issues mapped to the change.
9. **The documentation links** — the library APIs the change uses linked to their documentation.

An agent pass that fails or answers invalidly falls back to the plain result and says why; nothing is guessed. A new review replaces one still running.

## The overview tab

The **Second Look: #… overview** tab opens with the review: the pull request's title and where it comes from, the line saying which commit your last look was at and what changed since, a chip for each stage, then, as they land:

- **The story**, with its stamp — each part it mentions is a link that opens the part in the diff editor.
- **The acceptance criteria**, each condition quoted from the checklist under the heading the `second-look.criteriaHeading` setting names, its issue a link, and its verdict — **met**, **partly met**, **not met**, **can't tell** or **needs manual check** — with the code and the tests it cites, each a link that opens the line read-only in the head copy, and the manual checks the description reports.
- **The unexplained changes**, in both directions: each part neither the description nor a linked issue explains, then each change they describe that the diff does not contain, quoted from where it is made.
- **The claims** with their verdicts, each quoted with where it is made and the part it is attached to.
- **The pipeline report and CI**: whether the report is fresh or stale, its steps and open findings, then each check run on the merge commit with its annotations and a failed job's trimmed log.
- **The description** in full — content GitHub hides, such as an HTML comment, is shown and flagged.
- **The documentation links**, the inventory links first, then the agent's suggestions, each labelled as suggested and not checked.

Every section says who made it: the plain pass, or the agent with its model, effort and prompt version. Nothing in the overview renders as markup — no remote image and no link — under a content security policy that loads nothing but the page's own style and script.

## Reading a part

Click a part and the multi-file diff editor opens with exactly that part's files, the base copy on the left and the head copy on the right, scrolled to the part's first hunk. The copies are read-only, so the editor refuses to edit them. Step 4's **Open next part** opens the first part you have not marked reviewed, and **All in order** — or the title button **Open all parts in order** — opens the whole change in one multi-file diff in the side bar's order, noise last.

A banner at the top of the part's first file, above its diff, gathers what you need while reading it: the part's importance — or its noise label, or that it is not ranked yet — and where it sits in the side bar's order, its reviewed checkbox, the one-line reason, the signals the reason cites with which ranking is shown, and the asks, **Why this matters** and **Comment on this part…**. Every link in it does exactly what the same entry in the side bar does, and the banner follows the part you open; opening the whole change shows none. It is a read-only comment thread of the companion's own, so it is also listed in the Comments panel ([ADR 0007](adr/0007-part-banner-as-a-file-comment.md) says why).

Tick a part's checkbox in the side bar, or press **Mark reviewed** in its banner, to mark it reviewed: the mark is kept locally, per pull request, keyed by the part's content, so it survives restarts and clears itself when that content changes; the side bar's badge counts the parts left, and the side bar and the banner always show the same tick.

## Claims, verdicts and evidence sources

A **claim** is a statement about how the code or a library behaves, quoted as written from where it is made: the pull request's description, a docstring or comment the change adds, the story, the pipeline report's open findings, or your own selection in the diff. Each claim gets a **verdict**:

- **verified** — the change itself, or a source the engine re-read, proves it;
- **refuted** — the evidence contradicts it;
- **unverifiable** — nothing readable settles it;
- **not checked** — not judged (yet).

Every verdict names its **evidence source**, from the [glossary](../CONTEXT.md)'s list — and the model's memory alone never yields **verified**. The engine re-reads every line a verdict cites before showing it: a citation that does not match drops the verdict to unverifiable and says why.

A refuted or unverifiable claim is a **finding**, shown as the companion's own comment thread on the exact line that makes it, and badged on the part in the side bar.

### The library fetch

When a claim turns on how a third-party library behaves and the head copy pins that library, the thread offers a **library fetch** with its reason: press the **Fetch** link and the engine downloads that exact version from the ecosystem's own host, checks it against the hash the project pins before unpacking anything, unpacks it read-only, and judges the claim again with that source. A .NET package with no exact source offers a **Decompile** link instead when that version's licence allows it, or says why not. Nothing is downloaded until you press: the fetch is always your choice. A fetched library's cited lines open read-only from the same cache the agent read.

## The acceptance criteria

The review reads the issues the pull request links — closing references and mentions alike — and lists each condition from the checklist under the configured heading, quoted and not checked until the agent maps it to the change. A criterion's verdict names where the change shows it: the lines of code that implement it, the tests that cover it, and the manual checks the description reports, each a link. A criterion only a person trying the change can settle, such as how something looks on screen, needs a manual check unless the description reports one that settles it. A not met or partly met criterion is a finding.

## The unexplained changes

The comparison runs in both directions. A part neither the description nor a linked issue explains — an unrelated refactor, a fix they never mention — carries the **? unexplained** badge in the side bar with its one-line reason. A statement that describes a change the diff does not contain — a promised test or document no part makes — is listed in the overview, quoted from where it is made. Both are findings.

## Asks

An **ask** is a fixed, typed request about one part, never free chat. Right-click a part in the side bar, or use the banner above its diff, and you are offered:

- **Explain this part** — what the part does and why it matters to the change, each line it cites a link that opens it read-only.
- **Verify this claim** — judges the text you selected on the head side of the part's diff, or one of the part's claims you pick, and the verdict joins the review with its evidence.
- **What covers this?** — the automated tests, in the change or anywhere in the head copy, that exercise the part, and the manual checks the description reports for it; none found is a valid answer that says where it looked.

The answers open at the top of the overview with their stamp. Nothing of an ask reaches GitHub.

## Comments and sending the review

Click the comment icon on any line a hunk covers — on either side of the diff — or right-click a part, or use its banner, and choose **Comment on this part…**. Each comment joins the pending review, which gathers in step 7 of the side bar with where every comment points; a comment can be discarded from its thread until it is sent. Nothing reaches GitHub while it waits.

Any finding offers **Draft comment**: the agent writes a short draft from the finding and its evidence, citing where the evidence is; you edit it, then **Add to review** or **Discard draft**. A draft is never sent on its own.

**Submit review…** (step 8's button, the side bar's rocket button, or the Command Palette) opens the **Send review page**: every pending comment together for one last pass — each with where it points, editable or droppable in place — beneath them the overall comment on the whole pull request, and the choice of **Comment**, **Approve** or **Request changes**. Nothing reaches GitHub until the page's one Submit button is pressed; then the engine maps every comment to its position in the pull request's current diff and submits them as one GitHub review pinned to the head commit it read. The review's link then shows, ready to open; a send that fails keeps every comment exactly where it was.

## Reviewing over several visits

Each review records the head commit it opened at. Review again after new commits and each part changed since your last look says **changed since your last look**, the line above the parts names the commit that look was at, and the side bar's filter button shows only those parts. The change at that commit is compared with the current one, each against its own merge base, so after a rebase onto newer master with one real edit, only the edited part is flagged. With no local record, the last look is the commit of your last submitted GitHub review.

Reviewed marks are kept locally per pull request and never sent anywhere by themselves; with the `second-look.mirrorViewedToGitHub` setting on, a file whose every part is marked is also marked **Viewed** on GitHub — a file only partly reviewed never is, and nothing is unmarked there.

## Documentation links

Hover a library call on the head side of a part's diff — in a Python or a C# change — and the hover links the API to its documentation at the version the project pins. The links come first from the libraries' published inventories, which the engine downloads and reads itself; the APIs no inventory linked go to the agent, whose suggestions are shown labelled as suggested and not checked. The overview's **Documentation** section lists every link, the inventory links first.

## Every result carries its stamp

Every agent-produced result names who made it: the agent, its version, the model, the effort, the run date, the tokens and cost when the agent reports them, and your account label when the settings gave one. A combination the evaluation never tested warns in the status bar without blocking anything — the current list is published as [the tested models](tested-models.md).
