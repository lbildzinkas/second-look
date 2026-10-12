import { beforeEach, describe, expect, it } from 'vitest';
import type * as vscode from 'vscode';
import { mkdtempSync, readdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Comment, Part, ReviewResult } from '@second-look/engine';
import { changeUri } from '../src/change-copies.js';
import { CommentStore, type SavedComments } from '../src/comment-store.js';
import { activate } from '../src/extension.js';
import { ADD_COMMENT_COMMAND, REVIEW_COMMAND } from '../src/commands.js';
import {
  commentTargetOf,
  commentableRanges,
  draftTarget,
  ReviewComments,
} from '../src/comments.js';
import { pendingReviewSection } from '../src/tree.js';
import { judgedResult, mappedCriteriaResult, mixedResult, part, unexplainedResult } from './results.js';
import { CommentMode, Range, Uri, stub, stubContext, type StubCommentThread } from './vscode-stub.js';

/** The head and base document URIs of one file of the mixed result. */
function docs(result: ReviewResult, path: string, previousPath?: string): { head: Uri; base: Uri } {
  return {
    head: changeUri('head', result.copies.head.commit, path),
    base: changeUri('base', result.copies.base.commit, previousPath ?? path),
  };
}

/** A thread the way the editor creates one on a line of the diff. */
function threadOn(uri: Uri, line: number): StubCommentThread {
  return stub.commentControllers[0]!.createCommentThread(uri, new Range(line, 0, line, 0), []);
}

/** A reply the way the editor hands one to the add-comment command. */
function replyOf(thread: StubCommentThread, text: string): vscode.CommentReply {
  return { thread: thread as unknown as vscode.CommentThread, text };
}

describe('commentTargetOf', () => {
  it('resolves each side of a file to the file and its side', () => {
    const result = mixedResult();
    const { head, base } = docs(result, 'src/retry.py');

    expect(commentTargetOf(result, head)).toEqual({
      path: 'src/retry.py',
      side: 'head',
      sidePath: 'src/retry.py',
    });
    expect(commentTargetOf(result, base)).toEqual({
      path: 'src/retry.py',
      side: 'base',
      sidePath: 'src/retry.py',
    });
  });

  it('resolves a renamed file by its new-side path, on both sides', () => {
    const result = mixedResult();
    result.parts.push(
      part('src/new-name.ts', {
        changeKind: 'rename',
        previousPath: 'src/old-name.ts',
        hunks: [
          {
            oldStart: 2,
            oldLines: 1,
            newStart: 2,
            newLines: 1,
            lines: [
              { kind: 'deletion', oldLineNumber: 2, text: 'old' },
              { kind: 'addition', newLineNumber: 2, text: 'new' },
            ],
            entities: [],
          },
        ],
      }),
    );
    const { head, base } = docs(result, 'src/new-name.ts', 'src/old-name.ts');

    // Whichever side the reviewer writes on, the comment travels to
    // GitHub under the path after the rename.
    expect(commentTargetOf(result, head)).toEqual({
      path: 'src/new-name.ts',
      side: 'head',
      sidePath: 'src/new-name.ts',
    });
    // The base side shows the old path, but the comment still travels to
    // GitHub under the new one.
    expect(commentTargetOf(result, base)).toEqual({
      path: 'src/new-name.ts',
      side: 'base',
      sidePath: 'src/old-name.ts',
    });
  });

  it('resolves nothing for the empty side, another scheme, or an unknown file', () => {
    const result = mixedResult();
    result.parts.push(part('added.ts', { changeKind: 'addition' }));
    const empty = Uri.from({ scheme: 'second-look-change', authority: 'empty', path: '/added.ts' });

    expect(commentTargetOf(result, empty)).toBeUndefined();
    expect(commentTargetOf(result, Uri.file('/workspace/src/retry.py'))).toBeUndefined();
    expect(commentTargetOf(result, changeUri('head', 'other0000000000000000000000000000000', 'src/retry.py'))).toBeUndefined();
  });
});

describe('commentableRanges', () => {
  it('offers the spans the file\'s hunks cover, per side', () => {
    const result = mixedResult();

    // The retry hunk spans head lines 3 to 13 and base lines 3 to 8.
    expect(
      commentableRanges({ path: 'src/retry.py', side: 'head', sidePath: 'src/retry.py' }, result),
    ).toEqual([new Range(2, 0, 12, Number.MAX_SAFE_INTEGER)]);
    expect(
      commentableRanges({ path: 'src/retry.py', side: 'base', sidePath: 'src/retry.py' }, result),
    ).toEqual([new Range(2, 0, 7, Number.MAX_SAFE_INTEGER)]);
  });

  it('offers no lines where the diff shows none', () => {
    const result = mixedResult();

    // No hunks: a pure rename, and a file the diff only ranks.
    expect(
      commentableRanges({ path: 'transport.py', side: 'head', sidePath: 'transport.py' }, result),
    ).toEqual([]);
    expect(
      commentableRanges(
        { path: 'src/settings.ts', side: 'base', sidePath: 'src/settings.ts' },
        result,
      ),
    ).toEqual([]);
  });
});

