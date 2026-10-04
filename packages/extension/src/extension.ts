import * as vscode from 'vscode';
import { EngineClient, spawnEngineProcess, type SpawnEngine } from './engine-client.js';
import {
  ADD_COMMENT_COMMAND,
  COMMENT_ON_PART_COMMAND,
  DISCARD_COMMENT_COMMAND,
  OPEN_ALL_PARTS_COMMAND,
  OPEN_PART_COMMAND,
  REVIEW_COMMAND,
  REVIEW_TREE_VIEW,
  SUBMIT_REVIEW_COMMAND,
} from './commands.js';
import { CHANGE_SCHEME, ChangeCopiesProvider } from './change-copies.js';
import { openPartInDiffEditor, openWholeChangeInDiffEditor, PartMarker } from './diff-view.js';
import {
  buildTree,
  pendingReviewSection,
  type TreeComment,
  type TreePart,
  type TreeSection,
} from './tree.js';
import { pickSubmitKind, readOverallComment, ReviewComments } from './comments.js';
import { AgentStatusBar } from './agent-status.js';
import type { Part, ReviewResult, SubmitKind } from '@second-look/engine';

export {
  ADD_COMMENT_COMMAND,
  COMMENT_ON_PART_COMMAND,
  DISCARD_COMMENT_COMMAND,
  OPEN_ALL_PARTS_COMMAND,
  OPEN_PART_COMMAND,
  REVIEW_COMMAND,
  REVIEW_TREE_VIEW,
  SUBMIT_REVIEW_COMMAND,
};

/** The parts of the environment tests replace; production uses the real ones. */
export interface ExtensionDeps {
  /** Starts the engine process; tests start a fake engine instead. */
  spawnEngine?: SpawnEngine;
  /** The extension host's environment; tests inject one carrying an API key. */
  env?: NodeJS.ProcessEnv;
}

/** The one node the tree shows before the first review. */
const EMPTY_TREE_PLACEHOLDER: TreePart = {
  label: 'Review a pull request to see its parts here, ranked by importance.',
  kind: 'part',
};

/** A tree node: a section, a part inside it, or a pending comment. */
type TreeNode = TreeSection | TreePart | TreeComment;

function isSection(node: TreeNode): node is TreeSection {
  return 'parts' in node;
}

/** Whether a value is one of the three ways a review is submitted. */
function isSubmitKind(value: unknown): value is SubmitKind {
  return value === 'comment' || value === 'approve' || value === 'request changes';
}

/** Whether a value is a part of the reviewed change. */
function isPart(value: unknown): value is Part {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Part).path === 'string' &&
    Array.isArray((value as Part).hunks)
  );
}

/**
 * The part a command's argument carries: the tree's element, unwrapped,
 * or the part itself, the way a tree item's own click command passes it.
 * Anything else reads as absent.
 */
function carriedPart(arg: unknown): Part | undefined {
  if (typeof arg !== 'object' || arg === null) {
    return undefined;
  }
  const node = arg as { part?: unknown };
  if (node.part !== undefined) {
    return isPart(node.part) ? node.part : undefined;
  }
  return isPart(arg) ? arg : undefined;
}

/**
 * The side-bar tree: importance groups in order with the reason beside
 * each part and the signals in its tooltip, the noise last, and the
 * pending review gathering above them all. Clicking a part opens it in
 * the diff editor.
 */
class ReviewTreeProvider implements vscode.TreeDataProvider<TreeNode> {
  private readonly change = new vscode.EventEmitter<void>();
  private sections: TreeSection[] = [];

  readonly onDidChangeTreeData = this.change.event;

  setSections(sections: TreeSection[]): void {
    this.sections = sections;
    this.change.fire();
  }

