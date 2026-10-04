# Evaluation

The evaluation runs the engine over stored cases and scores it, so a change to the engine, a prompt or a model shows what got better or worse, case by case ([ADR 0006](../../docs/adr/0006-no-prompt-without-its-evaluation.md)). Runs are offline and repeatable: a case holds everything the review reads.

Build first (`npm run build`). The command is `node packages/evaluation/dist/main.js`, or `second-look-eval` once the bin link exists.

## Cases

A case is one folder, named after the case:

| Path | What it holds |
| --- | --- |
| `case.json` | `formatVersion` (1), `id`, `source` (the pull request URL), `recordedAt`, `prompts` (the prompt ids the case is tied to; empty for a model-free case), `pullRequest` (the metadata and the full description, as the review result carries them), `gitAttributes` (the root `.gitattributes` at the head commit, or null), `baseCommit` and `headCommit`. |
| `change.diff` | The full diff. |
| `base/`, `head/` | The content the review reads from each version: every changed file, and on the head side every file that names the change's entities, so the name-based reference counts come out as in the live review. |
| `expected.json` | The expected results, written by hand — or, for a seeded case, in full by the seed command. |
| `LICENSE` | For a case recorded from a public pull request, the license of the project its code comes from. |

`expected.json` has four fields:

- `noise` — each changed file's expected noise, by its path on the new side: `{ "label": "none" }`, or a label with its state, such as `{ "label": "lockfile", "state": "claimed" }`. A file set to `null` is not labelled yet and counts in no score.
- `importantParts` — the parts a reviewer must not miss, each by the part's name as the engine prints it (`Cart.total in web/cart.ts`), or else by its path, which matches the first part holding that file.
- `claims` — the claims the change makes, each with its text as the change states it, on one line, and where the change makes it (`origin`): a file and the head-side line the statement starts on, `{ "file": "app/x.py", "line": 9 }`, or a line of the description, `{ "in": "description", "line": 3 }`. `optional: true` marks a statement a reviewer may or may not count as a claim, such as a comment naming what the next lines do: listing it is no false claim, and leaving it out no miss. A claim the case also judges adds the verdict it deserves with the evidence that proves it (`verdict`); a claim about a library adds the library as the project pins it (`library`), and `libraryFetch: true` when the companion should offer a library fetch before checking it. The verdicts prompt judges a claim from the change alone, so a claim with `libraryFetch: true` deserves **unverifiable** from it, naming the library, whatever its `verdict` after the fetch.
- `groups` — the hand-labelled grouping: the parts a reviewer would read, each as a list of the hunks it holds. A hunk is `path#n`, the file's n-th hunk in the diff counting from 1, by its path on the new side; a file without hunks, such as a binary, is its bare path. Label every hunk a reviewer reads; sinking noise, which never reaches the agent, can stay out.

Any of them may be left out: the omitted field simply counts nothing, so an `expected.json` written before a field existed keeps running.

The repository's cases live in `cases/`. `example-42` and `example-7` are invented pull requests, recorded from the engine's test fixtures. `canary-python` and `canary-csharp` are hand-made canaries for the companion's core promise: a change whose docstring overclaims how a pinned library behaves (`httpx` 0.27.2, `Microsoft.IO.RecyclableMemoryStream` 1.2.2), with nothing in the description that gives the answer away. Each records its claim, the refuted verdict with evidence at the pinned version, and that a library fetch should be offered; the evaluation presses the fetch when the review offers one. `pallets-click-3781`, `encode-httpx-3690` and `sindresorhus-ky-880` are recorded public pull requests in which a function, its callers and its tests change across files; each keeps its project's license beside it. `seeded-typescript`, `seeded-python` and `seeded-csharp` are seeded bugs: mutants wrapped as pull requests that never existed, described below. `misstated-python` wraps `seeded-python`'s mutant of tomli's `match_to_datetime` (`ljust` turned `rjust`) alone, with a description written for the case that misstates what the changed line does — it says the fraction is padded on the right, so `.5` parses as 500000 microseconds — beside a true statement about it; it keeps tomli's license beside it.