describe('pendingReviewSection', () => {
  it('lists every comment with where it points', () => {
    const comments: Comment[] = [
      { kind: 'line', path: 'src/retry.py', side: 'head', line: 5, body: 'needs a cap\nsecond line' },
      { kind: 'part', path: 'uv.lock', body: 'the lockfile follows the manifest' },
    ];

    expect(pendingReviewSection(comments)).toEqual({
      label: 'Pending review',
      tooltip: 'The comments you wrote, sent to GitHub as one review on submit.',
      parts: [
        {
          label: 'src/retry.py:5',
          description: 'needs a cap',
          tooltip: 'needs a cap\nsecond line',
          kind: 'comment',
        },
        {
          label: 'uv.lock (part)',
          description: 'the lockfile follows the manifest',
          tooltip: 'the lockfile follows the manifest',
          kind: 'comment',
        },
      ],
    });
  });

  it('cuts a long first line short for the row', () => {
    const section = pendingReviewSection([
      { kind: 'part', path: 'a.ts', body: 'x'.repeat(80) },
    ]);

    expect(section.parts[0]!.description).toBe(`${'x'.repeat(57)}…`);
  });
});

describe('ReviewComments', () => {
  beforeEach(() => {
    stub.reset();
  });

  it('offers threads wherever the review\'s hunks sit, and nowhere else', () => {
    const result = mixedResult();
    const comments = new ReviewComments();
    comments.setReview(result);
    const { head } = docs(result, 'src/retry.py');
    const provider = stub.commentControllers[0]!.commentingRangeProvider!;

    expect(provider.provideCommentingRanges({ uri: head })).toEqual({
      enableFileComments: true,
      ranges: [new Range(2, 0, 12, Number.MAX_SAFE_INTEGER)],
    });
    expect(
      provider.provideCommentingRanges({ uri: Uri.file('/workspace/src/retry.py') }),
    ).toBeUndefined();
  });

  it('gathers a comment written on a line of the diff', () => {
    const result = mixedResult();
    const comments = new ReviewComments();
    comments.setReview(result);
    const { head, base } = docs(result, 'src/retry.py');
    const onAdded = threadOn(head, 4);
    const onDeleted = threadOn(base, 4);

    comments.add(replyOf(onAdded, 'this retry loop needs a cap'));
    comments.add(replyOf(onDeleted, 'keep raising here'));

    expect(comments.pending()).toEqual([
      { kind: 'line', path: 'src/retry.py', side: 'head', line: 5, body: 'this retry loop needs a cap' },
      { kind: 'line', path: 'src/retry.py', side: 'base', line: 5, body: 'keep raising here' },
    ]);
    expect(onAdded.comments[0]).toMatchObject({
      body: 'this retry loop needs a cap',
      label: 'pending',
    });
    expect(onAdded.label).toBe('src/retry.py:5');
    expect(onAdded.contextValue).toBe('second-look-pending');
    expect(onAdded.canReply).toBe(false);
  });

  it('starts a comment on a whole part, at no line, and gathers it', () => {
    const result = mixedResult();
    const comments = new ReviewComments();
    comments.setReview(result);
    const wholePart: Part = result.parts[0]!;

    comments.commentOnPart(wholePart);

    const thread = stub.commentControllers[0]!.threads[0]!;
    expect(thread.range).toBeUndefined();
    expect(thread.label).toBe('src/retry.py (part)');

    comments.add(replyOf(thread, 'the whole part reads well'));

    expect(comments.pending()).toEqual([
      { kind: 'part', path: 'src/retry.py', body: 'the whole part reads well' },
    ]);
    expect(thread.label).toBe('src/retry.py (part)');
  });

  it('discards one pending comment with its thread, and reports changes', () => {
    const result = mixedResult();
    const comments = new ReviewComments();
    const changes: number[] = [];
    comments.onDidChange(() => changes.push(comments.pending().length));
    comments.setReview(result);
    const thread = threadOn(docs(result, 'src/retry.py').head, 4);
    comments.add(replyOf(thread, 'gone soon'));
    const other = threadOn(docs(result, 'src/retry.py').head, 6);
    comments.add(replyOf(other, 'stays'));

    comments.discard(thread as unknown as vscode.CommentThread);

    expect(comments.pending()).toEqual([
      { kind: 'line', path: 'src/retry.py', side: 'head', line: 7, body: 'stays' },
    ]);
    expect(stub.commentControllers[0]!.threads).not.toContain(thread);
    expect(changes).toEqual([0, 1, 2, 1]);
  });

  it('discards a part-comment thread before any comment is written in it', () => {
    const result = mixedResult();
    const comments = new ReviewComments();
    const changes: number[] = [];
    comments.onDidChange(() => changes.push(comments.pending().length));
    comments.setReview(result);
    comments.commentOnPart(result.parts[0]!);
    const thread = stub.commentControllers[0]!.threads[0]!;

    comments.discard(thread as unknown as vscode.CommentThread);

    expect(comments.pending()).toEqual([]);
    expect(stub.commentControllers[0]!.threads).not.toContain(thread);
    expect(changes).toEqual([0]);
  });

  it('drops a thread written where no comment can go', () => {
    const result = mixedResult();
    const comments = new ReviewComments();
    comments.setReview(result);
    const outside = threadOn(Uri.file('/workspace/src/retry.py'), 0);

    comments.add(replyOf(outside, 'not this file'));

    expect(comments.pending()).toEqual([]);
    expect(stub.commentControllers[0]!.threads).not.toContain(outside);
  });

  it('rewrites one gathered comment, as the Send review page edits it', () => {
    const result = mixedResult();
    const comments = new ReviewComments();
    comments.setReview(result);
    const thread = threadOn(docs(result, 'src/retry.py').head, 4);
    comments.add(replyOf(thread, 'first take'));
    const gathered = comments.pending()[0]!;

    expect(comments.editBody(gathered, 'tightened on the page')).toBe(true);

    // The comment object itself is rewritten, so a hold on it stays valid.
    expect(comments.pending()).toEqual([
      { kind: 'line', path: 'src/retry.py', side: 'head', line: 5, body: 'tightened on the page' },
    ]);
    expect(gathered.body).toBe('tightened on the page');
    expect(thread.comments[0]).toMatchObject({ body: 'tightened on the page' });
  });

  it('drops one gathered comment by the comment, as the Send review page discards it', () => {
    const result = mixedResult();
    const comments = new ReviewComments();
    comments.setReview(result);
    const thread = threadOn(docs(result, 'src/retry.py').head, 4);
    comments.add(replyOf(thread, 'gone from the page'));
    const gathered = comments.pending()[0]!;

    expect(comments.remove(gathered)).toBe(true);

    expect(comments.pending()).toEqual([]);
    expect(stub.commentControllers[0]!.threads).not.toContain(thread);
  });

  it('seals the gathering while its review is being written', async () => {
    const result = mixedResult();
    const comments = new ReviewComments();
    comments.setReview(result);
    const thread = threadOn(docs(result, 'src/retry.py').head, 4);
    comments.add(replyOf(thread, 'sent as pressed'));
    const gathered = comments.pending()[0]!;
    const late = threadOn(docs(result, 'src/retry.py').head, 6);
    const changes: number[] = [];
    comments.onDidChange(() => changes.push(comments.pending().length));
    let release: () => void = () => undefined;
    const written = comments.sendWhileSealed(
      () => new Promise<void>((resolve) => {
        release = resolve;
      }),
    );

    comments.add(replyOf(late, 'written while the send ran'));
    comments.discard(thread as unknown as vscode.CommentThread);
    expect(comments.editBody(gathered, 'blanked while the send ran')).toBe(false);
    expect(comments.remove(gathered)).toBe(false);
    comments.commentOnPart(result.parts[0]!);
    const refused = 'The review is being sent: try again once it finishes.';

    expect(stub.warningMessages).toEqual([refused, refused, refused, refused, refused]);
    expect(comments.pending()).toEqual([
      { kind: 'line', path: 'src/retry.py', side: 'head', line: 5, body: 'sent as pressed' },
    ]);
    expect(stub.commentControllers[0]!.threads).toHaveLength(2);
    expect(stub.commentControllers[0]!.threads).toContain(late);
    expect(changes).toEqual([]);

    release();
    await written;

    comments.add(replyOf(late, 'written once the send was done'));
    expect(comments.pending()).toHaveLength(2);
    expect(changes).toEqual([2]);
    expect(stub.warningMessages).toHaveLength(5);
  });

  it('reports a comment no longer gathered as unknown to edit and drop', () => {
    const result = mixedResult();
    const comments = new ReviewComments();
    comments.setReview(result);
    const stray: Comment = { kind: 'part', path: 'elsewhere.ts', body: 'never gathered' };

    expect(comments.editBody(stray, 'edited')).toBe(false);
    expect(comments.remove(stray)).toBe(false);
  });

  it('empties on a new review and on clear, disposing the threads', () => {
    const result = mixedResult();
    const comments = new ReviewComments();
    comments.setReview(result);
    const thread = threadOn(docs(result, 'src/retry.py').head, 4);
    comments.add(replyOf(thread, 'from the earlier review'));

    comments.setReview(mixedResult());

    expect(comments.pending()).toEqual([]);
    expect(stub.commentControllers[0]!.threads).not.toContain(thread);
  });
});

