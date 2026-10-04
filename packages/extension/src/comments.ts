import * as vscode from 'vscode';
import type { Comment, Part, ReviewResult } from '@second-look/engine';
import { partFiles, type ChangeSide } from './change-copies.js';
import {
  COMMENT_CONTROLLER_ID,
  PENDING_THREAD_CONTEXT,
} from './commands.js';

/** Where a comment written in the diff editor lands: one file, one side. */
export interface CommentTarget {
  /**
   * The file, by its path on the new side, as the comment travels to
   * GitHub — for a rename, the path after the rename, whichever side the
   * line sits on.
   */
  path: string;
  /** The side the thread's editor shows: the base copy or the head copy. */
  side: ChangeSide;
  /** The path that side's document shows: the previous one for a rename. */
  sidePath: string;
}

/** The change documents of one review, resolved to what a comment targets. */
const targetsByResult = new WeakMap<ReviewResult, Map<string, CommentTarget>>();

/**
 * Resolves the change document a comment thread sits on to the file and
 * side its comment targets. Anything else — a file of the reviewer's own
 * workspace, the empty stand-in of a side the change does not have —
 * targets nothing, so no comment can be written there.
 */
export function commentTargetOf(
  result: ReviewResult,
  uri: vscode.Uri,
): CommentTarget | undefined {
  let targets = targetsByResult.get(result);
  if (targets === undefined) {
    targets = new Map();
    for (const part of result.parts) {
      const [file] = partFiles(result.copies, part);
      if (file === undefined) continue;
      if (part.changeKind !== 'addition') {
        targets.set(file.original.toString(), {
          path: part.path,
          side: 'base',
          sidePath: part.previousPath ?? part.path,
        });
      }
      if (part.changeKind !== 'deletion') {
        targets.set(file.modified.toString(), {
          path: part.path,
          side: 'head',
          sidePath: part.path,
        });
      }
    }
    targetsByResult.set(result, targets);
  }
  return targets.get(uri.toString());
}

/** The 0-based span of lines a hunk covers on one side, if it has any. */
function hunkRange(
  hunk: Part['hunks'][number],
  side: ChangeSide,
): vscode.Range | undefined {
  const start = side === 'head' ? hunk.newStart : hunk.oldStart;
  const lines = side === 'head' ? hunk.newLines : hunk.oldLines;
  if (lines === 0) {
    return undefined;
  }
  return new vscode.Range(start - 1, 0, start + lines - 2, Number.MAX_SAFE_INTEGER);
}

/**
 * The lines of one side of one file a reviewer can comment on: the spans
 * its hunks cover there, where GitHub can anchor a comment. Binary files
 * and pure renames have no hunks, so their sides offer only a comment on
 * the whole part.
 */
export function commentableRanges(
  target: CommentTarget,
  result: ReviewResult,
): vscode.Range[] {
  const ranges: vscode.Range[] = [];
  for (const part of result.parts) {
    const sidePath = target.side === 'head' ? part.path : part.previousPath ?? part.path;
    if (sidePath !== target.sidePath) continue;
    for (const hunk of part.hunks) {
      const range = hunkRange(hunk, target.side);
      if (range !== undefined) ranges.push(range);
    }
  }
  return ranges;
}

/** Where a comment points: `path:line`, or `path (part)` for a whole part. */
export function commentLocation(comment: Comment): string {
  return comment.kind === 'line' ? `${comment.path}:${comment.line}` : `${comment.path} (part)`;
}

/** One pending comment shown in its thread, as the editor renders it. */
function shownComment(body: string): vscode.Comment {
  return {
    body,
    mode: vscode.CommentMode.Preview,
    author: { name: 'You' },
    label: 'pending',
  };
}

/**
 * The comments the reviewer wrote, gathered into one pending review
 * (ADR 0002): written as threads in the diff editor — on a line of the
 * diff, or on a whole part — they reach GitHub only when the reviewer
 * submits, and a failed send keeps every one of them.
 *
 * The editor's own comment threads are the writing surface: it offers a
 * thread wherever the review's hunks sit, the reviewer types into it, and
 * the thread's submit runs {@link add} with what was written. The
 * companion keeps each thread and its comment together, so discarding a
 * thread discards its comment from the review.
 */
export class ReviewComments implements vscode.Disposable {
  private readonly controller: vscode.CommentController;

  private readonly threads = new Map<vscode.CommentThread, Comment>();

  private readonly changed = new vscode.EventEmitter<void>();

  private result: ReviewResult | undefined;

  /** True while the pending review's one write is under way. */
  private sending = false;

  /** Fires whenever a comment joins or leaves the pending review. */
  readonly onDidChange = this.changed.event;

