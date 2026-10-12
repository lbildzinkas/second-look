import type { CheckRunListing, GitHubClient, PullRequestRef } from './github.js';
import type { CheckLog, CheckRun, CiResults, Claim } from './protocol.js';

/**
 * The CI pass: lists the check runs and annotations GitHub reports at the
 * pull request's head commit, read-only, and fetches a job's log only when
 * the job failed, trimmed to the step that failed. A pull request's checks
 * run on its merge commit, so the companion labels them that way. CI
 * that cannot be read never fails the review: the result says why. A
 * passing job's log is fetched only when the reviewer presses Read the CI
 * log on a claim a CI log could settle, as library source is (ADR 0003).
 */

/** The conclusions that mean a check failed, so its log is worth reading. */
const FAILED = new Set(['failure', 'timed_out', 'startup_failure']);

/** The most lines of a failing step the companion keeps, ending at its last error. */
const MAX_LOG_LINES = 200;

/** The longest log line the companion keeps. */
const MAX_LINE_LENGTH = 500;

/** The timestamp GitHub Actions starts each log line with. */
const TIMESTAMP = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z ?/;

/** The line that starts a step in a GitHub Actions log. */
const STEP_START = /^##\[group\]Run (.*)$/;

/** A line GitHub Actions marks as an error. */
const ERROR_LINE = /^##\[error\]/;

/** Whether a check run failed. */
export function checkFailed(conclusion: string | null): boolean {
  return conclusion !== null && FAILED.has(conclusion);
}

/** Whether a check run passed. */
export function checkPassed(conclusion: string | null): boolean {
  return conclusion === 'success';
}

/** A line kept short. */
function clip(line: string): string {
  return line.length > MAX_LINE_LENGTH ? `${line.slice(0, MAX_LINE_LENGTH - 1)}…` : line;
}

/**
 * Trims a GitHub Actions job log to the step that failed: the step holding
 * its first error line, up to {@link MAX_LOG_LINES} lines ending at that
 * step's last error, timestamps removed. A log that marks no error keeps
 * its last lines.
 */
export function trimLog(log: string): CheckLog {
  const lines = log.split(/\r?\n/).map((line) => line.replace(TIMESTAMP, ''));
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  const firstError = lines.findIndex((line) => ERROR_LINE.test(line));
  if (firstError < 0) {
    const kept = lines.slice(-MAX_LOG_LINES).map(clip);
    return { lines: kept, detail: `the log marks no failing step, so its last ${kept.length} lines are kept` };
  }
  let start = 0;
  for (let at = firstError; at >= 0; at--) {
    if (STEP_START.test(lines[at]!)) {
      start = at;
      break;
    }
  }
  let end = lines.findIndex((line, at) => at > firstError && STEP_START.test(line));
  if (end < 0) end = lines.length;
  let lastError = firstError;
  for (let at = firstError; at < end; at++) if (ERROR_LINE.test(lines[at]!)) lastError = at;
  const from = Math.max(start, lastError + 1 - MAX_LOG_LINES);
  const step = STEP_START.exec(lines[start]!)?.[1]?.trim();
  const kept = lines.slice(from, lastError + 1).map(clip);
  const where = step ? `the failing step "${step}"` : 'the lines before its first step';
  const cut = from > start ? `, its last ${kept.length} lines` : '';
  return { ...(step ? { step } : {}), lines: kept, detail: `trimmed to ${where}${cut}, ending at its last error` };
}

/** Plain words for why something could not be read, the token never among them. */
function reason(error: unknown): string {
  const status = typeof error === 'object' && error !== null ? (error as { status?: unknown }).status : undefined;
  if (typeof status === 'number') return `GitHub answered ${status}`;
  return error instanceof Error ? error.message : String(error);
}

/** A check run's trimmed log, or why it has none: only a GitHub Actions job has a log to read. */
async function readLog(client: GitHubClient, ref: PullRequestRef, listed: CheckRunListing): Promise<CheckLog> {
  if (listed.app !== 'github-actions') return { lines: [], detail: 'it is not a GitHub Actions job, so there is no log to read' };
  try {
    return trimLog(await client.downloadJobLog(ref, listed.id));
  } catch (error) {
    return { lines: [], detail: `its log could not be read: ${reason(error)}` };
  }
}

/** One check run with its annotations and, when it failed, its trimmed log. */
async function readCheck(client: GitHubClient, ref: PullRequestRef, listed: CheckRunListing): Promise<CheckRun> {
  const annotations = listed.annotations > 0 ? await client.listAnnotations(ref, listed.id).catch(() => []) : [];
  const check: CheckRun = { name: listed.name, status: listed.status, conclusion: listed.conclusion, url: listed.url, annotations };
  if (!checkFailed(listed.conclusion)) return check;
  return { ...check, log: await readLog(client, ref, listed) };
}

