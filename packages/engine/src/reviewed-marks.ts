import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pullRequestCacheDir } from './cache.js';
import type { PullRequestRef } from './github.js';
import { filesOfPart } from './parts.js';
import type { FileSlice, Hunk, Part, ReviewedMark, ReviewedMarks, ReviewedState } from './protocol.js';

/** The file in a pull request's cache folder that holds its reviewed marks. */
export const REVIEWED_MARKS_FILE = 'reviewed-marks.json';

/** The marks of a pull request nobody has marked yet. */
export const NO_MARKS: ReviewedMarks = { marks: [] };

const SHA256 = /^[0-9a-f]{64}$/;

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** What every piece of a file carries about the file itself: where it lives and how it changed. */
function fileIdentity(file: FileSlice): unknown[] {
  return [file.path, file.previousPath ?? null, file.changeKind, file.oldMode ?? null, file.newMode ?? null];
}

/** A hunk's content without its line numbers, so an edit elsewhere in the file leaves it alone. */
function hunkContent(hunk: Hunk): string[] {
  const prefix = { context: ' ', addition: '+', deletion: '-' } as const;
  return hunk.lines.map((line) => `${prefix[line.kind]}${line.text}${line.endsWithoutNewline ? '\n\\' : ''}`);
}

/**
 * The content hashes of a part's pieces, in order: one per hunk of each
 * of its files — the file's path, change and modes, and the hunk's lines
 * without their numbers — and one for a file without hunks, such as a
 * binary, whose blob ids stand for its content. Identical hunks of one
 * file are told apart by how many came before.
 */
export function partPieces(part: Part): string[] {
  return filesOfPart(part).flatMap((file) => {
    const identity = fileIdentity(file);
    if (file.hunks.length === 0) {
      return [sha256(JSON.stringify([...identity, file.isBinary, file.blobs ?? null]))];
    }
    const seen = new Map<string, number>();
    return file.hunks.map((hunk) => {
      const content = JSON.stringify([...identity, hunkContent(hunk)]);
      const occurrence = seen.get(content) ?? 0;
      seen.set(content, occurrence + 1);
      return sha256(`${content}#${occurrence}`);
    });
  });
}

/** A part's content hash: the hash of its pieces' hashes, in order. */
export function partContentHash(part: Part): string {
  return sha256(partPieces(part).join('\n'));
}

/** The name a mark records for a part: its name, or its path when it has none. */
function markName(part: Part): string {
  return part.name ?? part.path;
}

/**
 * Where a part stands against the marks: reviewed when every one of its
 * pieces is marked, changed since marked when only some are, or when a
 * mark of the same name covers other content, and not reviewed otherwise.
 */
export function reviewedState(part: Part, marks: ReviewedMarks): ReviewedState {
  const marked = new Set(marks.marks.flatMap((mark) => mark.pieces));
  const pieces = partPieces(part);
  if (pieces.every((piece) => marked.has(piece))) return 'reviewed';
  const name = markName(part);
  if (pieces.some((piece) => marked.has(piece)) || marks.marks.some((mark) => mark.name === name)) {
    return 'changed since marked';
  }
  return 'not reviewed';
}

/** How many parts are left to review: every part not reviewed. */
export function partsLeft(parts: readonly Part[], marks: ReviewedMarks): number {
  return parts.filter((part) => reviewedState(part, marks) !== 'reviewed').length;
}

/**
 * The paths among those given whose every part is reviewed: a file split
 * across parts, or shared by a part across files, counts only once all of
 * them are marked, so no file is ever only partly reviewed.
 */
export function wholeFilesReviewed(parts: readonly Part[], marks: ReviewedMarks, paths: readonly string[]): string[] {
  return [...new Set(paths)].filter((path) => {
    const holding = parts.filter((part) => filesOfPart(part).some((file) => file.path === path));
    return holding.length > 0 && holding.every((part) => reviewedState(part, marks) === 'reviewed');
  });
}

/** What the store needs of the part the reviewer marks or unmarks: its name and its pieces. */
export interface MarkedPart {
  name: string;
  pieces: string[];
}

/** The part as the store records it, from the part itself. */
export function markedPart(part: Part): MarkedPart {
  return { name: markName(part), pieces: partPieces(part) };
}

/**
 * The marks after the reviewer ticks or clears a part's checkbox. Ticking
 * it replaces every mark of the same name with one keyed by the part's
 * content hash now; clearing it removes the part's pieces from every mark
 * and every mark of the same name, so a regrouped part clears exactly the
 * content it shows.
 */
