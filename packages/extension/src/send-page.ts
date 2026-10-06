import * as vscode from 'vscode';
import { randomUUID } from 'node:crypto';
import type { Comment, PendingReview, SubmitKind } from '@second-look/engine';
import { commentLocation, ReviewComments } from './comments.js';

/** The view type of the Send review page's one webview panel. */
export const SEND_REVIEW_VIEW_TYPE = 'second-look.sendReview' as const;

/** The three ways a review is submitted, in the order the page offers them. */
const SUBMIT_KINDS: readonly SubmitKind[] = ['comment', 'approve', 'request changes'];

/** Whether a value is one of the three ways a review is submitted. */
export function isSubmitKind(value: unknown): value is SubmitKind {
  return (SUBMIT_KINDS as readonly unknown[]).includes(value);
}

/** One draft comment as the page holds it. */
export interface ShownDraft {
  /** The page's own number for the draft, stable while it stays gathered. */
  id: number;
  /** Where the comment points: `path:line`, or `path (part)`. */
  where: string;
  /** The comment's text, as last written. */
  body: string;
}

/** The whole page as its webview renders it, posted on every change. */
export interface SendPageState {
  type: 'state';
  /** Every gathered comment, in the order the reviewer wrote them. */
  drafts: ShownDraft[];
  /** The overall comment on the whole pull request, empty for none. */
  body: string;
  /** How the reviewer chose to submit: comment, approve or request changes. */
  submit: SubmitKind;
  /** True while the one write is under way. */
  sending: boolean;
}

/** A move the reviewer makes on the page, as its webview reports it. */
export type SendPageMessage =
  | { type: 'ready' }
  | { type: 'edit'; id: number; body: string }
  | { type: 'discard'; id: number }
  | { type: 'body'; body: string }
  | { type: 'kind'; submit: SubmitKind }
  | { type: 'submit' };

/** Reads a page message out of what the webview delivered, if it is one. */
function pageMessage(value: unknown): SendPageMessage | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }
  const { type, id, body, submit } = value as Record<string, unknown>;
  switch (type) {
    case 'ready':
      return { type: 'ready' };
    case 'edit':
      return typeof id === 'number' && typeof body === 'string'
        ? { type: 'edit', id, body }
        : undefined;
    case 'discard':
      return typeof id === 'number' ? { type: 'discard', id } : undefined;
    case 'body':
      return typeof body === 'string' ? { type: 'body', body } : undefined;
    case 'kind':
      return isSubmitKind(submit) ? { type: 'kind', submit } : undefined;
    case 'submit':
      return { type: 'submit' };
    default:
      return undefined;
  }
}

/** What the Send review page needs: the pending review, and the one write. */
export interface SendReviewPageDeps {
  /** The pending review whose comments the page lists and submits. */
  comments: ReviewComments;
  /**
   * Performs the review's one write to GitHub, asking for its sign-in at
   * send time only; resolves false when nothing was sent — refused, or a
   * failure that keeps every comment — and true once the review went.
   */
  send(review: PendingReview): Promise<boolean>;
}

/**
 * The Send review page (issue #69): one last pass over the whole pending
 * review before it goes to GitHub. Every gathered comment shows together
 * with where it points, each one editable or droppable in place, beneath
 * them the overall comment on the whole pull request and the choice of
 * how to submit — comment, approve or request changes — and one Submit
 * button. Nothing reaches GitHub before that press (ADR 0002), and a send
 * that fails keeps every comment exactly as the page holds them.
 */
export class SendReviewPage implements vscode.Disposable {
  private readonly comments: ReviewComments;

  private readonly send: SendReviewPageDeps['send'];

  private panel: vscode.WebviewPanel | undefined;

  /** The drafts shown, keyed by the gathered comment each renders. */
  private drafts = new Map<Comment, number>();

  /** The next draft number: drafts keep theirs while they stay gathered. */
  private nextId = 1;

  private body = '';

  private submit: SubmitKind = 'comment';

  private sending = false;

  private disposed = false;

  private readonly gathered: vscode.Disposable;

  constructor(deps: SendReviewPageDeps) {
    this.comments = deps.comments;
    this.send = deps.send;
    this.gathered = this.comments.onDidChange(() => this.refresh());
  }

