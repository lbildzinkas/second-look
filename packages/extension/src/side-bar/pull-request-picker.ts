import * as vscode from 'vscode';
import { SIGNED_OUT_REASON, parsePullRequestUrl, type ListPullRequestsParams, type PullRequestList } from '@second-look/engine';
import { REVIEW_COMMAND } from '../commands.js';
import type { PullRequestMessage, PullRequestPickerView } from './pull-requests.js';

/** What the list asks the engine: the reviewer's open pull requests. */
export interface PullRequestEngine {
  listPullRequests(params: ListPullRequestsParams): Promise<PullRequestList>;
}

export interface PullRequestPickerDeps {
  /** The engine, started and past its handshake. */
  engine(): Promise<PullRequestEngine>;
  /** Redraws the side bar. */
  onChange(): void;
  /** The open folder's GitHub repository as `owner/name`; production reads it from the folder's git remote. */
  repository?(): Promise<string | undefined>;
  /** The time the list is read at; production uses the clock. */
  now?(): Date;
}

/**
 * The GitHub repository a git config's `origin` remote points at, as
 * `owner/name`; absent when it has no GitHub origin.
 */
export function originRepository(config: string): string | undefined {
  const origin = /^\s*\[remote "origin"\]([^[]*)/m.exec(config)?.[1] ?? '';
  const url = /^\s*url\s*=\s*(\S+)/m.exec(origin)?.[1] ?? '';
  const match = /^(?:https:\/\/(?:[^@/\s]+@)?github\.com\/|(?:ssh:\/\/)?git@github\.com[:/])([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(url);
  return match === null ? undefined : `${match[1]}/${match[2]}`;
}

/** The first open folder's GitHub repository, read from its `.git/config` and never run; absent when there is none. */
async function openFolderRepository(): Promise<string | undefined> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (folder === undefined) return undefined;
  try {
    const config = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(folder.uri, '.git', 'config'));
    return originRepository(new TextDecoder().decode(config));
  } catch {
    return undefined;
  }
}

/**
 * Step 2's list of the reviewer's open pull requests (issue 137). It
 * loads when step 2's card first shows, and again on the refresh title
 * button, Try again, or a sign-in from its card: the token comes from the
 * editor's GitHub sign-in without asking, and travels with the one
 * request. Typing filters the list; a pull request URL pasted into the
 * box, or entered with Enter, starts its review, as a card's Review
 * button does, through the existing review command.
 */
export class PullRequestPicker {
  private view: PullRequestPickerView = { list: { state: 'not loaded' }, filter: '', chip: 'all' };
  private readonly deps: PullRequestPickerDeps;
  /** Counts the loads started, so a replaced one's late answer is dropped. */
  private loads = 0;

  constructor(deps: PullRequestPickerDeps) {
    this.deps = deps;
  }

  /** The list as it stands. */
  get current(): PullRequestPickerView {
    return this.view;
  }

  /** Step 2's card shows: the list loads unless it already has. */
  shown(): void {
    if (this.view.list.state === 'not loaded') void this.load();
  }

  async handle(message: PullRequestMessage): Promise<void> {
    const { action, value } = message;
    if (action === 'show') return this.shown();
    if (action === 'reload') return this.load();
    if (action === 'signIn') {
      // A sign-in the reviewer cancels leaves the list signed out, saying so again.
      await vscode.authentication.getSession('github', ['repo'], { createIfNone: true }).then(undefined, () => undefined);
      return this.load();
    }
    if (action === 'chip') this.view = { ...this.view, chip: value as PullRequestPickerView['chip'] };
    if (action === 'filter' || action === 'go') this.view = { ...this.view, filter: value };
    this.deps.onChange();
    const url = value.trim();
    const isReview = action === 'review' || action === 'go' || (action === 'filter' && message.pasted);
    if (isReview && parsePullRequestUrl(url) !== null) await vscode.commands.executeCommand(REVIEW_COMMAND, url);
  }

  /** Reads the list again, showing it loading meanwhile. */
  async load(): Promise<void> {
    const load = ++this.loads;
    this.view = { ...this.view, list: { state: 'loading' } };
    this.deps.onChange();
    let list: PullRequestPickerView['list'];
    try {
      const session = await vscode.authentication.getSession('github', ['repo'], { silent: true }).then(undefined, () => undefined);
      if (session === undefined) {
        list = { state: 'signed out', reason: SIGNED_OUT_REASON };
      } else {
        const repository = await (this.deps.repository ?? openFolderRepository)();
        const answer = await (await this.deps.engine()).listPullRequests({ token: session.accessToken, ...(repository !== undefined ? { repository } : {}) });
        const readAt = (this.deps.now?.() ?? new Date()).toISOString();
        list = answer.outcome === 'listed' ? { state: 'listed', groups: answer.groups, readAt } : answer.outcome === 'signed out' ? { state: 'signed out', reason: answer.reason } : { state: 'unreachable', reason: answer.reason };
      }
    } catch (error) {
      list = { state: 'failed', message: error instanceof Error ? error.message : String(error) };
    }
    if (load !== this.loads) return;
    this.view = { ...this.view, list };
    this.deps.onChange();
  }
}
