import { beforeEach, describe, expect, it } from 'vitest';
import type * as vscode from 'vscode';
import type { Comment, PendingReview, ReviewResult } from '@second-look/engine';
import { changeUri } from '../src/change-copies.js';
import { ReviewComments } from '../src/comments.js';
import { SEND_REVIEW_VIEW_TYPE, SendReviewPage, type SendPageState } from '../src/send-page.js';
import { mixedResult } from './results.js';
import {
  Range,
  stub,
  type StubCommentThread,
  type StubWebviewPanel,
} from './vscode-stub.js';

/** Awaits what a submit's asynchronous send finishes, polling for it. */
async function eventually<T>(what: string, probe: () => T | undefined): Promise<T> {
  const deadline = Date.now() + 5_000;
  for (;;) {
    const found = probe();
    if (found !== undefined) {
      return found;
    }
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/**
 * The review's one write, faked the way the real one behaves: it records
 * what it was asked to send, empties the gathering of a review that went,
 * and resolves false — keeping everything — for one that failed.
 */
function recordingSend(
  comments: ReviewComments,
  options: { failWith?: string; hold?: Promise<void> } = {},
) {
  const sent: PendingReview[] = [];
  return {
    sent,
    send: async (review: PendingReview): Promise<boolean> => {
      if (options.hold !== undefined) {
        await options.hold;
      }
      if (options.failWith !== undefined) {
        stub.errorMessages.push(options.failWith);
        return false;
      }
      sent.push(review);
      comments.clear();
      return true;
    },
  };
}

/** A review with one line comment and one part comment already gathered. */
function gatheredComments(): {
  comments: ReviewComments;
  result: ReviewResult;
  line: Comment;
  whole: Comment;
  threads: StubCommentThread[];
} {
  const result = mixedResult();
  const comments = new ReviewComments();
  comments.setReview(result);
  const head = changeUri('head', result.copies.head.commit, 'src/retry.py');
  const replyOf = (thread: StubCommentThread, text: string): vscode.CommentReply => ({
    thread: thread as unknown as vscode.CommentThread,
    text,
  });

  const lineThread = stub.commentControllers[0]!.createCommentThread(
    head,
    new Range(4, 0, 4, 0),
    [],
  );
  comments.add(replyOf(lineThread, 'this retry loop needs a cap'));
  comments.commentOnPart(result.parts[0]!);
  const partThread = stub.commentControllers[0]!.threads.at(-1)!;
  comments.add(replyOf(partThread, 'the loop reads well overall'));

  return {
    comments,
    result,
    line: { kind: 'line', path: 'src/retry.py', side: 'head', line: 5, body: 'this retry loop needs a cap' },
    whole: { kind: 'part', path: 'src/retry.py', body: 'the loop reads well overall' },
    threads: [lineThread, partThread],
  };
}

/** The states the page posted to its webview, in order. */
function states(page: StubWebviewPanel): SendPageState[] {
  return page.webview.posted.filter(
    (message): message is SendPageState =>
      typeof message === 'object' && message !== null && (message as { type?: unknown }).type === 'state',
  );
}

/** A move on the page, the way its own script reports it. */
function drive(page: StubWebviewPanel, message: unknown): void {
  page.webview.receive(message);
}

describe('SendReviewPage', () => {
  beforeEach(() => {
    stub.reset();
  });

  it('opens the recorded page: every gathered comment with where it points', () => {
    const { comments } = gatheredComments();
    const page = new SendReviewPage({ comments, send: recordingSend(comments).send });
    expect(stub.webviewPanels).toHaveLength(0);

    page.open();

    const panel = stub.webviewPanels[0]!;
    expect(panel.viewType).toBe(SEND_REVIEW_VIEW_TYPE);
    expect(panel.title).toBe('Send review');
    expect(panel.webview.options).toEqual({ enableScripts: true });
    // The page is the recorded design's own HTML, scripts enabled and
    // nothing loaded but the editor's theme.
    expect(panel.webview.html).toContain('<h1>Send your review</h1>');
    expect(panel.webview.html).toContain("script-src 'nonce-");
    expect(panel.webview.html).not.toContain('http://');
    expect(states(panel)).toEqual([
      {
        type: 'state',
        drafts: [
          { id: 1, where: 'src/retry.py:5', body: 'this retry loop needs a cap' },
          { id: 2, where: 'src/retry.py (part)', body: 'the loop reads well overall' },
        ],
        body: '',
        submit: 'comment',
        sending: false,
      },
    ]);
  });

  it('posts the state again when the page reports it is ready', () => {
    const { comments } = gatheredComments();
    const page = new SendReviewPage({ comments, send: recordingSend(comments).send });
    page.open();
    const panel = stub.webviewPanels[0]!;
    expect(states(panel)).toHaveLength(1);

    drive(panel, { type: 'ready' });

    expect(states(panel)).toHaveLength(2);
    expect(states(panel)[1]).toEqual(states(panel)[0]);
  });

  it('reveals an open page instead of opening another', () => {
    const { comments } = gatheredComments();
    const page = new SendReviewPage({ comments, send: recordingSend(comments).send });
    page.open();
    page.open();

    expect(stub.webviewPanels).toHaveLength(1);
    expect(stub.webviewPanels[0]!.reveals).toBe(1);
  });

  it('edits a comment on the page, thread and gathering and all', () => {
    const { comments } = gatheredComments();
    const page = new SendReviewPage({ comments, send: recordingSend(comments).send });
    page.open();
    const panel = stub.webviewPanels[0]!;

    drive(panel, { type: 'edit', id: 1, body: 'this retry loop needs a cap — and a test' });

    expect(comments.pending()[0]).toMatchObject({
      body: 'this retry loop needs a cap — and a test',
    });
    expect(stub.commentControllers[0]!.threads[0]!.comments[0]).toMatchObject({
      body: 'this retry loop needs a cap — and a test',
    });
    expect(states(panel).at(-1)!.drafts[0]).toEqual({
      id: 1,
      where: 'src/retry.py:5',
      body: 'this retry loop needs a cap — and a test',
    });
  });

  it('drops a comment from the page, thread and all', () => {
    const { comments, threads } = gatheredComments();
    const page = new SendReviewPage({ comments, send: recordingSend(comments).send });
    page.open();
    const panel = stub.webviewPanels[0]!;

    drive(panel, { type: 'discard', id: 2 });

    expect(comments.pending()).toEqual([
      { kind: 'line', path: 'src/retry.py', side: 'head', line: 5, body: 'this retry loop needs a cap' },
    ]);
    expect(stub.commentControllers[0]!.threads).not.toContain(threads[1]);
    expect(states(panel).at(-1)!.drafts).toEqual([
      { id: 1, where: 'src/retry.py:5', body: 'this retry loop needs a cap' },
    ]);
  });

  it('ignores moves on drafts that are no longer gathered', () => {
    const { comments } = gatheredComments();
    const page = new SendReviewPage({ comments, send: recordingSend(comments).send });
    page.open();
    const panel = stub.webviewPanels[0]!;
    const before = comments.pending().length;

    drive(panel, { type: 'edit', id: 99, body: 'nowhere' });
    drive(panel, { type: 'discard', id: 99 });

    expect(comments.pending()).toHaveLength(before);
  });

  it('shows what changed outside the page: a new comment, a discarded thread', () => {
    const { comments, result } = gatheredComments();
    const page = new SendReviewPage({ comments, send: recordingSend(comments).send });
    page.open();
    const panel = stub.webviewPanels[0]!;
    const head = changeUri('head', result.copies.head.commit, 'src/retry.py');
    const added = stub.commentControllers[0]!.createCommentThread(head, new Range(6, 0, 6, 0), []);
    comments.add({ thread: added as unknown as vscode.CommentThread, text: 'written beside the page' });

    expect(states(panel).at(-1)!.drafts).toEqual([
      { id: 1, where: 'src/retry.py:5', body: 'this retry loop needs a cap' },
      { id: 2, where: 'src/retry.py (part)', body: 'the loop reads well overall' },
      { id: 3, where: 'src/retry.py:7', body: 'written beside the page' },
    ]);

    comments.discard(stub.commentControllers[0]!.threads[0] as unknown as vscode.CommentThread);

    expect(states(panel).at(-1)!.drafts).toEqual([
      { id: 2, where: 'src/retry.py (part)', body: 'the loop reads well overall' },
      { id: 3, where: 'src/retry.py:7', body: 'written beside the page' },
    ]);
  });

  it('sends nothing before the submit press, however much is written', async () => {
    const { comments } = gatheredComments();
    const recorder = recordingSend(comments);
    const page = new SendReviewPage({ comments, send: recorder.send });
    page.open();
    const panel = stub.webviewPanels[0]!;

    drive(panel, { type: 'body', body: 'One deliberate pass.' });
    drive(panel, { type: 'kind', submit: 'request changes' });
    drive(panel, { type: 'edit', id: 1, body: 'tightened on the page' });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(recorder.sent).toEqual([]);
    expect(stub.errorMessages).toEqual([]);
  });

  it('sends one review on the press, with everything the page holds, and closes', async () => {
    const { comments } = gatheredComments();
    const recorder = recordingSend(comments);
    const page = new SendReviewPage({ comments, send: recorder.send });
    page.open();
    const panel = stub.webviewPanels[0]!;
    drive(panel, { type: 'body', body: 'One deliberate pass.' });
    drive(panel, { type: 'kind', submit: 'request changes' });
    drive(panel, { type: 'edit', id: 1, body: 'tightened on the page' });

    drive(panel, { type: 'submit' });

    await eventually('the page to close with the sent review', () =>
      stub.webviewPanels.length === 0 ? true : undefined,
    );
    expect(recorder.sent).toEqual([
      {
        submit: 'request changes',
        body: 'One deliberate pass.',
        comments: [
          { kind: 'line', path: 'src/retry.py', side: 'head', line: 5, body: 'tightened on the page' },
          { kind: 'part', path: 'src/retry.py', body: 'the loop reads well overall' },
        ],
      },
    ]);
    // The press went through the sending state the page's button disables on.
    expect(states(panel).some((state) => state.sending)).toBe(true);
  });

  it('adds an accepted draft to the overall comment after what it says, and sends it only on the press', async () => {
    const { comments } = gatheredComments();
    const recorder = recordingSend(comments);
    const page = new SendReviewPage({ comments, send: recorder.send });

    // A draft added before the page opens waits in it.
    expect(page.addToOverall('The README section the issue asks for is missing.')).toBe(true);
    page.open();
    const panel = stub.webviewPanels[0]!;
    expect(states(panel).at(-1)!.body).toBe('The README section the issue asks for is missing.');

    drive(panel, { type: 'body', body: 'One deliberate pass.  ' });
    expect(page.addToOverall('Nothing logs a retry, which #30 asks for.')).toBe(true);
    expect(states(panel).at(-1)!.body).toBe('One deliberate pass.\n\nNothing logs a retry, which #30 asks for.');
    expect(recorder.sent).toEqual([]);

    drive(panel, { type: 'submit' });
    await eventually('the review to go', () => (recorder.sent.length > 0 ? true : undefined));
    expect(recorder.sent[0]!.body).toBe('One deliberate pass.\n\nNothing logs a retry, which #30 asks for.');
  });

  it('sends only once for presses while a send is under way', async () => {
    const { comments } = gatheredComments();
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const recorder = recordingSend(comments, { hold: held });
    const page = new SendReviewPage({ comments, send: recorder.send });
    page.open();
    const panel = stub.webviewPanels[0]!;

    drive(panel, { type: 'submit' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    drive(panel, { type: 'submit' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    release();
    await eventually('the held send to finish', () =>
      recorder.sent.length > 0 ? true : undefined,
    );

    expect(recorder.sent).toHaveLength(1);
  });

  it('sends the review as pressed: moves while it is under way change nothing', async () => {
    const { comments, line, whole } = gatheredComments();
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const recorder = recordingSend(comments, { hold: held });
    const page = new SendReviewPage({ comments, send: recorder.send });
    page.open();
    const panel = stub.webviewPanels[0]!;

    drive(panel, { type: 'submit' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    drive(panel, { type: 'edit', id: 1, body: '' });
    drive(panel, { type: 'discard', id: 2 });
    await new Promise((resolve) => setTimeout(resolve, 0));
    release();
    await eventually('the held send to finish', () =>
      recorder.sent.length > 0 ? true : undefined,
    );

    expect(recorder.sent).toEqual([{ submit: 'comment', comments: [line, whole] }]);
  });

  it('keeps every comment and stays open when the send fails', async () => {
    const { comments, line, whole } = gatheredComments();
    const recorder = recordingSend(comments, { failWith: 'GitHub is down' });
    const page = new SendReviewPage({ comments, send: recorder.send });
    page.open();
    const panel = stub.webviewPanels[0]!;
    drive(panel, { type: 'body', body: 'tries to send' });

    drive(panel, { type: 'submit' });

    await eventually('the failed send to settle', () =>
      states(panel).at(-1)!.sending === false ? true : undefined,
    );
    expect(recorder.sent).toEqual([]);
    expect(stub.errorMessages).toEqual(['GitHub is down']);
    expect(comments.pending()).toEqual([line, whole]);
    expect(states(panel).at(-1)!.drafts).toEqual([
      { id: 1, where: 'src/retry.py:5', body: 'this retry loop needs a cap' },
      { id: 2, where: 'src/retry.py (part)', body: 'the loop reads well overall' },
    ]);
    expect(stub.webviewPanels).toContain(panel);
  });

  it('opens again after the reviewer closed its tab, keeping what it held', () => {
    const { comments } = gatheredComments();
    const page = new SendReviewPage({ comments, send: recordingSend(comments).send });
    page.open();
    const first = stub.webviewPanels[0]!;
    drive(first, { type: 'body', body: 'half written' });
    drive(first, { type: 'kind', submit: 'approve' });

    first.dispose(); // The reviewer closes the page's tab: nothing is sent.
    expect(stub.webviewPanels).toHaveLength(0);

    page.open();
    const again = stub.webviewPanels[0]!;
    expect(again).not.toBe(first);
    expect(states(again)[0]).toEqual({
      type: 'state',
      drafts: [
        { id: 1, where: 'src/retry.py:5', body: 'this retry loop needs a cap' },
        { id: 2, where: 'src/retry.py (part)', body: 'the loop reads well overall' },
      ],
      body: 'half written',
      submit: 'approve',
      sending: false,
    });
  });

  it('opens fresh for the next review after one was sent', async () => {
    const { comments, result } = gatheredComments();
    const recorder = recordingSend(comments);
    const page = new SendReviewPage({ comments, send: recorder.send });
    page.open();
    drive(stub.webviewPanels[0]!, { type: 'body', body: 'One deliberate pass.' });
    drive(stub.webviewPanels[0]!, { type: 'kind', submit: 'request changes' });
    drive(stub.webviewPanels[0]!, { type: 'submit' });
    await eventually('the page to close with the sent review', () =>
      stub.webviewPanels.length === 0 ? true : undefined,
    );

    // The same pull request gets more comments and another review.
    const head = changeUri('head', result.copies.head.commit, 'src/retry.py');
    const thread = stub.commentControllers[0]!.createCommentThread(head, new Range(9, 0, 9, 0), []);
    comments.add({ thread: thread as unknown as vscode.CommentThread, text: 'a later comment' });
    page.open();

    expect(states(stub.webviewPanels[0]!)[0]).toEqual({
      type: 'state',
      drafts: [{ id: 3, where: 'src/retry.py:10', body: 'a later comment' }],
      body: '',
      submit: 'comment',
      sending: false,
    });
  });

  it('never opens again once disposed with its review', () => {
    const { comments } = gatheredComments();
    const page = new SendReviewPage({ comments, send: recordingSend(comments).send });
    page.open();
    page.dispose();
    expect(stub.webviewPanels).toHaveLength(0);

    page.open();

    expect(stub.webviewPanels).toHaveLength(0);
  });

  it('reads only genuine moves out of what the webview delivers', async () => {
    const { comments, line, whole } = gatheredComments();
    const recorder = recordingSend(comments);
    const page = new SendReviewPage({ comments, send: recorder.send });
    page.open();
    const panel = stub.webviewPanels[0]!;

    drive(panel, { type: 'kind', submit: 'request ChangES' });
    drive(panel, { type: 'edit', id: '1', body: 'not a number' });
    drive(panel, { type: 'body' });
    drive(panel, 'not a message');
    drive(panel, { type: 'submit', extra: true });
    await eventually('the submit to finish', () =>
      recorder.sent.length > 0 ? true : undefined,
    );

    // The malformed kind and edit read as absent; the well-formed submit,
    // whatever else it carries, sends the comment kind the page still holds.
    expect(recorder.sent).toEqual([{ submit: 'comment', comments: [line, whole] }]);
  });
});
