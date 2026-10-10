/**
 * A review's budget meter (issue 111): the limits the reviewer's settings
 * set, and what the review uses — every agent run it starts, every file it
 * downloads and those files' bytes. The engine keeps one meter per review,
 * beside the pull request's latest result, so the reviewer's later
 * library fetches, asks and drafts add to the same review's use.
 *
 * A limit of 0 is no limit. Agent runs are counted where each attempt
 * starts, a retry included (see `runAgentTasks`); files and bytes by
 * {@link meteredFetch}, a wrapper around the fetch a review is given,
 * which counts each response as one file and its bytes as they stream.
 *
 * The limits stop the review (issue 113): an agent stage, or its retry,
 * starts only while a run is left, and {@link limitedFetch} refuses a
 * download past the file or size limit. The review's own reads — the pull
 * request, its diff, both copies, CI and the linked issues — are counted
 * and never refused, and the reviewer's asks and drafts are only counted.
 * Whatever a limit leaves says which limit, with {@link limitReason}.
 */
import type { Budget, BudgetLimits, ReviewResult } from './protocol.js';

/** One of a budget's three limits. */
export type BudgetLimit = keyof BudgetLimits;

/** The setting each limit mirrors, which the reviewer raises to go further. */
const LIMIT_SETTINGS: Record<BudgetLimit, string> = {
  agentRuns: 'second-look.budget.agentRuns',
  filesFetched: 'second-look.budget.filesFetched',
  downloadMiB: 'second-look.budget.downloadMiB',
};

const MIB = 1024 * 1024;

/** A download refused because the review reached one of its limits; the message says which, in plain words. */
export class BudgetLimitError extends Error {
  constructor(
    message: string,
    readonly limit: BudgetLimit,
  ) {
    super(message);
    this.name = 'BudgetLimitError';
  }
}

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

/** True while another agent run fits the meter's limit: it has none, or the runs used are under it. */
export function hasAgentRunLeft(meter: BudgetMeter): boolean {
  return meter.limits.agentRuns === 0 || meter.used.agentRuns < meter.limits.agentRuns;
}

/** The download limit the meter has reached — files first, then size — or undefined while another download fits. */
export function spentDownloadLimit(meter: BudgetMeter): 'filesFetched' | 'downloadMiB' | undefined {
  const { limits, used } = meter;
  if (limits.filesFetched > 0 && used.filesFetched >= limits.filesFetched) return 'filesFetched';
  if (limits.downloadMiB > 0 && used.downloadBytes >= limits.downloadMiB * MIB) return 'downloadMiB';
  return undefined;
}

/** The limit the meter has reached — agent runs, then files, then size — or undefined while none is. */
export function spentLimit(meter: BudgetMeter): BudgetLimit | undefined {
  return hasAgentRunLeft(meter) ? spentDownloadLimit(meter) : 'agentRuns';
}

/**
 * Why something was left at a limit, naming the limit and the setting
 * that raises it, such as "the review used its 12 agent runs; raise
 * `second-look.budget.agentRuns` to check it".
 */
export function limitReason(meter: BudgetMeter, limit: BudgetLimit, toDo: string): string {
  const value = meter.limits[limit];
  const spent =
    limit === 'agentRuns'
      ? `used its ${value} agent run${value === 1 ? '' : 's'}`
      : limit === 'filesFetched'
        ? `fetched its ${value} file${value === 1 ? '' : 's'}`
        : `downloaded its ${value} MiB`;
  return `the review ${spent}; raise \`${LIMIT_SETTINGS[limit]}\` to ${toDo}`;
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
    return throughBody(response, (chunk, controller) => {
      meter.used.downloadBytes += chunk.byteLength;
      controller.enqueue(chunk);
    });
  };
}

/**
 * A metering fetch that also refuses what passes a download limit: a
 * download is not started once the files or bytes used reach their limit,
 * and a body that passes the size limit as it streams fails there. Each
 * download holds one of the file limit's slots from its start until its
 * file is counted or its request fails, so downloads running together
 * cannot each pass the same last slot. Each refusal is a
 * {@link BudgetLimitError} naming the limit. For anything but the
 * review's own reads, which {@link meteredFetch} only counts.
 */
export function limitedFetch(fetchImpl: typeof fetch, meter: BudgetMeter): typeof fetch {
  const metered = meteredFetch(fetchImpl, meter);
  const refusal = (limit: BudgetLimit) => new BudgetLimitError(limitReason(meter, limit, 'download more'), limit);
  return async (input, init) => {
    const spent = spentDownloadLimit(meter);
    if (spent !== undefined) throw refusal(spent);
    reserveDownload(meter, refusal);
    try {
      const response = await metered(input, init);
      return throughBody(response, (chunk, controller) => {
        if (meter.limits.downloadMiB > 0 && meter.used.downloadBytes > meter.limits.downloadMiB * MIB) controller.error(refusal('downloadMiB'));
        else controller.enqueue(chunk);
      });
    } finally {
      releaseDownload(meter);
    }
  };
}

/** The downloads each meter has going, which hold the file limit's remaining slots until they are counted or fail. */
const downloadsInFlight = new WeakMap<BudgetMeter, number>();

/**
 * Holds one of the meter's file-limit slots for a download about to start,
 * or throws the limit's refusal when none is left. Synchronous, so
 * downloads starting together cannot each take the same last slot.
 */
function reserveDownload(meter: BudgetMeter, refuse: (limit: BudgetLimit) => BudgetLimitError): void {
  const going = (downloadsInFlight.get(meter) ?? 0) + 1;
  if (meter.limits.filesFetched > 0 && meter.used.filesFetched + going > meter.limits.filesFetched) throw refuse('filesFetched');
  downloadsInFlight.set(meter, going);
}

/** Gives a download's slot back: the metered fetch counted its file, or the request never answered. */
function releaseDownload(meter: BudgetMeter): void {
  downloadsInFlight.set(meter, (downloadsInFlight.get(meter) ?? 0) - 1);
}

/** The response with its body passed through the given transform, keeping its status, headers, URL and redirect flag. */
function throughBody(response: Response, transform: (chunk: Uint8Array, controller: TransformStreamDefaultController<Uint8Array>) => void): Response {
  if (response.body === null) return response;
  const passed = new Response(response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({ transform })), {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
  // A response built here would forget where it came from.
  Object.defineProperties(passed, {
    url: { value: response.url },
    redirected: { value: response.redirected },
  });
  return passed;
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