describe('draftTarget', () => {
  it('writes a claim\'s draft on the line its finding sits on, when the diff shows it on the head side', () => {
    const result = judgedResult();

    expect(draftTarget(result, { kind: 'claim', index: 1 })).toEqual({ kind: 'line', path: 'src/retry.py', line: 3 });
    expect(draftTarget(result, { kind: 'claim', index: 2 })).toEqual({ kind: 'line', path: 'src/retry.py', line: 9 });
  });

  it('writes it on the claim\'s part when its line is outside the diff, or it has none', () => {
    const result = judgedResult();
    const claims = result.claims!.claims;
    claims[1] = { ...claims[1]!, location: { kind: 'description', line: 1 }, verdict: { ...(claims[1]!.verdict as object), evidence: [{ path: 'src/retry.py', line: 40, quote: 'x' }] } as never };

    expect(draftTarget(result, { kind: 'claim', index: 1 })).toEqual({ kind: 'part', part: result.parts[0] });
    // The story's claim cites nothing: its draft goes on its part, the settings.
    expect(draftTarget(result, { kind: 'claim', index: 3 })).toEqual({ kind: 'part', part: result.parts[1] });
  });

  it('writes an unexplained part\'s draft on that part, and gives a finding on the whole pull request no place in the diff', () => {
    const result = unexplainedResult();

    expect(draftTarget(result, { kind: 'unexplained part', index: 0 })).toEqual({ kind: 'part', part: result.parts[1] });
    expect(draftTarget(result, { kind: 'described change', index: 0 })).toBeUndefined();
    expect(draftTarget(mappedCriteriaResult(), { kind: 'criterion', index: 1 })).toBeUndefined();
    expect(draftTarget(result, { kind: 'unexplained part', index: 5 })).toBeUndefined();
  });
});