/**
 * Reads the CI at the pull request's head commit: every check run, the
 * annotations of those that left any, and the trimmed log of each failed
 * job. Nothing is written to GitHub.
 */
export async function readCi(client: GitHubClient, ref: PullRequestRef, headSha: string, mergeCommit: string | null): Promise<CiResults> {
  const base = { headSha, ...(mergeCommit ? { mergeCommit } : {}) };
  let listed: CheckRunListing[];
  try {
    listed = await client.listCheckRuns(ref, headSha);
  } catch (error) {
    return { ...base, outcome: 'unreadable', detail: `the check runs could not be read: ${reason(error)}`, checks: [] };
  }
  const checks = await Promise.all(listed.map((each) => readCheck(client, ref, each)));
  const failed = checks.filter((check) => checkFailed(check.conclusion)).length;
  const detail = `${checks.length} check run${checks.length === 1 ? '' : 's'} at the head commit, ${failed} failed; logs are read only for failed jobs, and a passing job's only on the reviewer's press`;
  return { ...base, outcome: 'read', detail, checks };
}

/**
 * Reads the logs of the checks that passed at the pull request's head
 * commit, only once the reviewer pressed Read the CI log: lists the check
 * runs again and fetches each passing GitHub Actions job's log, trimmed
 * and capped as a failed job's is (see {@link trimLog}). Throws with a
 * plain reason when the check runs cannot be read. Nothing is written to
 * GitHub.
 */
export async function readPassingLogs(client: GitHubClient, ref: PullRequestRef, headSha: string): Promise<CheckRun[]> {
  let listed: CheckRunListing[];
  try {
    listed = await client.listCheckRuns(ref, headSha);
  } catch (error) {
    throw new Error(`the check runs could not be read: ${reason(error)}`);
  }
  const passed = listed.filter((each) => checkPassed(each.conclusion));
  return Promise.all(
    passed.map(async (each) => ({ name: each.name, status: each.status, conclusion: each.conclusion, url: each.url, annotations: [], log: await readLog(client, ref, each) })),
  );
}

/** The checks' readable logs, each with the id the verdicts prompt gives it. */
export interface CiLogItem {
  /** The id the prompt gives it, such as `log1`. */
  id: string;
  check: CheckRun;
  log: CheckLog;
  /** True for a passing check's log, read on the reviewer's press; a failed check's otherwise. */
  passing?: true;
}

/** The checks whose logs have lines, numbered in the order GitHub lists them. */
function logItems(checks: readonly CheckRun[], passing: boolean): CiLogItem[] {
  const read = checks.filter((check) => check.log !== undefined && check.log.lines.length > 0);
  return read.map((check, index) => ({ id: `log${index + 1}`, check, log: check.log!, ...(passing ? { passing: true as const } : {}) }));
}

/** The failed checks whose logs have lines, numbered in the order GitHub lists them. */
export function ciLogItems(ci: CiResults | undefined): CiLogItem[] {
  return logItems(ci?.checks ?? [], false);
}

/** The passing checks whose logs a press read with lines, numbered in the order GitHub lists them. */
export function passingLogItems(checks: readonly CheckRun[]): CiLogItem[] {
  return logItems(checks, true);
}

/**
 * Offers Read the CI log on every unverifiable claim a CI log could
 * settle, when the CI the review read has checks that passed at the head
 * commit and the claim was not judged with their logs already; an offer
 * not yet pressed, such as one a claim carried from an earlier commit,
 * is made again from this CI, or withdrawn. Nothing is fetched until the
 * reviewer presses it.
 */
export function offerCiLogReads(claims: readonly Claim[], ci: CiResults | undefined): Claim[] {
  const passed = (ci?.checks ?? []).filter((check) => checkPassed(check.conclusion)).map((check) => check.name);
  const checks = passed.length === 1 ? `${passed[0]} passed` : `${passed.length} checks passed`;
  const reason = `${checks} at the head commit; reading ${passed.length === 1 ? 'its log' : 'their logs'} could settle the claim.`;
  return claims.map((claim) => {
    const { verdict } = claim;
    if (verdict.kind === 'not checked' || verdict.ciLogs !== undefined) return claim;
    const { ciLogFetch: unpressed, ...rest } = verdict;
    if (verdict.kind !== 'unverifiable' || verdict.settles?.kind !== 'ci-log' || passed.length === 0) return unpressed === undefined ? claim : { ...claim, verdict: rest };
    return { ...claim, verdict: { ...rest, ciLogFetch: { checks: passed, reason } } };
  });
}