The grouping prompt's cases are the two canaries, `example-7` and the three public pull requests, each with hand-labelled groups. A canary changes one hunk, so there is nothing to regroup: the agent is not asked, and the case checks that the plain grouping stays.

The ranking prompt's cases are the two canaries, `example-7`, the three public pull requests and the three seeded cases, each with its known important parts. A canary gives one part, so there is nothing to rank and the agent is not asked.

The story prompt's cases are the same nine. Its scores are plain checks that need no hand labels: the story of a case's plain parts is checked against those parts and the change itself.

The claims prompt's cases are the two canaries and the three public pull requests, each with every claim its description, docstrings and comments make hand-listed in `claims`: on the canaries, the docstrings' claims about what the helper returns and how the pinned library behaves; on the public pull requests, the docstrings and comments the change adds about what `wait_ready` returns, what `edit` accepts and how an extended instance's signals combine. Summaries, comments that only name the next lines, and the descriptions' statements of intent are listed as optional. Text in documentation files, such as a README or a changelog, is not a source of claims.

The verdicts prompt's cases are the claims prompt's five and `misstated-python`, each with a hand verdict on its required claims in `claims` (`verdict`): on the canaries, the docstring's claim about what the helper returns is verified by the change, and the claim about the pinned library deserves unverifiable naming the library, since no library source is fetched; on the public pull requests, every docstring and comment claim about what `wait_ready` returns, what `edit` accepts and how an extended instance's signals combine is verified by the code in the head copy; on `misstated-python`, the description's misstatement is refuted and its true statement verified, both by the changed line. The agent judges the hand-labelled claims, located as the claims pass would list them, not the claims the claims prompt found, so its scores measure the verdicts prompt alone.

### Recording a case

```sh
GITHUB_TOKEN="$(gh auth token)" node packages/evaluation/dist/main.js \
  record https://github.com/{owner}/{repo}/pull/{number} --cases <folder> [--id <name>]
```

The recorder fetches the pull request once, reviews it, and writes the case with an `expected.json` listing every changed file as `null`. It then replays the case offline and refuses it unless it gives the same parts as the live review. Write the expected results by hand: label what a reviewer would, not what the engine printed.

### Private cases

Cases can live in any folder outside the repository, so private pull requests never enter it. `SECOND_LOOK_EVAL_CASES` names such folders (separated like `PATH`): the recorder writes to the first one when `--cases` is not given, and every run reads all of them beside the repository's cases (or beside the `--cases` folders given). Keep their baseline outside the repository too.

## Scores

Plain checks come first; each is computed per case and over the whole run (the `(all)` rows):

