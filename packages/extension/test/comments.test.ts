import { beforeEach, describe, expect, it } from 'vitest';
import type * as vscode from 'vscode';
import type { Comment, Part, ReviewResult } from '@second-look/engine';
import { changeUri } from '../src/change-copies.js';
import {
  commentTargetOf,
  commentableRanges,
  draftTarget,
  ReviewComments,
} from '../src/comments.js';
import { pendingReviewSection } from '../src/tree.js';
import { judgedResult, mappedCriteriaResult, mixedResult, part, unexplainedResult } from './results.js';
import { CommentMode, Range, Uri, stub, type StubCommentThread } from './vscode-stub.js';

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
    expect(changes).toBe(1);
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
