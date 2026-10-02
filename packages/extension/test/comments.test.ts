import { beforeEach, describe, expect, it } from 'vitest';
import type * as vscode from 'vscode';
import type { Comment, Part, ReviewResult } from '@second-look/engine';
import { changeUri } from '../src/change-copies.js';
import {
  commentTargetOf,
  commentableRanges,
  ReviewComments,
} from '../src/comments.js';
import { pendingReviewSection } from '../src/tree.js';
import { mixedResult, part } from './results.js';
import { Range, Uri, stub, type StubCommentThread } from './vscode-stub.js';

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

  it('drops a thread written where no comment can go', () => {
    const result = mixedResult();
    const comments = new ReviewComments();
    comments.setReview(result);
    const outside = threadOn(Uri.file('/workspace/src/retry.py'), 0);

    comments.add(replyOf(outside, 'not this file'));

    expect(comments.pending()).toEqual([]);
    expect(stub.commentControllers[0]!.threads).not.toContain(outside);
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