- `coverage` — the share of the diff's changed lines that belong to exactly one part; a review that fails covers none.
- `noise-precision:<class>` and `noise-recall:<class>` — per noise class and state, such as `lockfile:claimed`, `moved or renamed:confirmed` or `none`, over the hand-labelled files.
- `rank-median` — the median 1-based position of the known important parts in the ranked parts (lower is better); a part the result lacks counts as one past the last. A case whose review gives fewer than three parts is skipped: there every position is fixed by the part count, not by how the review ranked.
- `rank-top-3` — the share of the known important parts among the first three, over the same cases `rank-median` counts.
- `story-must-review`, `story-order` and `story-names` — the story's plain checks: the share of must-review parts the story links; the share of stories that first mention the parts in reading order; and the share of the file and code names a story uses (each name in backticks, and each path or dotted, snake_case or camelCase name outside them) that the change shows — as written, or every identifier in it — in its paths, its changed and context lines, its hunk headings and its parts' names and entities. A story that was not written links no part and keeps no order. A case whose plain parts have no must-review part gives no `story-must-review`, and a story that names nothing gives no `story-names`.
- `grouping-agreement` — pairwise hunk agreement with the hand-labelled groups: over every pair of labelled hunks, the share the parts keep together when the labels do and apart when they do not. A hunk the agent left out counts as a part of its own.
- `claims-recall` and `claims-precision` — the claims the agent lists against the hand lists: the share of the required hand-listed claims it found, and the share of the claims it listed that match a required one, out of those that match a required one or none (a listed claim matching only an optional one counts in neither). A listed claim matches a hand-listed one made in the same place — the same file, or the description — when either's text holds the other's, on one line, so a quote of one sentence matches a hand-listed paragraph and a quote of two sentences matches each one listed alone. The plain pass lists no claims, so only an agent run gives these scores.
- `verdict-accuracy` and `false-verified` — the verdicts the agent gives the hand-labelled claims against the hand verdicts: the share given the verdict they deserve from the change alone (a claim that needs library source counts only when its verdict names the library), and the share of the claims that do not deserve verified that it verified anyway (lower is better; it is zero on the committed cases). A claim the engine's re-check dropped to unverifiable counts as unverifiable, and a judging that fell back leaves every claim not checked. Only an agent run gives these scores.
- `claims-found`, `claims-verdict:<kind>`, `claims-evidence` and `claims-fetch-offered` — over the hand-labelled claims that carry a verdict: whether the review reported each claim (by exact text), gave it the expected verdict with the expected evidence (file, line, source), and offered a library fetch for the pinned library. The evaluation presses every offered fetch, as the reviewer would, and library-source evidence counts only behind a pressed fetch ([ADR 0003](../../docs/adr/0003-library-source-only-on-reviewer-request.md)). The plain pass reports no claims, so these checks fail as expected failures: the report marks them, the baseline stores them at their failing values, and the claim steps land when they start to measure something.

A score with nothing to count is left out rather than given a value.

## Runs and stamps

```sh
node packages/evaluation/dist/main.js run [--cases <folder>]... [--model-free] [--changed-since <ref>] \
  [--agent pi [--model <model>] [--effort <level>] [--agent-timeout <seconds>]] \
  [--baseline <file>] [--write-baseline <file>] [--runs <folder>]
```

