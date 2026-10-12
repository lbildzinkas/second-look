import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parsePullRequestUrl, type CommentSide } from '@second-look/engine';

/** The folder, inside the extension's global storage, the saved comments live in. */
export const SAVED_COMMENTS_DIR = 'pending-comments' as const;

/**
 * One pending comment the store keeps for a pull request: a comment of
 * the review the reviewer has not sent yet, exactly as they wrote it,
 * with where it points — and, for a line comment, the text of that line
 * as the diff showed it when the comment was written, so a review opened
 * again after new commits can tell which comments point at lines that
 * changed.
 */
export type SavedComment =
  | {
      kind: 'line';
      /** The file, by its path on the new side, as the comment travels to GitHub. */
      path: string;
      /** The side the line sits on: the base copy or the head copy. */
      side: CommentSide;
      /** The line's 1-based number on that side. */
      line: number;
      /** The comment's text, exactly as the reviewer wrote it. */
      body: string;
      /** The text of the line it points at, when the diff showed it; the anchor a later diff is compared with. */
      text?: string;
    }
  | {
      /** A comment on a whole part, which GitHub anchors to the file. */
      kind: 'part';
      /** The file, by its path on the new side, as the comment travels to GitHub. */
      path: string;
      /** The comment's text, exactly as the reviewer wrote it. */
      body: string;
    };

/** One draft still open for editing, which has not joined the pending review yet. */
export type SavedDraft =
  | {
      kind: 'line';
      /** The file, by its path on the new side, whose head side the draft sits on. */
      path: string;
      /** The line's 1-based number on the head side. */
      line: number;
      /** The draft's text, as last seen. */
      body: string;
      /** The finding the draft was drafted from. */
      from: string;
      /** The text of the line it points at, when the diff showed it; the anchor a later diff is compared with. */
      text?: string;
    }
  | {
      kind: 'part';
      /** The file, by its path on the new side, whose part the draft sits on. */
      path: string;
      /** The draft's text, as last seen. */
      body: string;
      /** The finding the draft was drafted from. */
      from: string;
    };

/** What the store keeps for one pull request: the head commit its comments were written against, and its pending comments and open drafts, nothing else. */
export interface SavedComments {
  version: 1;
  /** The head commit the review was at when last saved; provenance for the lines the comments point at. */
  head: string;
  comments: SavedComment[];
  drafts: SavedDraft[];
}

/** A commit, as the store records one. */
const COMMIT = /^[0-9a-f]{40,64}$/i;

function isSavedComment(value: unknown): value is SavedComment {
  if (typeof value !== 'object' || value === null) return false;
  const { kind, path, body } = value as Record<string, unknown>;
  if (typeof path !== 'string' || path === '' || typeof body !== 'string') return false;
  if (kind === 'part') return true;
  if (kind !== 'line') return false;
  const { side, line, text } = value as Record<string, unknown>;
  return (
    (side === 'base' || side === 'head') &&
    typeof line === 'number' &&
    Number.isInteger(line) &&
    line > 0 &&
    (text === undefined || typeof text === 'string')
  );
}

function isSavedDraft(value: unknown): value is SavedDraft {
  if (typeof value !== 'object' || value === null) return false;
  const { kind, path, body, from } = value as Record<string, unknown>;
  if (typeof path !== 'string' || path === '' || typeof body !== 'string' || typeof from !== 'string') return false;
  if (kind === 'part') return true;
  if (kind !== 'line') return false;
  const { line, text } = value as Record<string, unknown>;
  return (
    typeof line === 'number' &&
    Number.isInteger(line) &&
    line > 0 &&
    (text === undefined || typeof text === 'string')
  );
}

/** Whether a value is the store's contents; anything else reads as nothing saved rather than trusted. */
function isSavedComments(value: unknown): value is SavedComments {
  if (typeof value !== 'object' || value === null) return false;
  const { version, head, comments, drafts } = value as Record<string, unknown>;
  return (
    version === 1 &&
    typeof head === 'string' &&
    COMMIT.test(head) &&
    Array.isArray(comments) &&
    comments.every(isSavedComment) &&
    Array.isArray(drafts) &&
    drafts.every(isSavedDraft)
  );
}

/**
 * The pull request's file in the store, named by where the pull request
 * lives — `owner__repo__pull-number` — or, for a URL that names no GitHub
 * pull request, by a hash of the URL: one file per pull request, in the
 * extension's own global storage, never in the workspace.
 */
function fileOf(dir: string, url: string): string {
  const ref = parsePullRequestUrl(url);
  const name = ref === null ? createHash('sha256').update(url).digest('hex') : `${ref.owner}__${ref.repo}__pull-${ref.number}`;
  return join(dir, `${name}.json`);
}

/**
 * The pending comments and open drafts a reviewer has not sent, kept per
 * pull request in one file on disk (issue 168), so closing the editor
 * loses none of them: saved as they change, restored when the pull
 * request's review is opened again, and cleared when the review is sent.
 * Nothing saved here is sent anywhere; it leaves the machine only as
 * part of the review the reviewer submits (ADR 0002).
 */
export class CommentStore {
  private readonly dir: string;

  /** Each file's latest write, so saves made in quick succession land in order. */
  private readonly writes = new Map<string, Promise<unknown>>();

  constructor(dir: string) {
    this.dir = dir;
  }

  /**
   * Reads a pull request's saved comments and drafts. Nothing saved — or
   * a file that is not the store's contents — reads as undefined rather
   * than trusted.
   */
  async read(url: string): Promise<SavedComments | undefined> {
    let text: string;
    try {
      text = await readFile(fileOf(this.dir, url), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
    let stored: unknown;
    try {
      stored = JSON.parse(text);
    } catch {
      return undefined;
    }
    return isSavedComments(stored) ? stored : undefined;
  }

  /**
   * Saves a pull request's pending comments and open drafts as they now
   * stand, whole: written beside the store, then renamed over. A record
   * with nothing unsent removes the file, so sending the review clears
   * what was saved for it. Writes to one file apply one after another.
   */
  save(url: string, saved: SavedComments): Promise<void> {
    const path = fileOf(this.dir, url);
    const previous = this.writes.get(path) ?? Promise.resolve();
    const next = previous.then(
      () => this.write(path, saved),
      () => this.write(path, saved),
    );
    this.writes.set(path, next);
    void next
      .catch(() => undefined)
      .finally(() => {
        if (this.writes.get(path) === next) this.writes.delete(path);
      });
    return next;
  }

  private async write(path: string, saved: SavedComments): Promise<void> {
    if (saved.comments.length === 0 && saved.drafts.length === 0) {
      await rm(path, { force: true });
      return;
    }
    await mkdir(this.dir, { recursive: true });
    const partial = `${path}.partial-${randomBytes(6).toString('hex')}`;
    try {
      await writeFile(partial, `${JSON.stringify(saved, null, 2)}\n`, 'utf8');
      await rename(partial, path);
    } catch (error) {
      await rm(partial, { force: true });
      throw error;
    }
  }
}
