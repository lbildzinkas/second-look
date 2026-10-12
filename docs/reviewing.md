# How a review works

A review starts with the **Second Look: Review pull request** command — a **Review** button in the list of your pull requests on the Second Look side bar's second step, a pull request URL pasted into that list's box, the pull request button in its title bar, or the Command Palette — and a GitHub pull request URL. The engine — a separate local process the extension starts — fetches the pull request from GitHub with your sign-in, keeps read-only copies of both sides of the change in its cache, and offers its result to the extension, which shows it in the Second Look side bar, opened from its own icon in the Activity Bar, and the overview tab. Nothing is checked out into your workspace, and nothing from the pull request is built, installed or run.

This page follows one review from start to sent. The words are the project's [glossary](../CONTEXT.md) words: story, part, importance, noise, claim, verdict, evidence source, ask, finding.

## The side bar

The side bar walks the review as eight steps, each on a card that shows whether it is **done**, **current**, **running**, **waiting** for the stage that produces it, or still to come: 1 the agent, model and effort every agent pass runs on; 2 the pull request, or the list that starts a review; 3 the story, with a button that opens the overview; 4 the parts; 5 the claims — each refuted or unverifiable one a finding on its card, with its reason and evidence source, each line it cites a chip — the head copy's line read-only, or a CI log's check run on GitHub — where it is made as a link that opens it, **Draft comment**, **Open** (the line, read-only), **Verify again** and, when it is offered, **Fetch library** or **Decompile**, the verified ones folded into one line, and a **Verify a claim…** button that runs the verify ask; 6 the acceptance criteria not fully met, each with **Draft comment** and its issue link, the met ones folded, then the unexplained changes in both directions — and 7 the pending comments and the drafts, each row with where it points — a click opens its thread — its first words, and **Discard** for a comment or **Add to review** and **Discard draft** for a draft; and 8 the button that opens the Send review page, which once the review is sent shows it — its type, its comment count and the head commit it is pinned to — with its **Open on GitHub** link. Steps 5 and 6 each end in an **I've checked these** tick, kept locally per pull request: new commits re-open the step, since its findings may have moved. Step 4's **⋯** turns the `second-look.mirrorViewedToGitHub` setting on and off, step 6's opens the editor's settings at `second-look.criteriaHeading`, and the side bar title's **⋯** opens the companion's own settings. The current step is the first one not done — the story counts as read once you open the overview or move on to the parts, step 7 once a comment is written or the review is sent, with no draft left undecided, step 8 once the review is sent with nothing written since — and its card is open while the others fold; any card opens with a click. Every button runs the same command the Command Palette offers, the findings' included, except a finding's **Open**, which opens its line in the read-only head copy the way the overview's chips do; a claim's where, which opens the place it is made — its file's line in the head copy, its description line in the overview's description, or its sentence in the story — and its cited lines, which open the head copy's line or a CI log's check run on GitHub; an issue link and step 8's sent review, which open on GitHub; and step 7's rows, which open, discard or add a pending comment or a draft. The side bar follows your colour theme, and works from the keyboard: Tab moves between the cards' controls, Space ticks a part's checkbox or a step's tick and Enter opens a part or presses a button ([ADR 0008](adr/0008-webview-side-bar.md) says why it is one webview).

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

While a review runs, the side bar shows count tiles — the parts left, the claims, the criteria and the comments — and a progress strip naming the stage running, the agent, model and effort working on it, its time so far and its place, such as "stage 7 of 9". The step being produced spins, and a step waiting for its stage shows a clock. The status bar shows the same, visible with the side bar closed: `7/9 Second Look: Claude Code · claude-sonnet-5-5 · effort high`, with a spinner. The **Stop review** button in the side bar's title bar stops the review: what already landed stays, and the strip lists the stages it stopped.

At the end the strip reads "Review complete in 4:12", followed by each stage that fell back or failed, and why. A notification appears only when a stage fell back or failed; a clean finish only changes the strip and the status bar.

## The overview tab

The **Second Look: #… overview** tab opens with the review: the pull request's title and where it comes from, the line saying which commit your last look was at and what changed since, then — while the review runs — a stage list: each stage done with its duration, the one running with its agent, model, effort and elapsed time, and the ones to come, folding at the end into one line that says the review is complete, with each fallback and its reason. A section still being produced shows a skeleton and a line naming the agent checking it, and claims already listed read as being checked. Then, as they land:

- **The story**, with its stamp — each part it mentions is a link that opens the part in the diff editor.
- **The acceptance criteria**, each condition quoted from the checklist under the heading the `second-look.criteriaHeading` setting names, its issue a link, and its verdict — **met**, **partly met**, **not met**, **can't tell** or **needs manual check** — with the code and the tests it cites, each a link that opens the line read-only in the head copy, and the manual checks the description reports.
- **The unexplained changes**, in both directions: each part neither the description nor a linked issue explains, then each change they describe that the diff does not contain, quoted from where it is made.
- **The claims** with their verdicts, each quoted with where it is made — a link that opens its place: the file's line read-only, the description's line marked in the page's own description, or the story's sentence — and the part it is attached to.
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

A refuted or unverifiable claim is a **finding**, shown as the companion's own comment thread on the exact line that makes it, badged on the part in the side bar, and listed on step 5's card with its verdict, its reason and evidence source, each line it cites — the head copy's line read-only, or a CI log's check run on GitHub — where it is made as a link, and its actions — every one the thread and the overview offer, including the library fetch below. **Verify again** re-runs the verify ask on that claim alone; **Verify a claim…** runs it over them all.

### The library fetch

When a claim turns on how a third-party library behaves and the head copy pins that library, the thread offers a **library fetch** with its reason: press the **Fetch** link and the engine downloads that exact version from the ecosystem's own host, checks it against the hash the project pins before unpacking anything, unpacks it read-only, and judges the claim again with that source. A .NET package with no exact source offers a **Decompile** link instead when that version's licence allows it, or says why not. Nothing is downloaded until you press: the fetch is always your choice. A fetched library's cited lines open read-only from the same cache the agent read.

## The acceptance criteria

The review reads the issues the pull request links — closing references and mentions alike — and lists each condition from the checklist under the configured heading, quoted and not checked until the agent maps it to the change. A criterion's verdict names where the change shows it: the lines of code that implement it, the tests that cover it, and the manual checks the description reports, each a link. A criterion only a person trying the change can settle, such as how something looks on screen, needs a manual check unless the description reports one that settles it. A not met or partly met criterion is a finding: step 6 lists every criterion not fully met with **Draft comment** and its issue link, folds the met ones, and its **⋯** opens the settings at the heading the checklist sits under.

## The unexplained changes

The comparison runs in both directions. A part neither the description nor a linked issue explains — an unrelated refactor, a fix they never mention — carries the **? unexplained** badge in the side bar with its one-line reason. A statement that describes a change the diff does not contain — a promised test or document no part makes — is listed in the overview, quoted from where it is made. Both are findings, listed on step 6's card below the criteria with **Draft comment** each.

## Asks

An **ask** is a fixed, typed request about one part, never free chat. Press a part row's **Ask…** button in the side bar, right-click the part, or use the banner above its diff, and you are offered:

- **Explain this part** — what the part does and why it matters to the change, each line it cites a link that opens it read-only.
- **Verify this claim** — judges the text you selected on the head side of the part's diff, or one of the part's claims you pick, and the verdict joins the review with its evidence. From step 5, **Verify again** names the claim to judge, and **Verify a claim…** offers every claim of the review to pick from.
- **What covers this?** — the automated tests, in the change or anywhere in the head copy, that exercise the part, and the manual checks the description reports for it; none found is a valid answer that says where it looked.

The answers open at the top of the overview with their stamp. Nothing of an ask reaches GitHub.

## Comments and sending the review

Click the comment icon on any line a hunk covers — on either side of the diff — or a part row's **⋯** menu, its right-click menu or its banner, and choose **Comment on this part…**. Each comment joins the pending review, which gathers in step 7 of the side bar: every pending comment and every draft with where it points — a click opens its thread — its first words, and **Discard** for a comment or **Add to review** and **Discard draft** for a draft; a comment can also be discarded from its thread until it is sent. What you have written but not sent is kept locally, per pull request ([the privacy page](privacy.md) says where, and what sending the review clears), so it survives the editor closing and comes back, with its threads, when you open the same review again; after new commits every comment stays where it was and the ones whose line changed are flagged. Nothing reaches GitHub while it waits.