Each run gets its own folder under `--runs` (default: `evaluation/` in the engine's cache folder) holding `results.json` and `trace.jsonl`, the local trace of every agent call, one JSON line each. Every result row carries the stamp: `companionVersion`, `promptVersions`, `agent`, `agentVersion`, `model`, `effort` and `runDate`.

Every case is reviewed by the plain pass, stamped `none` for the agent, its version, the model and the effort. Without `--agent` no model is called and the trace stays empty. With `--agent pi`, each case tied to the grouping prompt is reviewed again with the agent grouping stage through the reviewer's installed Pi, signed in with its own login, and its `coverage` and `grouping-agreement` are stamped with the agent, its version, and the model and effort that answered (`default` when the agent reports no effort); a row whose model is unknown is never compared. Each case tied to the ranking prompt has its plain parts ranked by the agent, so the ranking compares with the plain ranking of the same parts, and its `rank-median` and `rank-top-3` are stamped the same way. Each case tied to the story prompt has the story of its plain parts written by the agent, and its `story-must-review`, `story-order` and `story-names` are stamped the same way; the run scores the agent's own answer, not holding it to the plain checks the review retries a story on, so the scores measure the prompt rather than the retry. Each case tied to the claims prompt has the claims of its plain parts listed by the agent, with no story to read, so no claim comes from the agent's own story, and its `claims-recall` and `claims-precision` are stamped the same way; claims that fell back list none. Each case tied to the verdicts prompt has its hand-labelled claims judged by the agent against its plain parts and head copy, and its `verdict-accuracy` and `false-verified` are stamped the same way. A case whose agent grouping or ranking fell back to the plain one is listed under `fallbacks` in `results.json`, with the prompt and why, and is scored on the plain parts the reviewer would see; a story that fell back is listed the same way and fails the story's checks, and so are claims that fell back, and verdicts that fell back.

For each agent, model and effort, `rankings` in `results.json` sets the agent ranking's `rank-median` and `rank-top-3` beside the plain ranking's over the cases it ranked, and the report prints it as a `RANKING` line: the agent ranking **matches or beats the plain ranking** when neither score is worse, and **falls behind** otherwise. This is the score behind `TESTED_RANKINGS` in `packages/engine/src/ranking.ts`, where the agent ranking is the default: add an agent, model and effort there only from a run that matched or beat the plain ranking, and record the run here.

Coverage is a hard gate: the run exits 1 when any coverage row, plain or agent, is below 100%.

## Baseline

`--baseline <file>` compares the run's rows with a stored run, row by row: the same case and score, by the same agent and model at the same effort. A row missing any stamp field, on either side, is never compared. The `(all)` rows are not compared either, since their case set changes when a case is added or a subset runs. The run exits 1 when a model-free score drops, or when a case it scored no longer gives a score its baseline has; an agent's drop is reported, since a model's answers vary from run to run.

`--write-baseline <file>` writes the run over the stored baseline: the run's rows replace the stored rows of each case, agent, model and effort it scored — for an agent, of each prompt it ran — and every other stored row stays. One file so keeps the plain pass's rows beside the rows of each agent, model and prompt tried. A stored fallback note stays too, unless the run scored that case with the same agent and prompt, and so does a stored ranking comparison, unless the run ranked with the same agent, model and effort.

The repository's baseline is `baseline.json`. CI runs `npm run eval` on every pull request: every case, with no agent, against that baseline. When a change improves a score, or adds a case, rewrite it with `--write-baseline packages/evaluation/baseline.json` in the same pull request; when a prompt changes, run its cases with the agent as well, so the baseline records the agent and model tried. It holds the grouping prompt's baseline for Pi 0.86.1 with `zai-coding-cn/glm-5.3` at its default effort: coverage 100% on every case, and a grouping agreement of 0.85 over the four cases with groups to compare, against 0.42 for the plain pass. The canaries change one hunk each, so the agent is not asked on them. Across the runs recorded while the prompt was written, its agreement on `encode-httpx-3690` moved between 0.42 and 1, while the other cases held.

It holds the ranking prompt's baseline for the same agent, model and effort, and its comparison under `rankings`: over the seven cases it ranked, the known important parts sit at a median position of 1, with 0.9 of them in the top three, against 2 and 0.8 for the plain ranking of the same parts, so the agent ranking matches or beats the plain ranking and is the default for Pi with `zai-coding-cn/glm-5.3` at its default effort. Case by case it ranks no known important part lower than the plain ranking: higher on `encode-httpx-3690`, `example-7` and `sindresorhus-ky-880`, and level on `pallets-click-3781` and the three seeded cases, where the plain ranking already puts the fault first. No other agent, model or effort has been tested, so elsewhere the plain ranking stays.

It holds the story prompt's baseline for the same agent, model and effort, over its nine cases: every must-review part linked (`story-must-review` 1 over the six cases whose plain parts have one — the seeded cases' plain parts have none), the parts first mentioned in reading order in every story (`story-order` 1), and 0.99 of the names the stories use shown by the change (`story-names`); the one name outside it, `subprocess.Popen` on `pallets-click-3781`, comes from the unchanged code the agent read. In a first run, with an earlier wording and an earlier names check, `story-names` was 0.88 and the `canary-csharp` story restated the change's docstring claim as if it were so; the wording now asks the agent never to repeat a claim as fact, and the check reads a name the change does not show as written by its identifiers, so a signature passes and a literal such as `.5` is no name.

It holds the claims prompt's baseline for the same agent, model and effort, over its five cases: every required hand-listed claim found (`claims-recall` 1) and 0.95 of the claims it listed on the hand lists (`claims-precision`), one agent call per case, each under 90 seconds. The one claim off the lists is the note "This can be removed when the `supportsAbortSignal` check is removed." on `sindresorhus-ky-880`, a note about the code's future rather than how it behaves. In an earlier run with an earlier wording, `encode-httpx-3690` fell back: the agent gave a claim from the description no part, twice, and the whole answer was refused; the wording now asks for every claim's part.

