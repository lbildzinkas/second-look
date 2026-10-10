/**
 * A review's budget meter (issue 111): the limits the reviewer's settings
 * set, and what the review uses — every agent run it starts, every file it
 * downloads and those files' bytes. The engine keeps one meter per review,
 * beside the pull request's latest result, so the reviewer's later
 * library fetches, asks and drafts add to the same review's use.
 *
 * The meter only counts: nothing is refused yet, whatever the limits say.
 * A limit of 0 is no limit.
 *
 * Agent runs are counted where each attempt starts, a retry included (see
 * `runAgentTasks`); files and bytes by {@link meteredFetch}, a wrapper
 * around the fetch a review is given, which counts each response as one
 * file and its bytes as they stream.
 */
import type { Budget, BudgetLimits, ReviewResult } from './protocol.js';

/** Limits that limit nothing: every one 0. */
export const NO_BUDGET_LIMITS: BudgetLimits = { agentRuns: 0, filesFetched: 0, downloadMiB: 0 };

/** One review's meter: the limits set, and the use counted so far. */
export type BudgetMeter = Budget;

/** A fresh meter with the given limits and nothing used. */
export function budgetMeter(limits: BudgetLimits = NO_BUDGET_LIMITS): BudgetMeter {
  return {
    limits: { agentRuns: limits.agentRuns, filesFetched: limits.filesFetched, downloadMiB: limits.downloadMiB },
    used: { agentRuns: 0, filesFetched: 0, downloadBytes: 0 },
  };
}

/** Counts one started agent run. */
export function countAgentRun(meter: BudgetMeter): void {
  meter.used.agentRuns += 1;
}

/** The meter as it stands now, copied so later counting leaves it be. */
export function budgetOf(meter: BudgetMeter): Budget {
  return { limits: { ...meter.limits }, used: { ...meter.used } };
}

/** The result carrying the meter's current use. */
export function withBudget(result: ReviewResult, meter: BudgetMeter): ReviewResult {
  return { ...result, budget: budgetOf(meter) };
}

/**
 * A fetch that counts what it downloads on the meter: each response as one
 * file, and its body's bytes as they stream through, so a body never read
 * adds none. The response keeps its status, headers, URL and redirect flag.
 */
export function meteredFetch(fetchImpl: typeof fetch, meter: BudgetMeter): typeof fetch {
  return async (input, init) => {
    const response = await fetchImpl(input, init);
    meter.used.filesFetched += 1;
    if (response.body === null) return response;
    const counting = new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        meter.used.downloadBytes += chunk.byteLength;
        controller.enqueue(chunk);
      },
    });
    const metered = new Response(response.body.pipeThrough(counting), {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
    // A response built here would forget where it came from.
    Object.defineProperties(metered, {
      url: { value: response.url },
      redirected: { value: response.redirected },
    });
    return metered;
  };
}

function isWholeNumber(value: unknown): boolean {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

/** Why a review request's budget is not limits the engine can meter, in plain words; absent when it is. */
export function budgetLimitsProblem(value: unknown): string | undefined {
  const shape = 'the budget must be { "agentRuns": number, "filesFetched": number, "downloadMiB": number }, each 0 for no limit';
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return shape;
  const limits = value as Record<string, unknown>;
  if (!isWholeNumber(limits['agentRuns'])) return `${shape}: agentRuns must be a whole number of 0 or more`;
  if (!isWholeNumber(limits['filesFetched'])) return `${shape}: filesFetched must be a whole number of 0 or more`;
  const mib = limits['downloadMiB'];
  if (typeof mib !== 'number' || !Number.isFinite(mib) || mib < 0) return `${shape}: downloadMiB must be a number of 0 or more`;
  return undefined;
}