  getTreeItem(node: TreeNode): vscode.TreeItem {
    if (isSection(node)) {
      const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.Expanded);
      item.tooltip = node.tooltip;
      return item;
    }
    const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
    item.description = node.description;
    item.tooltip = node.tooltip;
    item.contextValue = node.kind;
    if (node.kind !== 'comment' && node.part !== undefined) {
      item.command = {
        command: OPEN_PART_COMMAND,
        title: 'Open part in the diff editor',
        arguments: [node.part],
      };
    }
    return item;
  }

  getChildren(node?: TreeNode): TreeNode[] {
    if (node === undefined) {
      return this.sections.length > 0 ? this.sections : [EMPTY_TREE_PLACEHOLDER];
    }
    return isSection(node) ? node.parts : [];
  }
}

/**
 * Runs the review: asks for the pull request URL unless the command
 * already carries one as its argument, signs in with VS Code's built-in
 * GitHub login, and hands the request to the engine with the token from
 * that sign-in — the token travels with the request and is never stored.
 * Progress shows while the engine works, and an engine failure reads as
 * its plain message.
 *
 * The session keeps the result it shows, so a part click can open the
 * multi-file diff from the same copies the engine downloaded.
 */
class ReviewSession {
  private readonly tree: ReviewTreeProvider;
  private readonly treeView: vscode.TreeView<TreeNode>;
  private readonly copies: ChangeCopiesProvider;
  private readonly marker: PartMarker;
  private readonly comments: ReviewComments;
  private readonly spawnEngine: ExtensionDeps['spawnEngine'];
  private engine: EngineClient | undefined;
  private result: ReviewResult | undefined;
  private url: string | undefined;

  constructor(
    tree: ReviewTreeProvider,
    treeView: vscode.TreeView<TreeNode>,
    copies: ChangeCopiesProvider,
    marker: PartMarker,
    comments: ReviewComments,
    deps: ExtensionDeps,
  ) {
    this.tree = tree;
    this.treeView = treeView;
    this.copies = copies;
    this.marker = marker;
    this.comments = comments;
    this.spawnEngine = deps.spawnEngine;
    this.comments.onDidChange(() => this.refreshTree());
  }

