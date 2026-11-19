import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ensureCopy, pullRequestCacheDir } from './cache.js';
import type { GitHubClient, PullRequestRef } from './github.js';
import { REVIEW_RESULT_VERSION, type ReviewResult, type ReviewResultVersion, type SavedReview } from './protocol.js';

/** The file in a pull request's cache folder that holds its latest review result. */
export const SAVED_REVIEW_FILE = 'review-result.json';

/** Who produced a saved result, and when: what its label says on a later visit. */
export type SavedStamp = Pick<SavedReview, 'reviewedAt' | 'agent'>;

/**
 * The store's record: the latest result, keyed by the result version it
 * was saved at and the head commit it reviewed, with who produced it.
 */
interface SavedRecord extends SavedStamp {
  version: ReviewResultVersion;
  commit: string;
  result: ReviewResult;
}

function savedPath(cacheDir: string, ref: PullRequestRef): string {
  return join(pullRequestCacheDir(cacheDir, ref), SAVED_REVIEW_FILE);
}

/**
 * Reads the pull request's saved review; null when none was saved, or
 * when it was saved at another result version, is not of the commit it
 * names, or is not a record at all, which is then left out rather than
 * misread.
 */
export async function readSavedReview(cacheDir: string, ref: PullRequestRef): Promise<SavedRecord | null> {
  let stored: unknown;
  try {
    stored = JSON.parse(await readFile(savedPath(cacheDir, ref), 'utf8'));
  } catch {
    return null;
  }
  if (typeof stored !== 'object' || stored === null) return null;
  const { version, commit, reviewedAt, agent, result } = stored as Partial<SavedRecord>;
  if (version !== REVIEW_RESULT_VERSION || typeof commit !== 'string' || typeof reviewedAt !== 'string') return null;
  if (typeof result !== 'object' || result === null || result.version !== REVIEW_RESULT_VERSION) return null;
  if (result.pullRequest?.headSha !== commit || !Array.isArray(result.parts)) return null;
  return { version, commit, reviewedAt, ...(agent ? { agent } : {}), result };
}

/**
 * Saves a pull request's latest review result over the one before, with
 * who produced it; the label a shown saved result carries is left off.
 * The record lands whole: written beside the store, then renamed over it.
 */
export async function saveReview(cacheDir: string, ref: PullRequestRef, result: ReviewResult, stamp: SavedStamp): Promise<void> {
  const { saved: _label, ...kept } = result;
  const record: SavedRecord = { version: REVIEW_RESULT_VERSION, commit: kept.pullRequest.headSha, ...stamp, result: kept };
  const path = savedPath(cacheDir, ref);
  await mkdir(pullRequestCacheDir(cacheDir, ref), { recursive: true });
  const partial = `${path}.partial-${randomBytes(6).toString('hex')}`;
  try {
    await writeFile(partial, JSON.stringify(record), 'utf8');
    await rename(partial, path);
  } catch (error) {
    await rm(partial, { force: true });
    throw error;
  }
}

/** What restoring a saved review needs: the cache folder, the pull request and a GitHub client with the request's token. */
export interface RestoreOptions {
  cacheDir: string;
  ref: PullRequestRef;
  client: GitHubClient;
}

/**
 * The pull request's saved review, labelled for showing at once with no
 * agent run: with when and by whom it was produced, and the pull
 * request's head now when it has new commits since, so it is shown as
 * from an earlier commit. Its read-only copies are the ones the cache
 * holds at the same commits, downloaded again only when gone. Undefined
 * when no saved review can be read, or when its copies are gone and can
 * no longer be downloaded, such as after a force-push: the pull request
 * is then reviewed afresh.
 */
export async function restoreSavedReview(options: RestoreOptions): Promise<{ result: ReviewResult; stamp: SavedStamp } | undefined> {
  const { cacheDir, ref, client } = options;
  const record = await readSavedReview(cacheDir, ref);
  if (record === null) return undefined;
  const { summary } = await client.getPullRequest(ref);
  const copy = (commit: string) => ensureCopy({ cacheDir, ref, commit, download: (wanted) => client.downloadTarball(ref, wanted) });
  let copies: ReviewResult['copies'];
  try {
    const [base, head] = await Promise.all([copy(record.result.copies.base.commit), copy(record.commit)]);
    copies = { base, head };
  } catch {
    return undefined;
  }
  const stamp: SavedStamp = { reviewedAt: record.reviewedAt, ...(record.agent ? { agent: record.agent } : {}) };
  const saved: SavedReview = { ...stamp, ...(summary.headSha !== record.commit ? { newHead: summary.headSha } : {}) };
  return { result: { ...record.result, copies, saved }, stamp };
}