It holds the verdicts prompt's baseline for the same agent, model and effort, over its six cases: every hand-labelled claim given the verdict it deserves (`verdict-accuracy` 1 over eighteen claims), and none of the three claims that do not deserve verified verified (`false-verified` 0) — the two canaries' library claims left unverifiable with their library named, and `misstated-python`'s misstatement refuted citing the changed line — one agent call per case, each under 190 seconds. In earlier runs with earlier wordings the agent wrote a claim's quote where its id belonged, which cost a retry, and on `encode-httpx-3690`, after reading many files, wrote a summary before the JSON twice, so the case fell back; the answer now names each claim by `id`, and the task ends by asking for the JSON alone.

## Seeded cases

A seeded case wraps a made fault — a mutant from a mutation tool — as a recorded pull request that never existed, and is scored by the rank position of the part holding the fault. Each committed one wraps its mutant in a realistic change from the same public project — a docs or glossary wording, a test touch — so the ranking has other parts to put beside the fault: `seeded-typescript` is a StrykerJS mutant of this repository's `packages/engine/src/rank.ts`, `seeded-python` a mutmut mutant of tomli's `src/tomli/_re.py`, and `seeded-csharp` a Stryker.NET mutant of GuardClauses' `src/GuardClauses/GuardAgainstOutOfRangeExtensions.cs`.

```sh
node packages/evaluation/dist/main.js seed <mutant.diff> --source <export> --id <name> \
  [--cases <folder>] [--fault <path>]
```

`--source` is the un-mutated code the diff applies to, a clean export of the base commit (`git archive <commit> | tar -x -C <export>`); a working checkout also runs, but its build output and dependencies count as files naming the change. The wrapped pull request is neutral by construction: title, branch and description name only the changed files (`Update src/foo.py`, `update-foo`), never what the edit does; the number and the commits are hashes of the diff, so the same mutant wraps the same way twice. The command writes `expected.json` in full — each changed file's noise as the live review assessed it (`none` for ordinary code, a wrap's lockfile or rename the label the review gave it), the parts holding the fault as the important ones — reviews the full mutated tree, copies what the review reads, then replays the case offline and refuses it unless it gives the same parts. A diff that wraps the mutant with benign edits from the same project names the mutated file with `--fault`, and only that file's parts are marked important; without `--fault` every part is, the starting point the revert-the-fix recipe labels by hand.

To obtain the mutant diff, keep the run small — one file of one public project, local, never a large codebase:

- **mutmut** (Python): configure it over one module of a small public project and run `mutmut run`; `mutmut show <mutant>` prints the mutant as a diff, but with hunk line numbers that fit its own copy, so apply the one shown edit by hand in the export and `git diff`.
- **StrykerJS and Stryker.NET**: run the tool scoped to one file, read the report's mutation (`mutatorName`, location, `replacement`), apply that one edit in the export and `git diff`.

Choose mutants from the mutators that tend to resemble real faults: boundary and operator mutations such as a flipped comparison or a sign change, and method-name swaps such as `ljust`→`rjust`. Skip the mechanical ones no human writes — substituting `None` or `""`, `and False`. Prefer survivors, which behave like faults a CI let through; mutmut's only survivor in scope here was mechanical, so `seeded-python` takes a killed mutant chosen for its shape instead.

Realism caveats, worth stating beside any number these cases produce:

- A mutant is one machine-made edit; real changes carry intent, tests and a description around the fault.
- The benign edits wrapped around each committed mutant are written for the wrap in the style of the same project, not taken from its history.
- The wrapped pull request is deliberately bland, and its uniform wording is itself a tell a reader could learn.
- The mutant set is what the tools generate, not the distribution of historical faults; whether a mutant survived depends on the mutated project's own tests.
- A seeded case measures whether the review ranks the fault's part where a reviewer reads first, not whether the review finds the fault; the part is known before the review runs.
- The rank scores skip any case whose review gives fewer than three parts, there every position being fixed by the part count rather than by how the review ranked; that is why the committed seeded cases wrap each mutant with enough benign edits to make the ranking a real one.

Public and private follow the recorded cases' rule: a case committed here may only mutate public code — this repository, or permissively licensed public projects such as tomli (MIT) and GuardClauses (MIT) — and a case that copies a third-party project's files carries that project's license beside them, in a `LICENSE` file naming the project and the commit the copies were taken from. Seed a private project only into a folder outside the repository.

