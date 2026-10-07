import { DEFAULT_EFFORT } from './ranking.js';

/**
 * The tested models (issue 3): the agent, model and effort combinations
 * the companion's evaluation has been run against, with published
 * results. Prompts behave differently on each model, so a result from one
 * combination says little about another: this list is what the companion
 * was tested with, and the reviewer whose settings pick a combination
 * that is not on it is warned. The current list is published in
 * [docs/tested-models.md](../../docs/tested-models.md), which the README
 * links to and a test keeps in step with this constant; add an entry only
 * from a recorded evaluation run, never a model the run never scored, and
 * keep the page and `TESTED_RANKINGS` in `ranking.ts` in step with it.
 */

/** One tested combination, as the evaluation recorded it. */
export interface TestedModel {
  /** The agent that answered, such as `pi`. */
  agent: string;
  /** The installed version the run drove. */
  agentVersion: string;
  /** `provider/model`, as the run's stamp reported it. */
  model: string;
  /** The effort level the evaluation ran at; {@link DEFAULT_EFFORT} for the agent's own default. */
  effort: string;
  /**
   * When the latest run behind the entry started, as an ISO date; the
   * published page keeps each prompt's own run date, since the recorded
   * baseline merges runs taken as each prompt landed.
   */
  runDate: string;
  /** The recorded scores over all the run's cases, by score name; the evaluation's README explains what each measures. */
  scores: Readonly<Record<string, number>>;
}

/**
 * Every combination the evaluation has been run against. Pi 0.86.1 with
 * `zai-coding-cn/glm-5.3` at its default effort is the one so far,
 * scored over every prompt's cases in the recorded baseline.
 */
export const TESTED_MODELS: readonly TestedModel[] = [
  {
    agent: 'pi',
    agentVersion: '0.86.1',
    model: 'zai-coding-cn/glm-5.3',
    effort: DEFAULT_EFFORT,
    runDate: '2026-10-07T15:08:38.849Z',
    scores: {
      coverage: 1,
      'grouping-agreement': 0.8482,
      'rank-median': 1,
      'rank-top-3': 0.9,
      'story-must-review': 1,
      'story-order': 1,
      'story-names': 0.9898,
      'claims-recall': 1,
      'claims-precision': 0.9545,
      'verdict-accuracy': 1,
      'false-verified': 0,
      'verify-accuracy': 0.75,
      'verify-false-verified': 0,
      'verify-fetch-offered': 1,
      'unexplained-recall': 1,
      'unexplained-precision': 1,
      'described-recall': 1,
      'described-precision': 1,
      'criteria-accuracy': 1,
      'criteria-false-met': 0,
      'criteria-code-recall': 0.8889,
      'criteria-tests-recall': 1,
      'criteria-manual-recall': 1,
      'draft-cites-evidence': 1,
      'draft-no-new-claim': 1,
      'draft-under-cap': 1,
      'explain-cites-part': 1,
      'explain-names-in-change': 0.8333,
      'cover-cites-checked': 1,
      'cover-tests-recall': 0.8,
      'cover-tests-precision': 1,
      'cover-manual-recall': 1,
      'cover-none-found': 1,
      'doc-links-on-site': 1,
      'doc-links-checked': 1,
    },
  },
];

/**
 * Whether the agent, model and effort are among the tested models: a
 * combination the evaluation never ran against. The installed version is
 * published detail, not part of the match — it drifts with the reviewer's
 * install — and a run that ended before naming its model (`null`) is
 * never tested, since only its stamp could tell. The effort defaults to
 * the agent's own, which is what the settings ask for when they name
 * none.
 */
export function isTestedModel(
  tested: readonly TestedModel[],
  agent: string,
  model: string | null,
  effort?: string | null,
): boolean {
  const level = effort ?? DEFAULT_EFFORT;
  return tested.some((entry) => entry.agent === agent && entry.model === model && entry.effort === level);
}