describe('ReviewComments drafts', () => {
  beforeEach(() => {
    stub.reset();
  });

  /** The draft comment a thread shows, as the editor hands it to the add and discard commands. */
  function draftIn(thread: StubCommentThread): vscode.Comment {
    return thread.comments[0] as unknown as vscode.Comment;
  }

  it('opens a draft on its line, editable, outside the pending review', () => {
    const comments = new ReviewComments();
    comments.setReview(judgedResult());

    comments.draft({ kind: 'line', path: 'src/retry.py', line: 3 }, 'The loop runs five times, see `src/retry.py:6`.', 'refuted claim');

    const thread = stub.commentControllers[0]!.threads[0]!;
    expect(thread.range).toEqual(new Range(2, 0, 2, 0));
    expect(thread.uri.toString()).toBe(docs(judgedResult(), 'src/retry.py').head.toString());
    expect(thread.comments[0]).toMatchObject({
      body: 'The loop runs five times, see `src/retry.py:6`.',
      mode: CommentMode.Editing,
      label: 'draft from refuted claim',
      contextValue: 'second-look-draft',
    });
    expect(thread.label).toBe('Draft comment · src/retry.py:3');
    expect(thread.canReply).toBe(false);
    expect(comments.pending()).toEqual([]);
  });

  it('adds the draft as the reviewer edited it to the pending review, as a line comment', () => {
    const comments = new ReviewComments();
    comments.setReview(judgedResult());
    let changes = 0;
    comments.onDidChange(() => changes++);
    comments.draft({ kind: 'line', path: 'src/retry.py', line: 3 }, 'draft text', 'refuted claim');
    const thread = stub.commentControllers[0]!.threads[0]!;
    const draft = draftIn(thread);

    // The editor writes the reviewer's edit into the comment it hands the command.
    draft.body = 'The docstring says three attempts; the loop runs five.';
    comments.addDraft(draft);

    expect(comments.pending()).toEqual([
      { kind: 'line', path: 'src/retry.py', side: 'head', line: 3, body: 'The docstring says three attempts; the loop runs five.' },
    ]);
    expect(thread.comments[0]).toMatchObject({ label: 'pending', mode: CommentMode.Preview });
    expect(thread.contextValue).toBe('second-look-pending');
    expect(thread.label).toBe('src/retry.py:3');
    // Once as the draft opened, once as it joined the pending review.
    expect(changes).toBe(2);
    // Added once: pressing add again adds nothing more.
    comments.addDraft(draft);
    expect(comments.pending()).toHaveLength(1);
  });

  it('adds a draft on a part as a comment on the whole part', () => {
    const result = unexplainedResult();
    const comments = new ReviewComments();
    comments.setReview(result);

    comments.draft({ kind: 'part', part: result.parts[1]! }, 'Why does the timeout change here?', 'unexplained change');
    const thread = stub.commentControllers[0]!.threads[0]!;
    expect(thread.range).toBeUndefined();
    expect(thread.label).toBe('Draft comment · src/settings.ts (part)');
    comments.addDraft(draftIn(thread));

    expect(comments.pending()).toEqual([{ kind: 'part', path: 'src/settings.ts', body: 'Why does the timeout change here?' }]);
  });

  it('refuses to add an emptied draft, keeping it open, and discards a draft with no trace', () => {
    const comments = new ReviewComments();
    comments.setReview(judgedResult());
    comments.draft({ kind: 'line', path: 'src/retry.py', line: 9 }, 'draft', 'unverifiable claim');
    const thread = stub.commentControllers[0]!.threads[0]!;
    const draft = draftIn(thread);

    draft.body = '   ';
    comments.addDraft(draft);
    expect(stub.warningMessages).toEqual(['The draft is empty: write it or discard it.']);
    expect(stub.commentControllers[0]!.threads).toContain(thread);

    comments.discardDraft(draft);
    expect(stub.commentControllers[0]!.threads).not.toContain(thread);
    expect(comments.pending()).toEqual([]);
  });

  it('refuses a draft while the review is being sent, and drops open drafts on a new review', async () => {
    const comments = new ReviewComments();
    comments.setReview(judgedResult());
    comments.draft({ kind: 'line', path: 'src/retry.py', line: 9 }, 'open draft', 'unverifiable claim');
    const open = stub.commentControllers[0]!.threads[0]!;

    await comments.sendWhileSealed(async () => {
      comments.draft({ kind: 'line', path: 'src/retry.py', line: 3 }, 'late draft', 'refuted claim');
      comments.addDraft(draftIn(open));
    });
    expect(stub.warningMessages).toEqual(['The review is being sent: try again once it finishes.', 'The review is being sent: try again once it finishes.']);
    expect(stub.commentControllers[0]!.threads).toEqual([open]);
    expect(comments.pending()).toEqual([]);

    comments.setReview(mixedResult());
    expect(stub.commentControllers[0]!.threads).toEqual([]);
  });
});

