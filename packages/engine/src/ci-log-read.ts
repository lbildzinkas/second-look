import type { AgentAdapter, AgentSettings } from './agent.js';
import { passingLogItems, readPassingLogs } from './ci.js';
import type { GitHubClient, PullRequestRef } from './github.js';
import type { Claim, ReviewResult } from './protocol.js';
import { judgeClaims } from './verdicts.js';

export interface PressCiLogReadOptions {
  client: GitHubClient;
  ref: PullRequestRef;
  adapter: AgentAdapter;
  settings?: AgentSettings;
}

/**
 * Presses one claim's Read the CI log, as the reviewer does: reads the
 * logs of the checks that passed at the head commit the review read (see
 * {@link readPassingLogs}) and asks the agent to judge the claim again
 * with them as its CI logs, re-checking every citation there; a cited
 * line is labelled as a passing check's. The new verdict keeps the offer
 * that was pressed and carries the logs it was judged with. Throws when
 * the claim offers no read, when no passing check's log has lines, or
 * when the agent gives no usable answer.
 */
export async function pressCiLogRead(result: ReviewResult, index: number, options: PressCiLogReadOptions): Promise<Claim> {
  const claim = result.claims?.claims[index];
  const verdict = claim?.verdict;
  const offer = verdict === undefined || verdict.kind === 'not checked' ? undefined : verdict.ciLogFetch;
  if (claim === undefined || offer === undefined || result.ci === undefined) throw new Error('this claim offers no CI log to read');
  const checks = await readPassingLogs(options.client, options.ref, result.ci.headSha);
  const logs = passingLogItems(checks);
  if (logs.length === 0) {
    const why = checks.length === 0 ? 'no check passed at the head commit any more' : checks.map((check) => `${check.name}: ${check.log!.detail}`).join('; ');
    throw new Error(`no passing check's log has lines to read (${why})`);
  }
  const judged = await judgeClaims(result.parts, [{ ...claim, verdict: { kind: 'not checked' } }], {
    adapter: options.adapter,
    ...(options.settings ? { settings: options.settings } : {}),
    root: result.copies.head.path,
    logs,
  });
  const { judging } = judged;
  const settled = judged.claims[0]!.verdict;
  if (judging.outcome === 'fell back' || settled.kind === 'not checked') throw new Error(`the CI logs were read, but ${judging.detail}`);
  const ciLogs = { checks: checks.map((check) => ({ name: check.name, url: check.url, detail: check.log!.detail })), promptVersion: judging.promptVersion, stamp: judging.stamp };
  return { ...claim, verdict: { ...settled, ciLogFetch: offer, ciLogs } };
}