### Reverting a fix

The same recipe has a real-history variant: revert a public bug fix and seed the revert, so the fault is a bug that truly existed, at its true location.

1. Choose a small fix in a public repository whose diff, undone, still reads like a fault.
2. Export the tree at the fix commit: `git archive <fix> | tar -x -C <export>`; this is the base the revert applies to.
3. Reverse the fix into a diff: `git -C <repo> diff <fix> <fix>^ > revert.diff`.
4. `seed revert.diff --source <export> --id <name>`, and check the written `importantParts`: the reverted lines are the fault's own, but a fix that also touched unrelated lines needs the extra parts named by hand.

## Prompts and their cases

`prompts.json` registers each prompt with its `id`, `version` and source `files` (relative to the repository root); a case ties itself to prompts through its `prompts` field. Every prompt a case names must be registered, and, when the run reads the repository's cases, every registered prompt must have a case, or the run refuses to start; a run over other folders (`--cases`) checks only the first, since the prompts' own cases live in the repository. `--changed-since <ref>` runs only the cheap subset: the cases tied to the prompts whose files this branch changed since the ref; add `--agent pi` to run those prompts too, and only those.

The prompts so far are `grouping`, in `packages/engine/src/grouping.ts`: the agent groups related hunks across files into named parts; `ranking`, in `packages/engine/src/ranking.ts` with the signal phrases of `packages/engine/src/rank.ts`: the agent ranks the parts, each with a one-line reason citing the plain signals it used; `story`, in `packages/engine/src/story.ts`: the agent writes the story of the parts, a few sentences in reading order, each part it mentions linked; `claims`, in `packages/engine/src/claims.ts`: the agent lists the claims the change makes, each quoted from its source, which the engine checks and locates; and `verdicts`, in `packages/engine/src/verdicts.ts`: the agent judges each claim against the change and the head copy, citing the lines that settle it, which the engine re-reads. Bump a prompt's version there and here together whenever its instructions, prompt or schema change.

Any model judge — a prompt that scores another prompt's output — must first be checked against hand labels: run it over cases a person has labelled, and use it only once its verdicts agree with theirs.

## Trying it by hand

1. Run `npm run eval` and read the report: on the canary cases the coverage and noise checks pass (their reviews give one part, too few for the rank scores to count), while every claim check fails as an expected failure, because the plain pass reports no claims.
2. Copy `cases/canary-python` into a folder of its own and run it with the agent: `run --cases <folder> --agent pi --runs <folder>/runs`. The trace's claims call should list the docstring claim about redirects, quoted from `app/doc_links.py` lines 9–10, and the run scores `claims-recall` and `claims-precision` against the case's hand list; the engine's own test of the canary shows the claim the review then carries: quoted, at those lines, attached to the canary's one part, and not checked.
3. Copy `cases/misstated-python` into a folder of its own and run it with the agent the same way. The trace's verdicts call should refute the description's first claim citing `src/tomli/_re.py` line 83, the changed `rjust` line, and verify the second; the run scores `verdict-accuracy` and `false-verified` against the hand verdicts. The engine's own tests show the refuted claim the review then carries, and that a citation misquoting that line drops it to unverifiable.
4. Seed a few mutants of the companion's own code: export it (`git archive HEAD | tar -x -C /tmp/sl`), flip one comparison the way StrykerJS reports it, wrap it with a benign docs or test touch from the same export, `git diff` the edits, and `seed <diff> --source /tmp/sl --cases <folder> --id <name> --fault <mutated path>`; run the evaluation and read the seeded cases' rank scores.
5. Record a case from a public pull request into a folder of your own, and write its `expected.json`.
6. Run `node packages/evaluation/dist/main.js run --cases <folder> --write-baseline <folder>/baseline.json`.
7. Break a noise rule locally — for example, remove `package-lock.json` from the lockfile names in `packages/engine/src/noise.ts` — then `npm run build` and `npm run eval`: the lockfile recall of `example-42` drops and the run exits 1.