  /** Opens the page, or reveals it when it is already open. */
  open(): void {
    if (this.disposed) {
      return;
    }
    if (this.panel !== undefined) {
      this.panel.reveal();
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      SEND_REVIEW_VIEW_TYPE,
      'Send review',
      vscode.ViewColumn.Active,
      { enableScripts: true },
    );
    this.panel = panel;
    panel.webview.html = pageHtml(randomUUID());
    panel.webview.onDidReceiveMessage((message) => {
      void this.handle(message);
    });
    // The reviewer closing the tab ends the page's panel, not the page:
    // the companion keeps it, so opening it again keeps what it held.
    panel.onDidDispose(() => {
      if (this.panel === panel) {
        this.panel = undefined;
      }
    });
    this.refresh();
  }

  /**
   * Re-reads the pending review after it changed — a comment written in
   * the diff, a thread discarded there, the send that emptied it — and
   * posts the page as it now reads.
   */
  private refresh(): void {
    const shown = new Map<Comment, number>();
    for (const comment of this.comments.pending()) {
      shown.set(comment, this.drafts.get(comment) ?? this.nextId++);
    }
    this.drafts = shown;
    this.post();
  }

  /** Posts the page's whole state to its webview, when one is open. */
  private post(): void {
    const panel = this.panel;
    if (panel === undefined) {
      return;
    }
    void panel.webview.postMessage({
      type: 'state',
      drafts: [...this.drafts].map(([comment, id]) => ({
        id,
        where: commentLocation(comment),
        body: comment.body,
      })),
      body: this.body,
      submit: this.submit,
      sending: this.sending,
    } satisfies SendPageState);
  }

  /**
   * Adds text to the overall comment on the whole pull request, after
   * what it already says, the way a draft from a finding on the whole
   * pull request joins the pending review once the reviewer adds it. The
   * page shows it when it is open, and nothing is sent before Submit.
   * False while the review's one write is under way.
   */
  addToOverall(text: string): boolean {
    if (this.sending) {
      return false;
    }
    this.body = this.body.trim() === '' ? text : `${this.body.trimEnd()}\n\n${text}`;
    this.post();
    return true;
  }

  /** The gathered comment a draft number renders, if it is still gathered. */
  private byDraft(id: number): Comment | undefined {
    for (const [comment, draft] of this.drafts) {
      if (draft === id) {
        return comment;
      }
    }
    return undefined;
  }

  private async handle(value: unknown): Promise<void> {
    const message = pageMessage(value);
    if (message === undefined) {
      return;
    }
    switch (message.type) {
      case 'ready':
        this.post();
        return;
      case 'edit': {
        if (this.sending) {
          return;
        }
        const comment = this.byDraft(message.id);
        if (comment !== undefined) {
          this.comments.editBody(comment, message.body);
        }
        return;
      }
      case 'discard': {
        if (this.sending) {
          return;
        }
        const comment = this.byDraft(message.id);
        if (comment !== undefined) {
          this.comments.remove(comment);
        }
        return;
      }
      case 'body':
        this.body = message.body;
        return;
      case 'kind':
        this.submit = message.submit;
        this.post();
        return;
      case 'submit':
        await this.submitReview();
        return;
    }
  }

  /**
   * Sends the review as the page holds it: the one write, on the one
   * press. The page closes with a review that went — and what it chose
   * for that review does not carry into the next one — and stays as it
   * was for one that did not: refused or failed, every comment kept.
   */
  private async submitReview(): Promise<void> {
    if (this.sending) {
      return; // The button disables; this guards the double press.
    }
    const comments = [...this.comments.pending()];
    this.sending = true;
    this.post();
    let sent = false;
    try {
      sent = await this.send({
        submit: this.submit,
        ...(this.body !== '' ? { body: this.body } : {}),
        comments,
      });
    } catch {
      sent = false; // An unexpected throw reads as a failed send: everything stays.
    }
    this.sending = false;
    if (!sent) {
      this.post();
      return;
    }
    this.body = '';
    this.submit = 'comment';
    this.panel?.dispose();
    this.panel = undefined;
  }

  dispose(): void {
    this.disposed = true;
    this.gathered.dispose();
    this.panel?.dispose();
    this.panel = undefined;
  }
}

