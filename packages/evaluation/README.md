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
| `expected.json` | The expected results, written by hand. |
| `LICENSE` | For a case recorded from a public pull request, the license of the project its code comes from. |

`expected.json` has three fields:

- `noise` — each changed file's expected noise, by its path on the new side: `{ "label": "none" }`, or a label with its state, such as `{ "label": "lockfile", "state": "claimed" }`. A file set to `null` is not labelled yet and counts in no score.
- `importantParts` — the parts a reviewer must not miss, each by the part's name as the engine prints it (`Cart.total in web/cart.ts`), or else by its path, which matches the first part holding that file.
- `claims` — the claims the change makes, each with its text, where the change makes it (`origin`), the library it is about as the project pins it (`library`), the verdict it deserves with the evidence that proves it (`verdict`), and `libraryFetch: true` when the companion should offer a library fetch before checking it.
- `groups` — the hand-labelled grouping: the parts a reviewer would read, each as a list of the hunks it holds. A hunk is `path#n`, the file's n-th hunk in the diff counting from 1, by its path on the new side; a file without hunks, such as a binary, is its bare path. Label every hunk a reviewer reads; sinking noise, which never reaches the agent, can stay out.

Any of them may be left out: the omitted field simply counts nothing, so an `expected.json` written before a field existed keeps running.

The repository's cases live in `cases/`. `example-42` and `example-7` are invented pull requests, recorded from the engine's test fixtures. `canary-python` and `canary-csharp` are hand-made canaries for the companion's core promise: a change whose docstring overclaims how a pinned library behaves (`httpx` 0.27.2, `Microsoft.IO.RecyclableMemoryStream` 1.2.2), with nothing in the description that gives the answer away. Each records its claim, the refuted verdict with evidence at the pinned version, and that a library fetch should be offered; the evaluation presses the fetch when the review offers one. `pallets-click-3781`, `encode-httpx-3690` and `sindresorhus-ky-880` are recorded public pull requests in which a function, its callers and its tests change across files; each keeps its project's license beside it.

The grouping prompt's cases are the two canaries, `example-7` and the three public pull requests, each with hand-labelled groups. A canary changes one hunk, so there is nothing to regroup: the agent is not asked, and the case checks that the plain grouping stays.

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
- `rank-median` — the median 1-based position of the known important parts in the ranked parts (lower is better); a part the result lacks counts as one past the last.
- `rank-top-3` — the share of the known important parts among the first three.
- `grouping-agreement` — pairwise hunk agreement with the hand-labelled groups: over every pair of labelled hunks, the share the parts keep together when the labels do and apart when they do not. A hunk the agent left out counts as a part of its own.
- `claims-found`, `claims-verdict:<kind>`, `claims-evidence` and `claims-fetch-offered` — over the hand-labelled claims: whether the review reported each claim (by exact text), gave it the expected verdict with the expected evidence (file, line, source), and offered a library fetch for the pinned library. The evaluation presses every offered fetch, as the reviewer would, and library-source evidence counts only behind a pressed fetch ([ADR 0003](../../docs/adr/0003-library-source-only-on-reviewer-request.md)). The engine reports no claims yet, so these checks fail as expected failures: the report marks them, the baseline stores them at their failing values, and the claim steps land when they start to measure something.

A score with nothing to count is left out rather than given a value.

## Runs and stamps

```sh
node packages/evaluation/dist/main.js run [--cases <folder>]... [--model-free] [--changed-since <ref>] \
  [--agent pi [--model <model>] [--effort <level>] [--agent-timeout <seconds>]] \
  [--baseline <file>] [--write-baseline <file>] [--runs <folder>]
```

Each run gets its own folder under `--runs` (default: `evaluation/` in the engine's cache folder) holding `results.json` and `trace.jsonl`, the local trace of every agent call, one JSON line each. Every result row carries the stamp: `companionVersion`, `promptVersions`, `agent`, `agentVersion`, `model`, `effort` and `runDate`.

Every case is reviewed by the plain pass, stamped `none` for the agent, its version, the model and the effort. Without `--agent` no model is called and the trace stays empty. With `--agent pi`, each case tied to the grouping prompt is reviewed again with the agent grouping stage through the reviewer's installed Pi, signed in with its own login, and its `coverage` and `grouping-agreement` are stamped with the agent, its version, and the model and effort that answered (`default` when the agent reports no effort); a row whose model is unknown is never compared. A case whose agent grouping fell back to the plain one is listed under `fallbacks` in `results.json`, with why.

Coverage is a hard gate: the run exits 1 when any coverage row, plain or agent, is below 100%.

## Baseline

`--baseline <file>` compares the run's rows with a stored run, row by row: the same case and score, by the same agent and model at the same effort. A row missing any stamp field, on either side, is never compared. The `(all)` rows are not compared either, since their case set changes when a case is added or a subset runs. The run exits 1 when a model-free score drops, or when a case it scored no longer gives a score its baseline has; an agent's drop is reported, since a model's answers vary from run to run.

`--write-baseline <file>` writes the run over the stored baseline: the run's rows replace the stored rows of each case, agent, model and effort it scored, and every other stored row stays. One file so keeps the plain pass's rows beside the rows of each agent and model tried.

The repository's baseline is `baseline.json`. CI runs `npm run eval` on every pull request: every case, with no agent, against that baseline. When a change improves a score, or adds a case, rewrite it with `--write-baseline packages/evaluation/baseline.json` in the same pull request; when a prompt changes, run its cases with the agent as well, so the baseline records the agent and model tried. It holds the grouping prompt's baseline for Pi 0.86.1 with `zai-coding-cn/glm-5.3` at its default effort: coverage 100% on every case, and a grouping agreement of 0.85 over the four cases with groups to compare, against 0.42 for the plain pass. The canaries change one hunk each, so the agent is not asked on them. Across the three runs made while the prompt was written, its agreement on `encode-httpx-3690` moved between 0.56 and 1, while the other cases held.

## Prompts and their cases

`prompts.json` registers each prompt with its `id`, `version` and source `files` (relative to the repository root); a case ties itself to prompts through its `prompts` field. Every prompt a case names must be registered, and, when the run reads the repository's cases, every registered prompt must have a case, or the run refuses to start; a run over other folders (`--cases`) checks only the first, since the prompts' own cases live in the repository. `--changed-since <ref>` runs only the cheap subset: the cases tied to the prompts whose files this branch changed since the ref; add `--agent pi` to run their prompts too.

The one prompt so far is `grouping`, in `packages/engine/src/grouping.ts`: the agent groups related hunks across files into named parts. Bump its version there and here together whenever its instructions, prompt or schema change.

Any model judge — a prompt that scores another prompt's output — must first be checked against hand labels: run it over cases a person has labelled, and use it only once its verdicts agree with theirs.

## Trying it by hand

1. Run `npm run eval` and read the report: on the canary cases the coverage, noise and rank checks pass, while every claim check fails as an expected failure, because the review reports no claims yet.
2. Record a case from a public pull request into a folder of your own, and write its `expected.json`.
3. Run `node packages/evaluation/dist/main.js run --cases <folder> --write-baseline <folder>/baseline.json`.
4. Break a noise rule locally — for example, remove `package-lock.json` from the lockfile names in `packages/engine/src/noise.ts` — then `npm run build` and `npm run eval`: the lockfile recall of `example-42` drops and the run exits 1.
