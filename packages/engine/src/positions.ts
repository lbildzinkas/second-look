import { parseDiff } from './diff.js';
import type { Comment, Hunk } from './protocol.js';

/**
 * One comment of the pending review, mapped to where GitHub anchors it in
 * the diff: a line comment by its position in the file's diff, a part
 * comment as anchored to the file itself.
 */
export interface PositionedComment {
  /** The file, by its path on the new side. */
  path: string;
  body: string;
  /**
   * The position in the file's diff, for a line comment. This is not the
   * line number in the file: it counts the lines of the file's patch, the
   * first `@@` hunk header being position 0, the line just below it
   * position 1, and so on, continuing through the rest of the file's
   * hunks and counting their `@@` headers too, until the next file begins.
   */
  position?: number;
  /** Marks a comment on a whole part, which GitHub anchors to the file. */
  subjectType?: 'file';
}

/**
 * Maps the pending review's comments to their positions in the pull
 * request's diff, so one request can carry them all to GitHub.
 *
 * A line comment names its line by side and number, the way the reviewer
 * read it in the diff editor; the position it must travel as is the line's
 * index in that file's patch, which only the diff itself can answer. The
 * file is found by its new-side path — for a rename, the path after the
 * rename, whichever side the line sits on. A part comment carries no line
 * and needs no position: GitHub anchors it to the file.
 *
 * Throws a plain error naming every comment that cannot be mapped: a file
 * the diff does not touch, or a line the diff does not show on that side.
 * A comment that cannot be mapped is never sent, so nothing reaches
 * GitHub half-mapped.
 */
export function positionComments(diff: string, comments: readonly Comment[]): PositionedComment[] {
  const files = parseDiff(diff).files;
  const problems: string[] = [];
  const positioned: PositionedComment[] = [];
  for (const [index, comment] of comments.entries()) {
    const file = files.find((candidate) => candidate.path === comment.path);
    if (file === undefined) {
      problems.push(
        `comment ${index + 1}: the diff touches no file at ${comment.path}`,
      );
      continue;
    }
    if (comment.kind === 'part') {
      positioned.push({ path: comment.path, body: comment.body, subjectType: 'file' });
      continue;
    }
    const position = linePosition(file.hunks, comment);
    if (position === undefined) {
      problems.push(
        `comment ${index + 1}: the diff shows no line ${comment.line} on the ` +
          `${comment.side} side of ${comment.path}`,
      );
      continue;
    }
    positioned.push({ path: comment.path, body: comment.body, position });
  }
  if (problems.length > 0) {
    throw new Error(`comments could not be mapped to the diff: ${problems.join('; ')}`);
  }
  return positioned;
}

/**
 * The position of one line in its file's hunks: the index of the line in
 * the patch, counting each hunk's `@@` header, from the file's first
 * header at 0. `\ No newline at end of file` markers annotate the line
 * before them rather than taking a position of their own.
 */
function linePosition(hunks: readonly Hunk[], comment: Extract<Comment, { kind: 'line' }>): number | undefined {
  let position = 0;
  for (const hunk of hunks) {
    // The hunk's `@@` header sits at the next position; its first body
    // line is the one below it.
    position++;
    for (const [index, line] of hunk.lines.entries()) {
      // A line the side does not show — an addition has no old-side line —
      // carries no number there, so it matches no comment.
      const number = comment.side === 'head' ? line.newLineNumber : line.oldLineNumber;
      if (number === comment.line) {
        return position + index;
      }
    }
    position += hunk.lines.length;
  }
  return undefined;
}
