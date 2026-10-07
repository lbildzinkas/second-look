# The tested models

Prompts behave differently on each model, so a result from one agent and model says little about another ([ADR 0006](adr/0006-no-prompt-without-its-evaluation.md)). This page is the current list of every agent, model and effort the companion's evaluation has been run against, with the agent's version, the run's date and how each scored. The companion warns the reviewer whose settings pick a combination that is not on the list; the warning blocks nothing — every review still runs, stamped with who answered.

The list is the `TESTED_MODELS` constant in [`packages/engine/src/tested-models.ts`](../packages/engine/src/tested-models.ts), and this page renders it; a test keeps the two in step. The [evaluation](../packages/evaluation/README.md) prints the same listing — one `TESTED` line per combination, with the agent's version, the run's date and the scores stamped with it — at the end of every run it scores with an agent, and its README explains what each score measures.

## The list

| Agent | Version | Model | Effort | Run date |
| --- | --- | --- | --- | --- |
| Pi | 0.86.1 | `zai-coding-cn/glm-5.3` | default | 2026-10-07T15:08:38.849Z |

One row per tested combination. The run date is the latest run recorded behind it; the scores below keep each prompt's own run date, because the recorded baseline merges the runs taken as each prompt landed.

### Pi 0.86.1 · `zai-coding-cn/glm-5.3` · default effort

The agent ranking is the default for this combination (`TESTED_RANKINGS` in [`packages/engine/src/ranking.ts`](../packages/engine/src/ranking.ts)): over the seven cases it ranked, the known important parts sit at a median position of 1, with 0.9 of them in the top three, against 2 and 0.8 for the plain ranking of the same parts.

| Prompt | Run date | Scores over all the run's cases |
| --- | --- | --- |
| grouping | 2026-10-04T06:32:35.720Z | coverage 1, grouping-agreement 0.8482 |
| ranking | 2026-10-04T06:32:35.720Z | rank-median 1, rank-top-3 0.9 |
| story | 2026-10-04T08:38:20.193Z | story-must-review 1, story-order 1, story-names 0.9898 |
| claims | 2026-10-04T12:45:41.622Z | claims-recall 1, claims-precision 0.9545 |
| verdicts | 2026-10-07T11:06:40.494Z | verdict-accuracy 1, false-verified 0, verify-accuracy 0.75, verify-false-verified 0, verify-fetch-offered 1 |
| unexplained changes | 2026-10-05T17:21:41.222Z | unexplained-recall 1, unexplained-precision 1, described-recall 1, described-precision 1 |
| criteria mapping | 2026-10-06T08:48:12.610Z | criteria-accuracy 1, criteria-false-met 0, criteria-code-recall 0.8889, criteria-tests-recall 1, criteria-manual-recall 1 |
| draft comments | 2026-10-06T11:33:18.523Z | draft-cites-evidence 1, draft-no-new-claim 1, draft-under-cap 1 |
| explain | 2026-10-07T09:56:32.574Z | explain-cites-part 1, explain-names-in-change 0.8333 |
| cover | 2026-10-07T11:06:40.494Z | cover-cites-checked 1, cover-tests-recall 0.8, cover-tests-precision 1, cover-manual-recall 1, cover-none-found 1 |
| documentation links | 2026-10-07T15:08:38.849Z | doc-links-on-site 1, doc-links-checked 1 |

The library verdicts prompt's claim checks — `claims-found`, `claims-verdict:<kind>`, `claims-evidence` and `claims-fetch-offered` — are scored per case and keep no whole-run row; the [baseline](../packages/evaluation/baseline.json) records them, case by case, for this combination. A score with nothing to count is left out rather than given a value, so a prompt whose cases give no score has none listed.

## Adding a combination

Run the evaluation with the agent, model and effort — `second-look-eval run --agent pi --model <model> [--effort <level>] --write-baseline packages/evaluation/baseline.json` — so the run is recorded, then add the entry to `TESTED_MODELS` in [`packages/engine/src/tested-models.ts`](../packages/engine/src/tested-models.ts) and a section here with its scores and run dates. Keep the agent ranking out of `TESTED_RANKINGS` unless the run's ranking matched or beat the plain one; the evaluation's README says how each score is read.