describe('ReviewComments as step 7 lists them', () => {
  beforeEach(() => {
    stub.reset();
  });

  it('lists the pending comments, then the open drafts, each with an id that stays while it does', () => {
    const result = judgedResult();
    const comments = new ReviewComments();
    comments.setReview(result);
    let changes = 0;
    comments.onDidChange(() => changes++);
    comments.add(replyOf(threadOn(docs(result, 'src/retry.py').head, 4), 'this retry loop needs a cap'));
    comments.draft({ kind: 'line', path: 'src/retry.py', line: 3 }, 'The docstring says three attempts.', 'refuted claim');

    const listed = comments.listed();
    expect(listed).toEqual([
      { id: listed[0]!.id, kind: 'comment', location: 'src/retry.py:5', body: 'this retry loop needs a cap' },
      { id: listed[1]!.id, kind: 'draft', location: 'src/retry.py:3', body: 'The docstring says three attempts.', from: 'refuted claim' },
    ]);
    expect(listed[0]!.id).not.toBe(listed[1]!.id);
    // The draft opening tells the side bar, as the comment joining did.
    expect(changes).toBe(2);

    // Added, the draft keeps its id and joins the pending comments.
    comments.act(listed[1]!.id, 'add');
    expect(comments.listed()).toEqual([
      { id: listed[0]!.id, kind: 'comment', location: 'src/retry.py:5', body: 'this retry loop needs a cap' },
      { id: listed[1]!.id, kind: 'comment', location: 'src/retry.py:3', body: 'The docstring says three attempts.' },
    ]);
  });

  it('discards a comment or a draft by its id, thread and all, and does nothing for an id gone', () => {
    const result = judgedResult();
    const comments = new ReviewComments();
    comments.setReview(result);
    const written = threadOn(docs(result, 'src/retry.py').head, 4);
    comments.add(replyOf(written, 'a cap, please'));
    comments.draft({ kind: 'line', path: 'src/retry.py', line: 3 }, 'drafted', 'refuted claim');
    const [comment, draft] = comments.listed();

    comments.act(draft!.id, 'discard');
    expect(comments.listed().map((each) => each.id)).toEqual([comment!.id]);
    expect(stub.commentControllers[0]!.threads).toEqual([written]);
    // Add means nothing for a comment already gathered.
    comments.act(comment!.id, 'add');
    expect(comments.pending()).toHaveLength(1);
    comments.act(comment!.id, 'discard');
    expect(comments.listed()).toEqual([]);
    expect(stub.commentControllers[0]!.threads).toEqual([]);
    comments.act(comment!.id, 'discard');
    expect(comments.reveal(comment!.id)).toBeUndefined();
  });

  it('reveals a listed comment\'s thread, expanded, and refuses a step 7 press while the review is being sent', async () => {
    const result = judgedResult();
    const comments = new ReviewComments();
    comments.setReview(result);
    const written = threadOn(docs(result, 'src/retry.py').head, 4);
    comments.add(replyOf(written, 'a cap, please'));
    written.collapsibleState = 0;
    const [comment] = comments.listed();

    expect(comments.reveal(comment!.id)).toBe(written);
    expect(written.collapsibleState).toBe(1);

    await comments.sendWhileSealed(async () => {
      comments.act(comment!.id, 'discard');
    });
    expect(stub.warningMessages).toEqual(['The review is being sent: try again once it finishes.']);
    expect(comments.pending()).toHaveLength(1);
  });
});

