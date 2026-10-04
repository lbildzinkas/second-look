import * as vscode from 'vscode';
import type { Comment, Part, ReviewResult, SubmitKind } from '@second-look/engine';
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

/** How each submit kind reads in the picker the reviewer chooses it in. */
const SUBMIT_CHOICES: ReadonlyArray<{
  submit: SubmitKind;
  label: string;
  detail: string;
}> = [
  {
    submit: 'comment',
    label: 'Comment',
    detail: 'Submit the review as comments, without approving or blocking.',
  },
  {
    submit: 'approve',
    label: 'Approve',
    detail: 'Submit the review approving the change.',
  },
  {
    submit: 'request changes',
    label: 'Request changes',
    detail: 'Submit the review asking for changes before it can merge.',
  },
];

/**
 * Asks how the reviewer submits the pending review. The choice is the
 * deliberate step: dismissing it sends nothing.
 */
export async function pickSubmitKind(): Promise<SubmitKind | undefined> {
  const picked = (await vscode.window.showQuickPick(
    SUBMIT_CHOICES.map((choice) => ({
      label: choice.label,
      detail: choice.detail,
      submit: choice.submit,
    })),
    { title: 'Submit the review as…', placeHolder: 'Every pending comment goes with it' },
  )) as { submit: SubmitKind } | undefined;
  return picked?.submit;
}

/**
 * Reads the review's overall comment on the whole pull request. Empty
 * means none; dismissing cancels the send.
 */
export async function readOverallComment(): Promise<string | undefined> {
  return vscode.window.showInputBox({
    prompt: 'Overall comment on the pull request (optional)',
    placeHolder: 'Sent as the review’s own comment',
    ignoreFocusOut: true,
  });
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

/** The thread's label: where its comment points. */
function threadLabel(comment: Comment): string {
  return comment.kind === 'line' ? `${comment.path}:${comment.line}` : `${comment.path} (part)`;
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
    reply.thread.label = threadLabel(comment);
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
    thread.label = threadLabel({ kind: 'part', path: part.path, body: '' });
  }

  /** Discards one thread of the pending review, gathered comment and all. */
  discard(thread: vscode.CommentThread): void {
    const gathered = this.threads.delete(thread);
    thread.dispose();
    if (gathered) {
      this.changed.fire();
    }
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