export function applyMark(marks: ReviewedMarks, part: MarkedPart, reviewed: boolean, now: Date): ReviewedMarks {
  const pieces = new Set(part.pieces);
  const kept = marks.marks.filter((mark) => mark.name !== part.name);
  if (reviewed) {
    const hash = sha256(part.pieces.join('\n'));
    return { marks: [...kept.filter((mark) => mark.hash !== hash), { hash, name: part.name, pieces: [...part.pieces], markedAt: now.toISOString() }] };
  }
  return {
    marks: kept
      .map((mark) => ({ ...mark, pieces: mark.pieces.filter((piece) => !pieces.has(piece)) }))
      .filter((mark) => mark.pieces.length > 0),
  };
}

/** Whether a value is a part the store can record: a name and at least one piece hash. */
export function isMarkedPart(value: unknown): value is MarkedPart {
  if (typeof value !== 'object' || value === null) return false;
  const { name, pieces } = value as Record<string, unknown>;
  return (
    typeof name === 'string' &&
    name.length > 0 &&
    Array.isArray(pieces) &&
    pieces.length > 0 &&
    pieces.every((piece) => typeof piece === 'string' && SHA256.test(piece))
  );
}

function isReviewedMark(value: unknown): value is ReviewedMark {
  if (!isMarkedPart(value)) return false;
  const { hash, markedAt } = value as unknown as Record<string, unknown>;
  return typeof hash === 'string' && SHA256.test(hash) && typeof markedAt === 'string';
}

/** The store file's shape: the marks keyed by the part's content hash when marked. */
interface StoredMarks {
  version: 1;
  marks: Record<string, Omit<ReviewedMark, 'hash'>>;
}

function marksPath(cacheDir: string, ref: PullRequestRef): string {
  return join(pullRequestCacheDir(cacheDir, ref), REVIEWED_MARKS_FILE);
}

/**
 * Reads a pull request's reviewed marks from its local store, which
 * outlives the engine. A store not written yet holds no marks, and an
 * entry that is not a mark is left out rather than trusted.
 */
export async function readReviewedMarks(cacheDir: string, ref: PullRequestRef): Promise<ReviewedMarks> {
  let text: string;
  try {
    text = await readFile(marksPath(cacheDir, ref), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return NO_MARKS;
    throw error;
  }
  let stored: unknown;
  try {
    stored = JSON.parse(text);
  } catch {
    return NO_MARKS;
  }
  const entries = (stored as Partial<StoredMarks> | null)?.marks;
  if (typeof entries !== 'object' || entries === null) return NO_MARKS;
  return {
    marks: Object.entries(entries)
      .map(([hash, mark]) => ({ ...(mark as object), hash }))
      .filter(isReviewedMark),
  };
}

/** Each store's latest write, so marks made in quick succession apply in order. */
const writes = new Map<string, Promise<unknown>>();

/**
 * Ticks or clears one part's checkbox in a pull request's local store and
 * answers with the marks as they now stand. Writes to one store apply one
 * after another, and each lands whole: written beside the store, then
 * renamed over it.
 */
export function saveReviewedMark(
  cacheDir: string,
  ref: PullRequestRef,
  part: MarkedPart,
  reviewed: boolean,
  now: Date = new Date(),
): Promise<ReviewedMarks> {
  const path = marksPath(cacheDir, ref);
  const previous = writes.get(path) ?? Promise.resolve();
  const next = previous.then(
    () => writeMark(cacheDir, ref, path, part, reviewed, now),
    () => writeMark(cacheDir, ref, path, part, reviewed, now),
  );
  writes.set(path, next);
  void next.finally(() => {
    if (writes.get(path) === next) writes.delete(path);
  }).catch(() => undefined);
  return next;
}

async function writeMark(
  cacheDir: string,
  ref: PullRequestRef,
  path: string,
  part: MarkedPart,
  reviewed: boolean,
  now: Date,
): Promise<ReviewedMarks> {
  const marks = applyMark(await readReviewedMarks(cacheDir, ref), part, reviewed, now);
  const stored: StoredMarks = {
    version: 1,
    marks: Object.fromEntries(marks.marks.map(({ hash, ...mark }) => [hash, mark])),
  };
  await mkdir(pullRequestCacheDir(cacheDir, ref), { recursive: true });
  const partial = `${path}.partial-${randomBytes(6).toString('hex')}`;
  try {
    await writeFile(partial, `${JSON.stringify(stored, null, 2)}\n`, 'utf8');
    await rename(partial, path);
  } catch (error) {
    await rm(partial, { force: true });
    throw error;
  }
  return marks;
}
