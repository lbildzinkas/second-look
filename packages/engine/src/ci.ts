import type { CheckRunListing, GitHubClient, PullRequestRef } from './github.js';
import type { CheckLog, CheckRun, CiResults } from './protocol.js';

/**
 * The CI pass: lists the check runs and annotations GitHub reports at the
 * pull request's head commit, read-only, and fetches a job's log only when
 * the job failed, trimmed to the step that failed. A pull request's checks
 * run on its merge commit, so the companion labels them that way. CI
 * that cannot be read never fails the review: the result says why.
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

/** One check run with its annotations and, when it failed, its trimmed log. */
async function readCheck(client: GitHubClient, ref: PullRequestRef, listed: CheckRunListing): Promise<CheckRun> {
  const annotations = listed.annotations > 0 ? await client.listAnnotations(ref, listed.id).catch(() => []) : [];
  const check: CheckRun = { name: listed.name, status: listed.status, conclusion: listed.conclusion, url: listed.url, annotations };
  if (!checkFailed(listed.conclusion)) return check;
  if (listed.app !== 'github-actions') {
    return { ...check, log: { lines: [], detail: 'it is not a GitHub Actions job, so there is no log to read' } };
  }
  try {
    return { ...check, log: trimLog(await client.downloadJobLog(ref, listed.id)) };
  } catch (error) {
    return { ...check, log: { lines: [], detail: `its log could not be read: ${reason(error)}` } };
  }
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
  const detail = `${checks.length} check run${checks.length === 1 ? '' : 's'} at the head commit, ${failed} failed; logs are read only for failed jobs`;
  return { ...base, outcome: 'read', detail, checks };
}

/** The failed checks' readable logs, each with the id the verdicts prompt gives it. */
export interface CiLogItem {
  /** The id the prompt gives it, such as `log1`. */
  id: string;
  check: CheckRun;
  log: CheckLog;
}

/** The failed checks whose logs have lines, numbered in the order GitHub lists them. */
export function ciLogItems(ci: CiResults | undefined): CiLogItem[] {
  const checks = (ci?.checks ?? []).filter((check) => check.log !== undefined && check.log.lines.length > 0);
  return checks.map((check, index) => ({ id: `log${index + 1}`, check, log: check.log! }));
}