Any finding offers **Draft comment** — on its step 5 or 6 row, in the overview and in its thread: a notification shows while the agent writes a short draft from the finding and its evidence, citing where the evidence is, and the draft then opens in its thread at its line, or at the top of its part's file; when no draft can be written, a message says why. You edit it, then **Add to review** or **Discard draft** — in its thread or from its step 7 row. A draft from a finding on the whole pull request — a criterion, or a described change the diff does not contain — opens in an input box instead, and joins the Send review page's overall comment once you accept it. A draft is never sent on its own.

**Submit review…** (step 8's button, the side bar's rocket button, or the Command Palette) opens the **Send review page**: every pending comment together for one last pass — each with where it points, editable or droppable in place — beneath them the overall comment on the whole pull request, and the choice of **Comment**, **Approve** or **Request changes**. Nothing reaches GitHub until the page's one Submit button is pressed; then the engine maps every comment to its position in the pull request's current diff and submits them as one GitHub review pinned to the head commit it read. Step 8 then shows the review sent — its type, its comment count and the head commit it is pinned to — with its **Open on GitHub** link; a send that fails says why on step 8 and keeps every comment exactly where it was.

## Reviewing over several visits

The engine saves each pull request's latest review result in the pull request's own cache folder, `review-result.json` (see [What stays on the machine and what is sent](privacy.md)), keyed by the head commit it reviewed, and saves it again as library fetches and verify asks change it. Reviewing the same pull request again — later the same day, or after VS Code restarts — shows that saved review at once and runs no agent pass: the progress strip reads "Saved review of f00dcaf, from 2026-10-11 14:03 UTC by Claude Code · claude-sonnet-5-5 · effort high". When the pull request has new commits since, the review re-runs only what they changed and carries the rest over from the saved review: a part whose code did not change keeps its grouping and ranking, and the agent groups and ranks only the changed hunks; the story, the unexplained changes and the acceptance criteria mapping are carried over only while the change's code, its title and description — for the last two, the linked issues too — are as before, and the documentation links only while the change's code is as before, and each runs again otherwise; the claims of the parts carried over keep their verdicts — the description's only while it did not change, the story's never — while new claims are listed and judged. A carried-over verdict that cites a line the new commits changed, or a line above it, or a CI log line, is judged again, never shown as current. The story, the unexplained changes, the claims, the acceptance criteria mapping and the documentation links also run again when their agent gave no usable answer last time. Each part says **carried over** or **re-checked**, each carried claim says **carried over**, the line above the parts and the overview name the earlier commit and count what was carried over, and the stage list marks each stage carried over whole. With no agent set up, the saved review is shown marked as from an earlier commit, on the strip, above the parts and in the overview, never as the current one. **Review again** — the button under the strip, or **Second Look: Review again** in the Command Palette — always runs a fresh review, every stage, and its result replaces the saved one. A review saved by an older version of the companion is ignored, and the pull request is reviewed afresh.

Each review that runs records the head commit it opened at. Review again after new commits and each part changed since your last look says **changed since your last look**, the line above the parts names the commit that look was at, and the side bar's filter button shows only those parts. The change at that commit is compared with the current one, each against its own merge base, so after a rebase onto newer master with one real edit, only the edited part is flagged. With no local record, the last look is the commit of your last submitted GitHub review.

Reviewed marks are kept locally per pull request and never sent anywhere by themselves; with the `second-look.mirrorViewedToGitHub` setting on, a file whose every part is marked is also marked **Viewed** on GitHub — a file only partly reviewed never is, and nothing is unmarked there. The steps' **I've checked these** ticks are kept the same way: per pull request, at the head commit they were ticked on, so a review after new commits starts with the steps re-opened.

## Documentation links

Hover a library call on the head side of a part's diff — in a Python or a C# change — and the hover links the API to its documentation at the version the project pins. The links come first from the libraries' published inventories, which the engine downloads and reads itself; the APIs no inventory linked go to the agent, whose suggestions are shown labelled as suggested and not checked. The overview's **Documentation** section lists every link, the inventory links first.

## Every result carries its stamp

Every agent-produced result names who made it: the agent, its version, the model, the effort, the run date, the tokens and cost when the agent reports them, and your account label when the settings gave one. A combination the evaluation never tested warns in the status bar without blocking anything — the current list is published as [the tested models](tested-models.md).
