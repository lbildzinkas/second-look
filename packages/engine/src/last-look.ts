import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pullRequestCacheDir } from './cache.js';
import { parseDiff } from './diff.js';
import type { GitHubClient, PullRequestRef } from './github.js';
import type { Hunk, Part, PullRequestSummary, SinceLastLook } from './protocol.js';
import { lineContent, pieceHashes } from './reviewed-marks.js';

/** The file in a pull request's cache folder that records the reviewer's looks. */
export const LAST_LOOK_FILE = 'last-look.json';

/** One look: the head commit a review was opened at, and when. */
export interface Look {
  commit: string;
  /** When the review was opened, as an ISO 8601 timestamp. */
  at: string;
}

/**
 * The store's record: the latest look, and the look before it at another
 * commit, so opening the review again at the same commit still shows
 * what changed since the look before.
 */
interface LookRecord {
  version: 1;
  last: Look;
  before?: Look;
}

const COMMIT = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

function isLook(value: unknown): value is Look {
  if (typeof value !== 'object' || value === null) return false;
  const { commit, at } = value as Record<string, unknown>;
  return typeof commit === 'string' && COMMIT.test(commit) && typeof at === 'string';
}

function lookPath(cacheDir: string, ref: PullRequestRef): string {
  return join(pullRequestCacheDir(cacheDir, ref), LAST_LOOK_FILE);
}

/**
 * Reads the record of the reviewer's looks at a pull request; null when
 * none was written yet or it is not a record, which is then left out
 * rather than trusted.
 */
export async function readLooks(cacheDir: string, ref: PullRequestRef): Promise<LookRecord | null> {
  let text: string;
  try {
    text = await readFile(lookPath(cacheDir, ref), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  let stored: unknown;
  try {
    stored = JSON.parse(text);
  } catch {
    return null;
  }
  const { last, before } = (stored ?? {}) as Partial<LookRecord>;
  if (!isLook(last)) return null;
  return { version: 1, last, ...(isLook(before) && before.commit !== last.commit ? { before } : {}) };
}

/**
 * Records a look at a pull request: it becomes the latest, and the
 * latest before it becomes the look before when it was at another
 * commit. The record lands whole: written beside the store, then renamed
 * over it.
 */
export async function recordLook(cacheDir: string, ref: PullRequestRef, look: Look): Promise<void> {
  const previous = await readLooks(cacheDir, ref);
  const before = previous === null ? undefined : previous.last.commit === look.commit ? previous.before : previous.last;
  const record: LookRecord = { version: 1, last: look, ...(before === undefined ? {} : { before }) };
  const path = lookPath(cacheDir, ref);
  await mkdir(pullRequestCacheDir(cacheDir, ref), { recursive: true });
  const partial = `${path}.partial-${randomBytes(6).toString('hex')}`;
  try {
    await writeFile(partial, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
    await rename(partial, path);
  } catch (error) {
    await rm(partial, { force: true });
    throw error;
  }
}

/** A hunk's changed lines alone, so context that upstream changed around them leaves the piece alone. */
function changedLines(hunk: Hunk): string[] {
  return hunk.lines.filter((line) => line.kind !== 'context').map(lineContent);
}

/**
 * The content hashes of a part's pieces as the comparison with the last
 * look reads them: each hunk by its changed lines alone, without their
 * numbers or context, and each file without hunks by its blob ids.
 * Identical hunks share a hash, so a piece reads the same whichever part
 * of its file holds it.
 */
export function changePieces(part: Part): string[] {
  return pieceHashes(part, changedLines, false);
}

/** Whether a part changed since the reviewer's last look: every part did when the commit is gone. */
export function changedSinceLastLook(part: Part, since: SinceLastLook): boolean {
  if (since.outcome === 'commit gone') return true;
  const changed = new Set(since.changed);
  return changePieces(part).some((piece) => changed.has(piece));
}

/** What the comparison needs: the GitHub client, the cache folder and the pull request as it is now. */
export interface LastLookOptions {
  client: GitHubClient;
  cacheDir: string;
  ref: PullRequestRef;
  pullRequest: PullRequestSummary;
  /** The pull request's full diff now. */
  diff: string;
  /** When this look happens. */
  now?: Date;
}

/**
 * Compares the change with the reviewer's last look, then records this
 * look. The last look is the latest one the local record holds at
 * another commit, or, with none, the commit of the reviewer's last
 * submitted GitHub review; with neither, this is their first look and
 * there is nothing to compare. The change at that commit is taken
 * against its merge base with the base now — the way the pull request's
 * own diff is — so after a rebase or a force-push the two changes are
 * compared themselves, and upstream commits mix in nothing. When GitHub
 * no longer has that commit, every part counts as changed.
 */
export async function lookSinceLastLook(options: LastLookOptions): Promise<SinceLastLook | undefined> {
  const { client, cacheDir, ref, pullRequest } = options;
  const head = pullRequest.headSha;
  const looks = await readLooks(cacheDir, ref);
  const local = looks === null ? undefined : looks.last.commit !== head ? looks.last : looks.before;
  const reviewed = local === undefined ? await client.getLastReviewedCommit(ref) : null;
  const last = local ?? reviewed ?? undefined;
  const since = last === undefined ? undefined : await compareWith(last, local === undefined ? 'github review' : 'local record', options);
  await recordLook(cacheDir, ref, { commit: head, at: (options.now ?? new Date()).toISOString() });
  return since;
}

async function compareWith(last: Look, from: SinceLastLook['from'], options: LastLookOptions): Promise<SinceLastLook> {
  const { client, ref, pullRequest } = options;
  const look = { commit: last.commit, from, at: last.at };
  if (last.commit === pullRequest.headSha) return { ...look, outcome: 'compared', changed: [] };
  const before = await client.getChangeDiff(ref, pullRequest.baseCommit, last.commit);
  if (before === null) return { ...look, outcome: 'commit gone', changed: [] };
  const held = new Set(parseDiff(before).files.flatMap(changePieces));
  const now = parseDiff(options.diff).files.flatMap(changePieces);
  return { ...look, outcome: 'compared', changed: [...new Set(now.filter((piece) => !held.has(piece)))] };
}