/**
 * The page's HTML: the recorded design (docs/ux) as a webview — every
 * draft with where it points, the overall comment, the submit choice and
 * the one Submit button — styled by the editor's own theme. The page's
 * script carries no state of its own: it renders whatever state the
 * companion posts, preserving the reviewer's focus, and reports every
 * move back.
 */
function pageHtml(nonce: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}';">
<style nonce="${nonce}">
  body {
    color: var(--vscode-foreground);
    background-color: var(--vscode-editor-background);
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size, 13px);
    margin: 0;
    padding: 0 32px;
  }
  main {
    max-width: 900px;
    margin: 0 auto;
    padding: 24px 0 48px;
  }
  h1 {
    font-size: 20px;
    font-weight: 600;
    margin: 0 0 4px;
  }
  .intro {
    color: var(--vscode-descriptionForeground);
    margin: 0 0 16px;
  }
  .draft {
    border: 1px solid var(--vscode-panel-border);
    border-radius: 4px;
    padding: 9px 11px;
    margin-bottom: 8px;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .draft-head {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .where {
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 12px;
    color: var(--vscode-textLink-foreground);
    flex: 1;
  }
  textarea {
    background-color: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
    border-radius: 2px;
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 12px;
    line-height: 1.4;
    padding: 6px 8px;
    width: 100%;
    box-sizing: border-box;
    resize: vertical;
  }
  textarea:focus {
    outline: 1px solid var(--vscode-focusBorder);
  }
  button {
    font-family: var(--vscode-font-family);
    font-size: 12px;
    border: none;
    border-radius: 2px;
    padding: 4px 10px;
    cursor: pointer;
  }
  .discard {
    background: transparent;
    color: var(--vscode-descriptionForeground);
    border: 1px solid var(--vscode-panel-border);
  }
  .overall {
    margin-top: 10px;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .overall-label {
    color: var(--vscode-descriptionForeground);
    font-size: 12px;
  }
  footer {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
    margin-top: 20px;
  }
  .kinds-label {
    color: var(--vscode-descriptionForeground);
  }
  .kinds {
    display: flex;
    gap: 6px;
  }
  .kind {
    background: transparent;
    color: var(--vscode-foreground);
    border: 1px solid var(--vscode-panel-border);
  }
  .kind[aria-checked="true"] {
    background-color: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    border-color: var(--vscode-button-background);
  }
  .spacer {
    flex: 1;
  }
  .submit {
    background-color: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    font-size: 13px;
    padding: 5px 16px;
  }
  .submit:disabled {
    opacity: 0.6;
    cursor: default;
  }
  .note {
    flex-basis: 100%;
    color: var(--vscode-descriptionForeground);
    font-size: 12px;
    margin: 4px 0 0;
  }
</style>
</head>
<body>
<main>
  <h1>Send your review</h1>
  <p class="intro" id="intro"></p>
  <section id="drafts"></section>
  <section class="overall">
    <div class="overall-label" id="overall-label">Comment on the whole pull request (optional)</div>
    <textarea id="overall" rows="3" aria-labelledby="overall-label"></textarea>
  </section>
  <footer>
    <span class="kinds-label">Submit as</span>
    <div class="kinds" id="kinds" role="radiogroup" aria-label="Submit as"></div>
    <span class="spacer"></span>
    <button class="submit" id="submit">Submit review to GitHub</button>
    <p class="note">Nothing reaches GitHub before you press Submit.</p>
  </footer>
</main>
<script nonce="${nonce}">
(function () {
  'use strict';
  var vscode = acquireVsCodeApi();
  var state = { drafts: [], body: '', submit: 'comment', sending: false };

  var intro = document.getElementById('intro');
  var drafts = document.getElementById('drafts');
  var overall = document.getElementById('overall');
  var kinds = document.getElementById('kinds');
  var submit = document.getElementById('submit');

  var KINDS = ['comment', 'approve', 'request changes'];
  var kindButtons = {};
  KINDS.forEach(function (kind) {
    var button = document.createElement('button');
    button.className = 'kind';
    button.type = 'button';
    button.role = 'radio';
    button.textContent = kind === 'comment' ? 'Comment'
      : kind === 'approve' ? 'Approve' : 'Request changes';
    button.addEventListener('click', function () {
      vscode.postMessage({ type: 'kind', submit: kind });
    });
    kinds.appendChild(button);
    kindButtons[kind] = button;
  });

  overall.addEventListener('input', function () {
    vscode.postMessage({ type: 'body', body: overall.value });
  });

  submit.addEventListener('click', function () {
    vscode.postMessage({ type: 'submit' });
  });

  /** Where the reviewer is typing, so a re-render keeps them there. */
  function focusToRestore() {
    var element = document.activeElement;
    if (element === null || element.tagName !== 'TEXTAREA') {
      return null;
    }
    return {
      id: element.id !== '' ? element.id : element.getAttribute('data-id'),
      start: element.selectionStart,
      end: element.selectionEnd,
    };
  }

  function restoreFocus(restore) {
    if (restore === null || restore.id === null) {
      return;
    }
    var element = restore.id === 'overall'
      ? document.getElementById('overall')
      : drafts.querySelector('textarea[data-id="' + restore.id + '"]');
    if (element === null) {
      return;
    }
    element.focus();
    try {
      element.setSelectionRange(restore.start, restore.end);
    } catch (error) {
      // A freshly rebuilt textarea keeps its whole value selected.
    }
  }

  function renderDraft(draft) {
    var article = document.createElement('article');
    article.className = 'draft';
    article.setAttribute('data-id', String(draft.id));
    var head = document.createElement('div');
    head.className = 'draft-head';
    var where = document.createElement('span');
    where.className = 'where';
    where.textContent = draft.where;
    var discard = document.createElement('button');
    discard.className = 'discard';
    discard.type = 'button';
    discard.title = 'Drop this comment from the review';
    discard.textContent = 'Discard';
    discard.disabled = state.sending;
    discard.addEventListener('click', function () {
      vscode.postMessage({ type: 'discard', id: draft.id });
    });
    head.appendChild(where);
    head.appendChild(discard);
    var body = document.createElement('textarea');
    body.rows = 3;
    body.setAttribute('data-id', String(draft.id));
    body.value = draft.body;
    body.disabled = state.sending;
    body.addEventListener('input', function () {
      vscode.postMessage({ type: 'edit', id: draft.id, body: body.value });
    });
    article.appendChild(head);
    article.appendChild(body);
    return article;
  }

  /** Rerenders a kept draft in place: its text only when the reviewer is
      not typing in it, its controls only as far as the send has come. */
  function updateDraft(article, draft) {
    article.querySelector('.where').textContent = draft.where;
    var body = article.querySelector('textarea');
    if (document.activeElement !== body) {
      body.value = draft.body;
    }
    body.disabled = state.sending;
    article.querySelector('.discard').disabled = state.sending;
  }

  function render() {
    var focused = document.activeElement;
    var restore = focusToRestore();
    var count = state.drafts.length;
    intro.textContent = count === 0
      ? 'No comments yet. Write them in the diff, or send only the overall comment.'
      : count + ' draft comment' + (count === 1 ? '' : 's') +
        '. They go to GitHub as one review, and only when you press Submit.';
    var kept = {};
    Array.prototype.slice.call(drafts.children).forEach(function (article) {
      kept[article.getAttribute('data-id')] = article;
    });
    var wanted = state.drafts.map(function (draft) {
      var id = String(draft.id);
      var article = kept[id];
      if (article !== undefined) {
        delete kept[id];
        updateDraft(article, draft);
      } else {
        article = renderDraft(draft);
      }
      return article;
    });
    Object.keys(kept).forEach(function (id) {
      drafts.removeChild(kept[id]);
    });
    wanted.forEach(function (article, index) {
      if (drafts.children[index] !== article) {
        drafts.insertBefore(article, drafts.children[index] || null);
      }
    });
    KINDS.forEach(function (kind) {
      kindButtons[kind].setAttribute('aria-checked', kind === state.submit ? 'true' : 'false');
    });
    if (document.activeElement !== overall) {
      overall.value = state.body;
    }
    submit.disabled = state.sending;
    if (focused === null || !focused.isConnected || document.activeElement !== focused) {
      restoreFocus(restore);
    }
  }

  window.addEventListener('message', function (event) {
    var message = event.data;
    if (message !== null && typeof message === 'object' && message.type === 'state') {
      state = message;
      render();
    }
  });

  render();
  vscode.postMessage({ type: 'ready' });
}());
</script>
</body>
</html>`;
}