  async reviewPullRequest(urlArg?: string): Promise<void> {
    const url =
      urlArg !== undefined && urlArg.trim() !== ''
        ? urlArg
        : await vscode.window.showInputBox({
            prompt: 'GitHub pull request URL',
            placeHolder: 'https://github.com/{owner}/{repo}/pull/{number}',
            ignoreFocusOut: true,
          });
    if (url === undefined || url.trim() === '') {
      return;
    }

    let session: vscode.AuthenticationSession | undefined;
    try {
      session = await vscode.authentication.getSession('github', ['repo'], {
        createIfNone: true,
      });
    } catch {
      session = undefined;
    }
    if (!session) {
      vscode.window.showWarningMessage('Sign in to GitHub to review a pull request.');
      return;
    }
    const accessToken = session.accessToken;

    try {
      const result = await vscode.window.withProgress(
        { location: { viewId: REVIEW_TREE_VIEW }, title: 'Reading the pull request…' },
        () => this.engineReview(url.trim(), accessToken),
      );
      this.result = result;
      this.url = result.pullRequest.url;
      this.copies.setCopies(result.copies);
      this.comments.setReview(result);
      this.tree.setSections(this.sections());
      await this.revealFirstSection();
    } catch (error) {
      vscode.window.showErrorMessage(
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  /** The tree's sections: the pending review gathering above the ranked parts. */
  private sections(): TreeSection[] {
    if (this.result === undefined) {
      return [];
    }
    const pending = this.comments.pending();
    return [
      ...(pending.length > 0 ? [pendingReviewSection(pending)] : []),
      ...buildTree(this.result),
    ];
  }

  /** Rebuilds the tree's sections after the pending review changed. */
  private refreshTree(): void {
    if (this.result !== undefined) {
      this.tree.setSections(this.sections());
    }
  }

  /** Opens one part in the multi-file diff editor, read from the cached copies. */
  async openPart(part: Part): Promise<void> {
    if (this.result === undefined) {
      return;
    }
    try {
      await openPartInDiffEditor(part, this.result, this.marker);
    } catch (error) {
      vscode.window.showErrorMessage(
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  /** Opens the whole change in one multi-file diff, in the tree's ranked order. */
  async openAllParts(): Promise<void> {
    if (this.result === undefined) {
      vscode.window.showWarningMessage(
        'Review a pull request first, then open all its parts in order.',
      );
      return;
    }
    try {
      await openWholeChangeInDiffEditor(this.result, this.marker);
    } catch (error) {
      vscode.window.showErrorMessage(
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  /** Adds the comment the reviewer wrote in a thread to the pending review. */
  addComment(reply: vscode.CommentReply): void {
    this.comments.add(reply);
  }

  /**
   * Starts a comment on a whole part, gathered in the pending review.
   * The editor's context menu passes the tree's element, so the part is
   * read out of whatever the argument carries; with nothing usable, or
   * no review to comment on, the reviewer is told what is missing.
   */
  commentOnPart(arg?: unknown): void {
    const part = carriedPart(arg);
    if (part === undefined || this.result === undefined) {
      vscode.window.showWarningMessage(
        'Review a pull request first, then comment on its parts.',
      );
      return;
    }
    this.comments.commentOnPart(part);
  }

  /** Discards one pending comment, with its thread. */
  discardComment(thread: vscode.CommentThread): void {
    this.comments.discard(thread);
  }

  /**
   * Submits the pending review to GitHub as one review: how the reviewer
   * chose, with their overall comment, every gathered comment in it. The
   * GitHub sign-in is asked for here, at send time only — until this
   * moment nothing of the review has left the companion (ADR 0002) — and
   * a send that fails keeps every comment for the reviewer to send again.
   *
   * The arguments skip the prompts only when they are what they claim:
   * a genuine submit kind and a string body, the way a test drives the
   * flow. The editor's menus forward other things — the tree title's
   * button passes the view's context object — so anything else reads as
   * absent and the prompts ask.
   */
  async submitReview(submitArg?: SubmitKind, bodyArg?: string): Promise<void> {
    if (this.result === undefined || this.url === undefined) {
      vscode.window.showWarningMessage(
        'Review a pull request first, then write comments and submit them.',
      );
      return;
    }
    const submit = isSubmitKind(submitArg) ? submitArg : await pickSubmitKind();
    if (submit === undefined) {
      return; // Dismissed: the deliberate step was not taken.
    }
    const body = typeof bodyArg === 'string' ? bodyArg : await readOverallComment();
    if (body === undefined) {
      return;
    }
    const comments = this.comments.pending();
    if (comments.length === 0 && body === '' && submit !== 'approve') {
      vscode.window.showWarningMessage(
        'Nothing to send yet: write a comment or an overall comment, or approve.',
      );
      return;
    }

    let session: vscode.AuthenticationSession | undefined;
    try {
      session = await vscode.authentication.getSession('github', ['repo'], {
        createIfNone: true,
      });
    } catch {
      session = undefined;
    }
    if (!session) {
      vscode.window.showWarningMessage('Sign in to GitHub to send the review.');
      return; // The comments stay gathered.
    }

    try {
      const sent = await vscode.window.withProgress(
        { location: { viewId: REVIEW_TREE_VIEW }, title: 'Sending the review…' },
        () =>
          this.engineSend(this.url!, session!.accessToken, {
            submit,
            ...(body !== '' ? { body } : {}),
            comments: [...comments],
          }),
      );
      this.comments.clear();
      vscode.window.showInformationMessage(`Review sent: ${sent.url}`, 'Open on GitHub').then(
        (open) => {
          if (open === 'Open on GitHub') {
            void vscode.env.openExternal(vscode.Uri.parse(sent.url));
          }
        },
        () => undefined,
      );
    } catch (error) {
      // The send failed: every comment stays gathered for another try.
      vscode.window.showErrorMessage(
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  private async engineSend(
    url: string,
    token: string,
    review: Parameters<EngineClient['sendReview']>[2],
  ) {
    if (this.engine === undefined) {
      this.engine = new EngineClient(this.spawnEngine ?? spawnEngineProcess);
    }
    if (!this.engine.initialized) {
      await this.engine.initialize();
    }
    return this.engine.sendReview(url, token, review);
  }

  private async engineReview(url: string, token: string) {
    if (this.engine === undefined) {
      this.engine = new EngineClient(this.spawnEngine ?? spawnEngineProcess);
    }
    if (!this.engine.initialized) {
      await this.engine.initialize();
    }
    return this.engine.review(url, token);
  }

  private async revealFirstSection(): Promise<void> {
    const first = this.tree.getChildren()[0];
    if (first !== undefined && isSection(first)) {
      await this.treeView.reveal(first, { expand: true }).then(
        () => undefined,
        () => undefined,
      );
    }
  }

  dispose(): void {
    this.engine?.dispose();
  }
}

/**
 * Activates the companion: registers the review command and the review
 * tree, the read-only file system that serves the change's copies, the
 * commands that open a part — or the whole change, in ranked order —
 * in the editor's multi-file diff, the comment threads the reviewer
 * writes the pending review in, the command that submits it to GitHub,
 * and the status bar entry that shows the agent and model in use.
 * Nothing here runs anything from the workspace — the engine is started
 * from the companion's own install, reads GitHub, and writes only the
 * one review the reviewer sends.
 *
 * Returns the review tree's data provider, so a test running in a real
 * editor can read the tree the command filled.
 */
export function activate(
  context: vscode.ExtensionContext,
  deps: ExtensionDeps = {},
): vscode.TreeDataProvider<TreeSection | TreePart | TreeComment> {
  const tree = new ReviewTreeProvider();
  const treeView = vscode.window.createTreeView(REVIEW_TREE_VIEW, {
    treeDataProvider: tree,
  });
  const copies = new ChangeCopiesProvider();
  const marker = new PartMarker();
  const comments = new ReviewComments();
  const session = new ReviewSession(tree, treeView, copies, marker, comments, deps);
  const agentStatusBar = new AgentStatusBar(deps.env);
  agentStatusBar.refresh();
  context.subscriptions.push(
    treeView,
    marker,
    comments,
    { dispose: () => session.dispose() },
    agentStatusBar,
    vscode.workspace.registerFileSystemProvider(CHANGE_SCHEME, copies, {
      isCaseSensitive: true,
      isReadonly: new vscode.MarkdownString(
        'The base and head copies are read-only; nothing from the pull request is written.',
      ),
    }),
    vscode.commands.registerCommand(REVIEW_COMMAND, (url?: string) =>
      session.reviewPullRequest(url),
    ),
    vscode.commands.registerCommand(OPEN_PART_COMMAND, (part?: Part) =>
      part === undefined ? undefined : session.openPart(part),
    ),
    vscode.commands.registerCommand(OPEN_ALL_PARTS_COMMAND, () => session.openAllParts()),
    vscode.commands.registerCommand(SUBMIT_REVIEW_COMMAND, (submit?: SubmitKind, body?: string) =>
      session.submitReview(submit, body),
    ),
    vscode.commands.registerCommand(ADD_COMMENT_COMMAND, (reply?: vscode.CommentReply) =>
      reply === undefined ? undefined : session.addComment(reply),
    ),
    vscode.commands.registerCommand(COMMENT_ON_PART_COMMAND, (arg?: unknown) =>
      session.commentOnPart(arg),
    ),
    vscode.commands.registerCommand(DISCARD_COMMENT_COMMAND, (thread?: vscode.CommentThread) =>
      thread === undefined ? undefined : session.discardComment(thread),
    ),
  );
  return tree;
}

/** Runs at shutdown; the engine stops through the subscriptions activate recorded. */
export function deactivate(): void {
  // Nothing else to do: the engine process was pushed onto the
  // subscriptions when the session was created.
}
