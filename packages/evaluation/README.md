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

`expected.json` has three fields:

- `noise` — each changed file's expected noise, by its path on the new side: `{ "label": "none" }`, or a label with its state, such as `{ "label": "lockfile", "state": "claimed" }`. A file set to `null` is not labelled yet and counts in no score.
- `importantParts` — the parts a reviewer must not miss, each by the part's name as the engine prints it (`Cart.total in web/cart.ts`), or else by its path, which matches the file's first part.
- `claims` — the claims the change makes, each with its text, where the change makes it (`origin`), the library it is about as the project pins it (`library`), the verdict it deserves with the evidence that proves it (`verdict`), and `libraryFetch: true` when the companion should offer a library fetch before checking it.

The repository's cases live in `cases/`. `example-42` and `example-7` are invented pull requests, recorded from the engine's test fixtures. `canary-python` and `canary-csharp` are hand-made canaries for the companion's core promise: a change whose docstring overclaims how a pinned library behaves (`httpx` 0.27.2, `Microsoft.IO.RecyclableMemoryStream` 1.2.2), with nothing in the description that gives the answer away. Each records its claim, the refuted verdict with evidence at the pinned version, and that a library fetch should be offered; the evaluation presses the fetch when the review offers one.

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
- `claims-found`, `claims-verdict:<kind>`, `claims-evidence` and `claims-fetch-offered` — over the hand-labelled claims: whether the review reported each claim (by exact text), gave it the expected verdict with the expected evidence (file, line, source), and offered a library fetch for the pinned library. The evaluation presses every offered fetch, as the reviewer would, and library-source evidence counts only behind a pressed fetch ([ADR 0003](../../docs/adr/0003-library-source-only-on-reviewer-request.md)). The engine reports no claims yet, so these checks fail as expected failures: the report marks them, the baseline stores them at their failing values, and the claim steps land when they start to measure something.

A score with nothing to count is left out rather than given a value.

## Runs and stamps

```sh
node packages/evaluation/dist/main.js run [--cases <folder>]... [--model-free] [--changed-since <ref>] \
  [--baseline <file>] [--write-baseline <file>] [--runs <folder>]
```

Each run gets its own folder under `--runs` (default: `evaluation/` in the engine's cache folder) holding `results.json` and `trace.jsonl`, the local trace of every agent call, one JSON line each. Every result row carries the stamp: `companionVersion`, `promptVersions`, `agent`, `agentVersion`, `model`, `effort` and `runDate`. A model-free run is stamped `none` for the agent, its version, the model and the effort, and its trace is empty.

## Baseline

`--baseline <file>` compares the run's rows with a stored run, row by row: the same case and score, by the same agent and model at the same effort. A row missing any stamp field, on either side, is never compared. The `(all)` rows are not compared either, since their case set changes when a case is added or a subset runs. The run exits 1 when a model-free score drops, or when a case it scored no longer gives a score its baseline has.

The repository's baseline is `baseline.json`. CI runs `npm run eval` on every pull request: the model-free cases against that baseline. When a change improves a score, or adds a case, rewrite it with `--model-free --write-baseline packages/evaluation/baseline.json` in the same pull request.

## Prompts and their cases

`prompts.json` registers each prompt with its `id`, `version` and source `files` (relative to the repository root); a case ties itself to prompts through its `prompts` field. Every prompt a case names must be registered, and every registered prompt must have a case, or the run refuses to start. `--changed-since <ref>` runs only the cheap subset: the cases tied to the prompts whose files this branch changed since the ref.

Any model judge — a prompt that scores another prompt's output — must first be checked against hand labels: run it over cases a person has labelled, and use it only once its verdicts agree with theirs.

## Trying it by hand

1. Run `npm run eval` and read the report: on the canary cases the coverage, noise and rank checks pass, while every claim check fails as an expected failure, because the review reports no claims yet.
2. Record a case from a public pull request into a folder of your own, and write its `expected.json`.
3. Run `node packages/evaluation/dist/main.js run --cases <folder> --write-baseline <folder>/baseline.json`.
4. Break a noise rule locally — for example, remove `package-lock.json` from the lockfile names in `packages/engine/src/noise.ts` — then `npm run build` and `npm run eval`: the lockfile recall of `example-42` drops and the run exits 1.
