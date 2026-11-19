import * as vscode from 'vscode';
import { findingAnchor, filesOfPart, type Comment, type CommentSide, type FindingRef, type Part, type ReviewResult } from '@second-look/engine';
import { changeUri, partFiles, type ChangeSide } from './change-copies.js';
import { CommentStore, type SavedComment, type SavedComments, type SavedDraft } from './comment-store.js';
import {
  COMMENT_CONTROLLER_ID,
  DRAFT_COMMENT_CONTEXT,
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

/**
 * Where a draft from a finding is written: a line of the head side's
 * diff, or a whole part.
 */
export type DraftTarget = { kind: 'line'; path: string; line: number } | { kind: 'part'; part: Part };

/**
 * Where a draft from a finding is written: a claim's on the line its
 * finding's thread sits on, when the diff shows that line on the head
 * side, where GitHub can anchor a comment, else on the claim's part; an
 * unexplained part's on that part. A described change and an acceptance
 * criterion are about the whole pull request, so theirs has no place in
 * the diff: undefined, as for a finding the result does not hold.
 */
export function draftTarget(result: ReviewResult, ref: FindingRef): DraftTarget | undefined {
  if (ref.kind === 'unexplained part') {
    const entry = result.unexplained?.parts[ref.index];
    const part = entry === undefined ? undefined : result.parts[entry.part];
    return part === undefined ? undefined : { kind: 'part', part };
  }
  const claim = ref.kind === 'claim' ? result.claims?.claims[ref.index] : undefined;
  if (claim === undefined) return undefined;
  const anchor = findingAnchor(claim, result.parts);
  if (anchor !== undefined) {
    const line = anchor.line - 1;
    const ranges = commentableRanges({ path: anchor.path, side: 'head', sidePath: anchor.path }, result);
    if (ranges.some((range) => range.start.line <= line && line <= range.end.line)) return { kind: 'line', path: anchor.path, line: anchor.line };
  }
  const part = result.parts[claim.part];
  return part === undefined ? undefined : { kind: 'part', part };
}

/** Where a comment points: `path:line`, or `path (part)` for a whole part. */
export function commentLocation(comment: Comment): string {
  return comment.kind === 'line' ? `${comment.path}:${comment.line}` : `${comment.path} (part)`;
}

/** Where a draft points, as its thread and step 7 name it: `path:line`, or `path (part)`. */
export function draftLocation(draft: SavedDraft): string {
  return draft.kind === 'line' ? `${draft.path}:${draft.line}` : `${draft.path} (part)`;
}

/** What a thread's label says when the line its comment points at changed under new commits. */
const CHANGED_LINE = 'line changed';

/**
 * The text of one line of the diff, by its path, side and 1-based line
 * number, as the result's hunks show it; undefined when the diff no
 * longer holds that line. This is the anchor a saved comment's line is
 * compared with when a review is opened again after new commits.
 */
export function diffLineText(result: ReviewResult, path: string, side: CommentSide, line: number): string | undefined {
  for (const file of result.parts.flatMap(filesOfPart)) {
    if (file.path !== path) continue;
    for (const hunk of file.hunks) {
      for (const diff of hunk.lines) {
        const at = side === 'head' ? diff.newLineNumber : diff.oldLineNumber;
        if (at === line) return diff.text;
      }
    }
  }
  return undefined;
}

/** One comment of the pending review, or one draft still open, as step 7 of the side bar lists it. */
export interface ListedComment {
  /** Stays the same while the comment or draft does — a draft added keeps its own — so a press names it. */
  id: number;
  /** A gathered comment, or a draft not yet added nor discarded. */
  kind: 'comment' | 'draft';
  /** Where it points: `path:line`, or `path (part)`. */
  location: string;
  /** Its text: a comment's as gathered, a draft's as drafted. */
  body: string;
  /** The finding a draft was drafted from. */
  from?: string;
  /** True when new commits changed the line it points at since it was written: it stays, flagged, for the reviewer to check. */
  changed?: true;
}

/** One pending comment shown in its thread, as the editor renders it. */
function shownComment(body: string, changed = false): vscode.Comment {
  return {
    body,
    mode: vscode.CommentMode.Preview,
    author: { name: 'You' },
    label: changed ? `pending · ${CHANGED_LINE}` : 'pending',
  };
}

/** The text a comment or draft holds, as the editor hands it over. */
function textOf(comment: vscode.Comment): string {
  return typeof comment.body === 'string' ? comment.body : comment.body.value;
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
 *
 * What is written and not sent is also kept per pull request in a local
 * store, as it changes, and brought back — with new threads — when the
 * pull request's review is opened again (issue 168): a comment saved
 * against another head commit keeps its place, flagged when the line it
 * points at changed, and sending the review clears the store with it.
 */
export class ReviewComments implements vscode.Disposable {
  private readonly controller: vscode.CommentController;

  /** Where the pending comments and open drafts are kept per pull request; absent when none is kept. */
  private readonly store: CommentStore | undefined;

  private readonly threads = new Map<vscode.CommentThread, Comment>();

  /** The line each gathered line comment was written against, as the diff showed it then; the anchor a later diff is compared with. */
  private readonly anchors = new WeakMap<Comment, string>();

  /** The gathered comments, and the open drafts, whose line changed under new commits since they were written. */
  private changedLines = new WeakSet<object>();

  /** The drafts open for editing, each with its thread, where it points and its finding; none is in the pending review yet. */
  private readonly drafts = new Map<vscode.Comment, { thread: vscode.CommentThread; saved: SavedDraft; changed?: true }>();

  /** Each thread's id, which the side bar's presses name it by. */
  private readonly ids = new Map<vscode.CommentThread, number>();

  /** The reviews already restored, so each review's saved comments come back once. */
  private readonly restored = new WeakSet<ReviewResult>();

  /** What was saved last, so a save that changes nothing writes nothing. */
  private lastSaved = '';

  private nextId = 1;

  private readonly changed = new vscode.EventEmitter<void>();

  private result: ReviewResult | undefined;

  /** True while the pending review's one write is under way. */
  private sending = false;

  /** Fires whenever a comment joins or leaves the pending review, or a draft opens or closes. */
  readonly onDidChange = this.changed.event;

  constructor(store?: CommentStore) {
    this.store = store;
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

  /** Every gathered comment, then every draft still open, as step 7 lists them. */
  listed(): ListedComment[] {
    const comments = [...this.threads].map(([thread, comment]): ListedComment => ({
      id: this.idOf(thread),
      kind: 'comment',
      location: commentLocation(comment),
      body: comment.body,
      ...(this.changedLines.has(comment) ? { changed: true } : {}),
    }));
    const drafts = [...this.drafts].map(([comment, { thread, saved, changed }]): ListedComment => ({
      id: this.idOf(thread),
      kind: 'draft',
      location: draftLocation(saved),
      body: textOf(comment),
      from: saved.from,
      ...(changed === true ? { changed: true } : {}),
    }));
    // A draft's text is edited in its thread, which tells nothing, so the
    // save here is where an edit reaches the store.
    this.save();
    return [...comments, ...drafts];
  }

  private idOf(thread: vscode.CommentThread): number {
    let id = this.ids.get(thread);
    if (id === undefined) {
      id = this.nextId++;
      this.ids.set(thread, id);
    }
    return id;
  }

  /** The thread of a listed comment or draft, expanded so it shows once its file opens; undefined once it is gone. */
  reveal(id: number): vscode.CommentThread | undefined {
    const thread = this.threadOf(id);
    if (thread !== undefined) thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
    return thread;
  }

  /**
   * Acts on a listed comment or draft, as step 7's buttons press: discards
   * a comment, thread and all, or adds a draft — with the text it holds,
   * as drafted — or discards it. An id gone meanwhile does nothing.
   */
  act(id: number, action: 'discard' | 'add'): void {
    const thread = this.threadOf(id);
    if (thread === undefined) return;
    if (this.threads.has(thread)) {
      if (action === 'discard') this.discard(thread);
      return;
    }
    const draft = [...this.drafts].find(([, entry]) => entry.thread === thread)?.[0];
    if (draft === undefined) return;
    if (action === 'add') this.addDraft(draft);
    else this.discardDraft(draft);
  }

  private threadOf(id: number): vscode.CommentThread | undefined {
    const thread = [...this.ids].find(([, each]) => each === id)?.[0];
    if (thread === undefined) return undefined;
    return this.threads.has(thread) || [...this.drafts.values()].some((entry) => entry.thread === thread) ? thread : undefined;
  }

  /**
   * Performs the pending review's one write with the gathering sealed:
   * while the write is under way — the sign-in it may ask for, the
   * round-trip to GitHub — no comment joins the review, leaves it, or
   * is rewritten; a move tried anyway is refused with a warning, so
   * what is written is exactly the review the reviewer pressed for.
   */
  async sendWhileSealed<T>(write: () => Promise<T>): Promise<T> {
    this.sending = true;
    try {
      return await write();
    } finally {
      this.sending = false;
    }
  }

  /** Refuses a move on the pending review while its one write runs. */
  private refuseWhileSending(): void {
    vscode.window.showWarningMessage('The review is being sent: try again once it finishes.');
  }

  /**
   * Turns to a new review: the pending review of the old one is gone, so
   * its comments, its open drafts and their threads are too. What was
   * saved for the new pull request stays, for {@link restore} to bring
   * back; the old pull request's save stands as it was left.
   */
  setReview(result: ReviewResult): void {
    this.result = result;
    for (const { thread } of this.drafts.values()) {
      thread.dispose();
    }
    this.drafts.clear();
    this.ids.clear();
    this.changedLines = new WeakSet();
    for (const thread of this.threads.keys()) {
      thread.dispose();
    }
    this.threads.clear();
    // A review that shows nothing unsent yet writes nothing either — the
    // render the switch fires must not clear what restore is about to read.
    this.lastSaved = JSON.stringify(this.emptySave());
    this.changed.fire();
  }

  /**
   * Brings back the pull request's saved comments and open drafts, with
   * their threads, as its review is opened again — what the reviewer
   * wrote and had not sent survives the editor closing (issue 168). A
   * comment saved against another head commit keeps its place and is
   * flagged when the line it points at changed; none is dropped or
   * silently moved. Runs once per review shown; a failure to read only
   * warns, and the review starts empty as it did before.
   */
  async restore(): Promise<void> {
    const result = this.result;
    const store = this.store;
    if (result === undefined || store === undefined || this.restored.has(result)) return;
    this.restored.add(result);
    let saved: SavedComments | undefined;
    try {
      saved = await store.read(result.pullRequest.url);
    } catch (error) {
      vscode.window.showWarningMessage(
        `The saved comments could not be read: ${error instanceof Error ? error.message : String(error)}`,
      );
      return;
    }
    if (saved === undefined || this.result !== result) return;
    for (const comment of saved.comments) this.restoreComment(result, comment);
    for (const draft of saved.drafts) this.restoreDraft(result, draft);
    if (saved.comments.length > 0 || saved.drafts.length > 0) this.changed.fire();
  }

  /** The side of a file the current result's diff shows, by the path a comment travels under; undefined when the change no longer holds the file. */
  private sidePathIn(result: ReviewResult, path: string, side: CommentSide): string | undefined {
    for (const file of result.parts.flatMap(filesOfPart)) {
      if (file.path !== path) continue;
      return side === 'head' ? file.path : file.previousPath ?? file.path;
    }
    return undefined;
  }

  /** A thread on one line of a side's copy of a file, on the copy the review now shows. */
  private lineThread(result: ReviewResult, path: string, side: CommentSide, line: number): vscode.CommentThread {
    const uri = changeUri(side, result.copies[side].commit, this.sidePathIn(result, path, side) ?? path);
    return this.controller.createCommentThread(uri, new vscode.Range(line - 1, 0, line - 1, 0), []);
  }

  /** A thread at no line on a file: the part's first file when the change still holds it, else the file's head copy. */
  private partThreadOf(result: ReviewResult, path: string): vscode.CommentThread {
    const part = result.parts.find((each) => filesOfPart(each).some((file) => file.path === path));
    const fromPart = part === undefined ? undefined : this.partThread(result, part);
    if (fromPart !== undefined) return fromPart;
    const thread = this.controller.createCommentThread(changeUri('head', result.copies.head.commit, path), new vscode.Range(0, 0, 0, 0), []);
    thread.range = undefined;
    thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
    return thread;
  }

  /** Whether new commits changed the line a saved comment or draft points at, against the diff now shown. */
  private lineChanged(result: ReviewResult, path: string, side: CommentSide, line: number, text: string | undefined): boolean {
    return text !== undefined && diffLineText(result, path, side, line) !== text;
  }

  /** Puts one saved comment back as a gathered comment, on a new thread at the line or file it points at. */
  private restoreComment(result: ReviewResult, saved: SavedComment): void {
    const comment: Comment =
      saved.kind === 'line'
        ? { kind: 'line', path: saved.path, side: saved.side, line: saved.line, body: saved.body }
        : { kind: 'part', path: saved.path, body: saved.body };
    const changed = saved.kind === 'line' && this.lineChanged(result, saved.path, saved.side, saved.line, saved.text);
    const thread = saved.kind === 'line' ? this.lineThread(result, saved.path, saved.side, saved.line) : this.partThreadOf(result, saved.path);
    if (saved.kind === 'line' && saved.text !== undefined) this.anchors.set(comment, saved.text);
    if (changed) this.changedLines.add(comment);
    this.threads.set(thread, comment);
    thread.comments = [shownComment(saved.body, changed)];
    thread.canReply = false;
    thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
    thread.contextValue = PENDING_THREAD_CONTEXT;
    thread.label = changed ? `${commentLocation(comment)} · ${CHANGED_LINE}` : commentLocation(comment);
  }

  /** Puts one saved draft back, open for editing on a new thread where it points. */
  private restoreDraft(result: ReviewResult, saved: SavedDraft): void {
    const changed = saved.kind === 'line' && this.lineChanged(result, saved.path, 'head', saved.line, saved.text);
    const thread = saved.kind === 'line' ? this.lineThread(result, saved.path, 'head', saved.line) : this.partThreadOf(result, saved.path);
    const comment: vscode.Comment = {
      body: saved.body,
      mode: vscode.CommentMode.Editing,
      author: { name: 'Second Look' },
      label: `draft from ${saved.from}`,
      contextValue: DRAFT_COMMENT_CONTEXT,
    };
    thread.comments = [comment];
    thread.canReply = false;
    thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
    const location = draftLocation(saved);
    thread.label = changed ? `Draft comment · ${location} · ${CHANGED_LINE}` : `Draft comment · ${location}`;
    this.drafts.set(comment, { thread, saved, ...(changed ? { changed: true } : {}) });
  }

  /**
   * Adds the comment the reviewer wrote in a thread to the pending
   * review. A thread on a line of the diff becomes a line comment; a
   * thread with no line, started for a whole part, becomes a comment on
   * the part.
   */
  add(reply: vscode.CommentReply): void {
    if (this.sending) {
      this.refuseWhileSending();
      return;
    }
    this.gather(reply.thread, reply.text);
  }

  /** Gathers what was written in a thread into the pending review, the thread showing it as pending; undefined when the thread sits where no comment can go. */
  private gather(thread: vscode.CommentThread, text: string): Comment | undefined {
    const result = this.result;
    const target = result === undefined ? undefined : commentTargetOf(result, thread.uri);
    if (result === undefined || target === undefined) {
      thread.dispose();
      return undefined;
    }
    const comment: Comment =
      thread.range === undefined
        ? { kind: 'part', path: target.path, body: text }
        : {
            kind: 'line',
            path: target.path,
            side: target.side,
            line: thread.range.start.line + 1,
            body: text,
          };
    this.threads.set(thread, comment);
    if (comment.kind === 'line') {
      const anchor = diffLineText(result, comment.path, comment.side, comment.line);
      if (anchor !== undefined) this.anchors.set(comment, anchor);
    }
    thread.comments = [shownComment(text, this.changedLines.has(comment))];
    thread.canReply = false;
    thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
    thread.contextValue = PENDING_THREAD_CONTEXT;
    thread.label = commentLocation(comment);
    this.save();
    this.changed.fire();
    return comment;
  }

  /** A thread on a part's first file, at no line: the editor's own file comment. */
  private partThread(result: ReviewResult, part: Part): vscode.CommentThread | undefined {
    const [file] = partFiles(result.copies, part);
    if (file === undefined) {
      return undefined;
    }
    const uri = part.changeKind === 'deletion' ? file.original : file.modified;
    // A thread at no line is the editor's own file comment; it is created
    // over a line first, then let loose of it.
    const thread = this.controller.createCommentThread(uri, new vscode.Range(0, 0, 0, 0), []);
    thread.range = undefined;
    thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
    return thread;
  }

  /** Starts a comment on a whole part: a thread on its file, at no line. */
  commentOnPart(part: Part): void {
    const result = this.result;
    if (result === undefined) {
      return;
    }
    if (this.sending) {
      this.refuseWhileSending();
      return;
    }
    const thread = this.partThread(result, part);
    if (thread === undefined) {
      return;
    }
    thread.canReply = true;
    thread.contextValue = PENDING_THREAD_CONTEXT;
    thread.label = commentLocation({ kind: 'part', path: part.path, body: '' });
  }

  /**
   * Opens a comment the companion drafted from a finding in a thread of
   * its own, its text open for editing: on its line of the head side's
   * diff, or on its part as a whole. The draft joins the pending review
   * only when the reviewer adds it ({@link addDraft}), and leaves no trace
   * when they discard it ({@link discardDraft}). Gives the draft's thread,
   * for the caller to show; none when no draft opened.
   */
  draft(target: DraftTarget, body: string, from: string): vscode.CommentThread | undefined {
    const result = this.result;
    if (result === undefined) {
      return undefined;
    }
    if (this.sending) {
      this.refuseWhileSending();
      return undefined;
    }
    const thread =
      target.kind === 'line'
        ? this.controller.createCommentThread(
            changeUri('head', result.copies.head.commit, target.path),
            new vscode.Range(target.line - 1, 0, target.line - 1, 0),
            [],
          )
        : this.partThread(result, target.part);
    if (thread === undefined) {
      vscode.window.showWarningMessage('The draft has no file of its part to open on; review the pull request again.');
      return undefined;
    }
    const comment: vscode.Comment = {
      body,
      mode: vscode.CommentMode.Editing,
      author: { name: 'Second Look' },
      label: `draft from ${from}`,
      contextValue: DRAFT_COMMENT_CONTEXT,
    };
    thread.comments = [comment];
    thread.canReply = false;
    thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
    const location = target.kind === 'line' ? `${target.path}:${target.line}` : `${target.part.path} (part)`;
    thread.label = `Draft comment · ${location}`;
    const text = target.kind === 'line' ? diffLineText(result, target.path, 'head', target.line) : undefined;
    this.drafts.set(comment, {
      thread,
      saved:
        target.kind === 'line'
          ? { kind: 'line', path: target.path, line: target.line, body, from, ...(text !== undefined ? { text } : {}) }
          : { kind: 'part', path: target.part.path, body, from },
    });
    this.save();
    this.changed.fire();
    return thread;
  }

  /**
   * Adds a draft, with whatever the reviewer edited it to, to the pending
   * review: its thread becomes a pending comment's. An emptied draft is
   * refused with a warning, and stays open.
   */
  addDraft(comment: vscode.Comment): void {
    if (this.sending) {
      this.refuseWhileSending();
      return;
    }
    const entry = this.drafts.get(comment);
    const thread = entry?.thread;
    if (entry === undefined || thread === undefined) {
      return;
    }
    const text = textOf(comment);
    if (text.trim() === '') {
      vscode.window.showWarningMessage('The draft is empty: write it or discard it.');
      return;
    }
    this.drafts.delete(comment);
    const gathered = this.gather(thread, text);
    // What the draft knew about its line — the anchor it was written at,
    // and whether that line has changed — moves onto the gathered comment.
    if (gathered !== undefined) {
      if (entry.saved.kind === 'line' && entry.saved.text !== undefined) {
        this.anchors.set(gathered, entry.saved.text);
      }
      if (entry.changed === true) this.changedLines.add(gathered);
    }
    this.save();
  }

  /** Discards a draft, thread and all; it never joined the pending review. */
  discardDraft(comment: vscode.Comment): void {
    const thread = this.drafts.get(comment)?.thread;
    if (thread === undefined) return;
    this.drafts.delete(comment);
    this.ids.delete(thread);
    thread.dispose();
    this.save();
    this.changed.fire();
  }

  /** Discards one thread of the pending review, gathered comment and all. */
  discard(thread: vscode.CommentThread): void {
    if (this.sending) {
      this.refuseWhileSending();
      return;
    }
    const gathered = this.threads.delete(thread);
    this.ids.delete(thread);
    thread.dispose();
    if (gathered) {
      this.save();
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
      this.refuseWhileSending();
      return false;
    }
    for (const [thread, gathered] of this.threads) {
      if (gathered !== comment) continue;
      comment.body = body;
      thread.comments = [shownComment(body, this.changedLines.has(comment))];
      this.save();
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
      this.refuseWhileSending();
      return false;
    }
    for (const [thread, gathered] of this.threads) {
      if (gathered !== comment) continue;
      this.discard(thread);
      return true;
    }
    return false;
  }

  /**
   * Empties the pending review, its comments and threads gone — the send
   * succeeded — and clears what was saved for the pull request with them.
   */
  clear(): void {
    for (const thread of this.threads.keys()) {
      thread.dispose();
      this.ids.delete(thread);
    }
    this.threads.clear();
    const result = this.result;
    if (result !== undefined && this.store !== undefined) {
      const saved = this.emptySave();
      const json = JSON.stringify(saved);
      this.lastSaved = json;
      this.write(this.store, result.pullRequest.url, saved, json);
    }
    this.changed.fire();
  }

  /** The record of nothing unsent, at the head commit the review is at. */
  private emptySave(): SavedComments {
    return {
      version: 1,
      head: this.result?.copies.head.commit ?? '',
      comments: [],
      drafts: [],
    };
  }

  /**
   * Saves the pending review's comments and the open drafts per pull
   * request, as they change (issue 168): each comment with where it
   * points and the line's text as the diff shows it, each draft with its
   * text as last seen, all against the head commit the review is at.
   * Nothing unsent writes nothing, and a save that changes nothing on
   * disk writes nothing either.
   */
  private save(): void {
    const result = this.result;
    if (result === undefined || this.store === undefined) return;
    const comments: SavedComment[] = [...this.threads.values()].map((comment): SavedComment =>
      comment.kind === 'part'
        ? { kind: 'part', path: comment.path, body: comment.body }
        : {
            kind: 'line',
            path: comment.path,
            side: comment.side,
            line: comment.line,
            body: comment.body,
            ...(this.anchors.has(comment) ? { text: this.anchors.get(comment)! } : {}),
          },
    );
    const drafts: SavedDraft[] = [...this.drafts.entries()].map(([comment, entry]): SavedDraft => ({
      ...entry.saved,
      body: textOf(comment),
    }));
    const saved: SavedComments = { version: 1, head: result.copies.head.commit, comments, drafts };
    const json = JSON.stringify(saved);
    if (json === this.lastSaved) return;
    this.lastSaved = json;
    this.write(this.store, result.pullRequest.url, saved, json);
  }

  /**
   * Writes one record of what is unsent to the pull request's store. A
   * write that fails warns, as a read that fails does, and what it held
   * is left to save again rather than taken as saved.
   */
  private write(store: CommentStore, url: string, saved: SavedComments, json: string): void {
    void store.save(url, saved).catch((error) => {
      if (this.lastSaved === json) this.lastSaved = '';
      vscode.window.showWarningMessage(
        `The unsent comments could not be saved: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  }

  dispose(): void {
    // The drafts' latest text is edited in their threads, which tell
    // nothing, so the save here is the last place it reaches the store.
    if (this.threads.size > 0 || this.drafts.size > 0) this.save();
    this.result = undefined;
    this.threads.clear();
    this.drafts.clear();
    this.changed.dispose();
    this.controller.dispose();
  }
}