  constructor() {
    this.controller = vscode.comments.createCommentController(
      COMMENT_CONTROLLER_ID,
      'Second Look',
    );
    this.controller.options = { placeHolder: 'Write a review comment…' };
    this.controller.commentingRangeProvider = {
      provideCommentingRanges: (document) => {
        const result = this.result;
        if (result === undefined) {
          return undefined;
        }
        const target = commentTargetOf(result, document.uri);
        if (target === undefined) {
          return undefined;
        }
        return {
          enableFileComments: true,
          ranges: commentableRanges(target, result),
        };
      },
    };
  }

  /** The comments gathered so far, in the order the reviewer wrote them. */
  pending(): readonly Comment[] {
    return [...this.threads.values()];
  }

  /**
   * Performs the pending review's one write with the gathering sealed:
   * while the write is under way — the sign-in it may ask for, the
   * round-trip to GitHub — no comment joins the review, leaves it, or
   * is rewritten, so what is written is exactly the review the reviewer
   * pressed for.
   */
  async sendWhileSealed<T>(write: () => Promise<T>): Promise<T> {
    this.sending = true;
    try {
      return await write();
    } finally {
      this.sending = false;
    }
  }

  /**
   * Turns to a new review: the pending review of the old one is gone, so
   * its comments and threads are too.
   */
  setReview(result: ReviewResult): void {
    this.result = result;
    this.clear();
  }

  /**
   * Adds the comment the reviewer wrote in a thread to the pending
   * review. A thread on a line of the diff becomes a line comment; a
   * thread with no line, started for a whole part, becomes a comment on
   * the part.
   */
  add(reply: vscode.CommentReply): void {
    if (this.sending) {
      return;
    }
    const result = this.result;
    const target = result === undefined ? undefined : commentTargetOf(result, reply.thread.uri);
    if (result === undefined || target === undefined) {
      reply.thread.dispose();
      return;
    }
    const comment: Comment =
      reply.thread.range === undefined
        ? { kind: 'part', path: target.path, body: reply.text }
        : {
            kind: 'line',
            path: target.path,
            side: target.side,
            line: reply.thread.range.start.line + 1,
            body: reply.text,
          };
    this.threads.set(reply.thread, comment);
    reply.thread.comments = [shownComment(reply.text)];
    reply.thread.canReply = false;
    reply.thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
    reply.thread.contextValue = PENDING_THREAD_CONTEXT;
    reply.thread.label = commentLocation(comment);
    this.changed.fire();
  }

  /** Starts a comment on a whole part: a thread on its file, at no line. */
  commentOnPart(part: Part): void {
    const result = this.result;
    if (result === undefined) {
      return;
    }
    const [file] = partFiles(result.copies, part);
    if (file === undefined) {
      return;
    }
    const uri = part.changeKind === 'deletion' ? file.original : file.modified;
    // A thread at no line is the editor's own file comment; it is created
    // over a line first, then let loose of it.
    const thread = this.controller.createCommentThread(uri, new vscode.Range(0, 0, 0, 0), []);
    thread.range = undefined;
    thread.canReply = true;
    thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
    thread.contextValue = PENDING_THREAD_CONTEXT;
    thread.label = commentLocation({ kind: 'part', path: part.path, body: '' });
  }

  /** Discards one thread of the pending review, gathered comment and all. */
  discard(thread: vscode.CommentThread): void {
    if (this.sending) {
      return;
    }
    const gathered = this.threads.delete(thread);
    thread.dispose();
    if (gathered) {
      this.changed.fire();
    }
  }

  /**
   * Rewrites one gathered comment, the way the Send review page edits
   * it: its thread shows the new text and the pending review carries it.
   * The comment object itself is rewritten in place, so a hold on it —
   * the page's, a test's — stays valid. False when the comment is not
   * gathered anymore, dropped elsewhere meanwhile, or the review's one
   * write is under way.
   */
  editBody(comment: Comment, body: string): boolean {
    if (this.sending) {
      return false;
    }
    for (const [thread, gathered] of this.threads) {
      if (gathered !== comment) continue;
      comment.body = body;
      thread.comments = [shownComment(body)];
      this.changed.fire();
      return true;
    }
    return false;
  }

  /**
   * Drops one gathered comment from the pending review, the way the Send
   * review page discards it, thread and all. False when the comment is
   * not gathered anymore, or the review's one write is under way.
   */
  remove(comment: Comment): boolean {
    if (this.sending) {
      return false;
    }
    for (const [thread, gathered] of this.threads) {
      if (gathered !== comment) continue;
      this.discard(thread);
      return true;
    }
    return false;
  }

  /** Empties the pending review, its comments and threads gone. */
  clear(): void {
    for (const thread of this.threads.keys()) {
      thread.dispose();
    }
    this.threads.clear();
    this.changed.fire();
  }

  dispose(): void {
    this.threads.clear();
    this.changed.dispose();
    this.controller.dispose();
  }
}