describe('ReviewComments kept between visits', () => {
  beforeEach(() => {
    stub.reset();
  });

  /** A store in its own folder, as the extension's global storage holds one. */
  function store(): CommentStore {
    return new CommentStore(mkdtempSync(join(tmpdir(), 'second-look-comments-')));
  }

  /** Awaits the store's record for a pull request, polling for the asynchronous write to land — until it matches, when told what to wait for. */
  async function whenSaved(wanted: CommentStore, url: string, matches: (saved: SavedComments) => boolean = () => true): Promise<SavedComments> {
    const deadline = Date.now() + 5_000;
    for (;;) {
      const saved = await wanted.read(url);
      if (saved !== undefined && matches(saved)) return saved;
      if (Date.now() > deadline) throw new Error('timed out waiting for the saved comments');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  /** Awaits the store holding nothing for a pull request, polling for the removal to land. */
  async function whenCleared(wanted: CommentStore, url: string): Promise<void> {
    const deadline = Date.now() + 5_000;
    while ((await wanted.read(url)) !== undefined) {
      if (Date.now() > deadline) throw new Error('timed out waiting for the saved comments to clear');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  const URL = 'https://github.com/example-org/example-repo/pull/42';

  /** What a full record holds once the two comments and the draft are saved. */
  const allUnsent = (each: SavedComments): boolean => each.comments.length === 2 && each.drafts.length === 1;

  /** The mixed result after new commits landed: a new head, with line 5 and line 9 rewritten and line 3 untouched. */
  function newCommitsResult(): ReviewResult {
    const result = mixedResult();
    result.copies = {
      base: { ...result.copies.base, commit: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
      head: { ...result.copies.head, commit: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' },
    };
    for (const line of result.parts[0]!.hunks[0]!.lines) {
      if (line.newLineNumber === 5) line.text = '    for attempt in retry.attempts(cap=5):';
      if (line.newLineNumber === 9) line.text = '            break';
    }
    return result;
  }

  /** Writes two comments — on the head’s line 5 and line 3 — and leaves one draft open, on line 9. */
  function writeUnsent(comments: ReviewComments, result: ReviewResult): void {
    comments.setReview(result);
    const { head } = docs(result, 'src/retry.py');
    comments.add(replyOf(threadOn(head, 4), 'this retry loop needs a cap'));
    comments.add(replyOf(threadOn(head, 2), 'the url never moves'));
    comments.draft({ kind: 'line', path: 'src/retry.py', line: 9 }, 'drafted', 'refuted claim');
  }

  it('saves the pending comments and open drafts as they change, with the lines they point at', async () => {
    const saved = store();
    const comments = new ReviewComments(saved);
    writeUnsent(comments, mixedResult());

    expect(await whenSaved(saved, URL, allUnsent)).toEqual({
      version: 1,
      head: 'f00dcafe1234567890abcdef1234567890abcdef12',
      comments: [
        { kind: 'line', path: 'src/retry.py', side: 'head', line: 5, body: 'this retry loop needs a cap', text: '    for attempt in retry.attempts():' },
        { kind: 'line', path: 'src/retry.py', side: 'head', line: 3, body: 'the url never moves', text: '    url = settings.endpoint' },
      ],
      drafts: [{ kind: 'line', path: 'src/retry.py', line: 9, body: 'drafted', from: 'refuted claim', text: '            continue' }],
    });
  });

  it('saves a draft’s text as the reviewer edited it, and a comment’s as the page rewrote it', async () => {
    const saved = store();
    const comments = new ReviewComments(saved);
    writeUnsent(comments, mixedResult());
    comments.editBody(comments.pending()[0]!, 'tightened on the page');
    const draft = stub.commentControllers[0]!.threads.at(-1)!.comments[0] as unknown as vscode.Comment;
    draft.body = 'edited in the thread';
    // The draft's edit reaches the store through the render that lists it.
    comments.listed();

    const record = await whenSaved(saved, URL, (each) => each.drafts[0]?.body === 'edited in the thread');
    expect(record.comments[0]!.body).toBe('tightened on the page');
    expect(record.drafts[0]!.body).toBe('edited in the thread');
  });

  it('brings the comments and drafts back, with their threads, when the review opens again', async () => {
    const saved = store();
    writeUnsent(new ReviewComments(saved), mixedResult());
    await whenSaved(saved, URL, allUnsent);

    // The editor closed and opened again: a fresh companion on the same store.
    stub.reset();
    const again = new ReviewComments(saved);
    again.setReview(mixedResult());
    await again.restore();

    expect(again.pending()).toEqual([
      { kind: 'line', path: 'src/retry.py', side: 'head', line: 5, body: 'this retry loop needs a cap' },
      { kind: 'line', path: 'src/retry.py', side: 'head', line: 3, body: 'the url never moves' },
    ]);
    expect(again.listed().map(({ kind, location, changed }) => ({ kind, location, changed }))).toEqual([
      { kind: 'comment', location: 'src/retry.py:5', changed: undefined },
      { kind: 'comment', location: 'src/retry.py:3', changed: undefined },
      { kind: 'draft', location: 'src/retry.py:9', changed: undefined },
    ]);
    const [line, , draftThread] = stub.commentControllers[0]!.threads;
    const result = mixedResult();
    expect(line!.uri.toString()).toBe(docs(result, 'src/retry.py').head.toString());
    expect(line!.range).toEqual(new Range(4, 0, 4, 0));
    expect(line!.label).toBe('src/retry.py:5');
    expect(line!.comments[0]).toMatchObject({ body: 'this retry loop needs a cap', label: 'pending' });
    expect(draftThread!.label).toBe('Draft comment · src/retry.py:9');
    expect(draftThread!.comments[0]).toMatchObject({ mode: CommentMode.Editing, label: 'draft from refuted claim' });
    // Restoring twice adds nothing: each review restores once.
    await again.restore();
    expect(again.pending()).toHaveLength(2);
  });

  it('keeps every comment after new commits and flags the ones whose line changed, not the others', async () => {
    const saved = store();
    writeUnsent(new ReviewComments(saved), mixedResult());
    await whenSaved(saved, URL, allUnsent);

    stub.reset();
    const again = new ReviewComments(saved);
    const moved = newCommitsResult();
    again.setReview(moved);
    await again.restore();

    // None is lost: both comments and the draft are back.
    expect(again.pending()).toEqual([
      { kind: 'line', path: 'src/retry.py', side: 'head', line: 5, body: 'this retry loop needs a cap' },
      { kind: 'line', path: 'src/retry.py', side: 'head', line: 3, body: 'the url never moves' },
    ]);
    expect(again.listed().map(({ location, changed }) => ({ location, changed }))).toEqual([
      { location: 'src/retry.py:5', changed: true },
      { location: 'src/retry.py:3', changed: undefined },
      { location: 'src/retry.py:9', changed: true },
    ]);
    const [changedThread, unchangedThread, draftThread] = stub.commentControllers[0]!.threads;
    expect(changedThread!.uri.toString()).toBe(docs(moved, 'src/retry.py').head.toString());
    expect(changedThread!.label).toBe('src/retry.py:5 · line changed');
    expect(changedThread!.comments[0]).toMatchObject({ label: 'pending · line changed' });
    expect(unchangedThread!.label).toBe('src/retry.py:3');
    expect(draftThread!.label).toBe('Draft comment · src/retry.py:9 · line changed');

    // The flag survives another visit at the same new head, and the untouched line stays quiet.
    again.listed();
    stub.reset();
    const third = new ReviewComments(saved);
    third.setReview(newCommitsResult());
    await third.restore();
    expect(third.listed().map(({ location, changed }) => ({ location, changed }))).toEqual([
      { location: 'src/retry.py:5', changed: true },
      { location: 'src/retry.py:3', changed: undefined },
      { location: 'src/retry.py:9', changed: true },
    ]);
  });

  it('carries a flagged draft’s line onto the comment it becomes', async () => {
    const saved = store();
    writeUnsent(new ReviewComments(saved), mixedResult());
    await whenSaved(saved, URL, allUnsent);

    stub.reset();
    const again = new ReviewComments(saved);
    again.setReview(newCommitsResult());
    await again.restore();
    const draft = stub.commentControllers[0]!.threads.at(-1)!.comments[0] as unknown as vscode.Comment;

    again.addDraft(draft);

    expect(again.pending().at(-1)).toMatchObject({ kind: 'line', path: 'src/retry.py', line: 9, body: 'drafted' });
    expect(again.listed().at(-1)).toMatchObject({ kind: 'comment', location: 'src/retry.py:9', changed: true });
  });

  it('does not clear the store when the review it switches to shows nothing unsent yet', async () => {
    const saved = store();
    writeUnsent(new ReviewComments(saved), mixedResult());
    await whenSaved(saved, URL, allUnsent);

    stub.reset();
    const again = new ReviewComments(saved);
    // The session renders on every change, as the side bar drives it to.
    again.onDidChange(() => again.listed());
    again.setReview(mixedResult());
    // Whatever the switch fired has landed before the restore reads.
    await new Promise((resolve) => setTimeout(resolve, 20));
    await again.restore();

    expect(again.pending()).toHaveLength(2);
    expect(again.listed()).toHaveLength(3);
  });

  it('clears what was saved when the review is sent, and restores nothing after', async () => {
    const saved = store();
    const comments = new ReviewComments(saved);
    writeUnsent(comments, mixedResult());
    await whenSaved(saved, URL);

    // The send succeeded: the gathering is emptied, as the session’s send does.
    comments.clear();
    await whenCleared(saved, URL);

    stub.reset();
    const again = new ReviewComments(saved);
    again.setReview(mixedResult());
    await again.restore();
    expect(again.pending()).toEqual([]);
    expect(again.listed()).toEqual([]);
  });

  it('keeps each pull request’s unsent comments apart', async () => {
    const saved = store();
    writeUnsent(new ReviewComments(saved), mixedResult());
    await whenSaved(saved, URL, allUnsent);

    const other = mixedResult();
    other.pullRequest = { ...other.pullRequest, url: 'https://github.com/example-org/example-repo/pull/43', number: 43 };
    stub.reset();
    const comments = new ReviewComments(saved);
    comments.setReview(other);
    await comments.restore();
    expect(comments.pending()).toEqual([]);

    // The first pull request’s comments still come back for its own review.
    stub.reset();
    const again = new ReviewComments(saved);
    again.setReview(mixedResult());
    await again.restore();
    expect(again.pending()).toHaveLength(2);
  });
});

describe('the saved comments through activation', () => {
  beforeEach(() => {
    stub.reset();
  });

  const FAKE_ENGINE = fileURLToPath(new URL('./fixtures/fake-engine.mjs', import.meta.url));
  const PR_URL = 'https://github.com/example-org/example-repo/pull/42';

  /** Activates the companion against a fake engine serving the result, and reviews the pull request once. */
  async function reviewOn(context: ReturnType<typeof stubContext>, result: ReviewResult): Promise<void> {
    activate(context as never, {
      spawnEngine: () =>
        spawn(process.execPath, [FAKE_ENGINE], {
          stdio: ['pipe', 'pipe', 'pipe'],
          env: { ...process.env, FAKE_ENGINE_RESULT: JSON.stringify(result) },
        }),
    });
    stub.inputBoxResult = PR_URL;
    stub.session = { accessToken: 'ghp_test-token-do-not-print' };
    await stub.commands.find((command) => command.id === REVIEW_COMMAND)!.handler();
  }

  it('keeps a written comment in the extension’s own storage and brings it back in a later activation', async () => {
    const context = stubContext();
    const result = mixedResult();
    await reviewOn(context, result);

    // The reviewer writes one comment, as the editor's thread hands it over.
    const head = changeUri('head', result.copies.head.commit, 'src/retry.py');
    const thread = stub.commentControllers.at(-1)!.createCommentThread(head, new Range(4, 0, 4, 0), []);
    await stub.commands.find((command) => command.id === ADD_COMMENT_COMMAND)!.handler({ thread, text: 'this retry loop needs a cap' });

    // It is saved in the extension's own global storage, one file per
    // pull request — polled, for the write lands after the command returns.
    const savedDir = join(context.globalStorageUri.fsPath, 'pending-comments');
    const savedFile = 'example-org__example-repo__pull-42.json';
    const deadline = Date.now() + 5_000;
    for (;;) {
      try {
        if (readdirSync(savedDir).includes(savedFile)) break;
      } catch {
        // Not written yet.
      }
      if (Date.now() > deadline) throw new Error('timed out waiting for the saved comments');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    // The editor closed and opened again: a fresh activation on the same
    // global storage, the same review.
    stub.reset();
    await reviewOn(context, mixedResult());

    const controller = stub.commentControllers[0]!;
    expect(controller.threads).toHaveLength(1);
    expect(controller.threads[0]).toMatchObject({ label: 'src/retry.py:5' });
    expect(controller.threads[0]!.comments[0]).toMatchObject({ body: 'this retry loop needs a cap', label: 'pending' });
  });
});
