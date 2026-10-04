import * as vscode from 'vscode';
import {
  EngineClient,
  spawnEngineProcess,
  type ReviewStageUpdate,
  type SpawnEngine,
} from './engine-client.js';
import {
  ADD_COMMENT_COMMAND,
  COMMENT_ON_PART_COMMAND,
  DISCARD_COMMENT_COMMAND,
  OPEN_ALL_PARTS_COMMAND,
  OPEN_OVERVIEW_COMMAND,
  OPEN_PART_COMMAND,
  REVIEW_COMMAND,
  REVIEW_TREE_VIEW,
  SUBMIT_REVIEW_COMMAND,
  WHY_THIS_MATTERS_COMMAND,
} from './commands.js';
import { CHANGE_SCHEME, ChangeCopiesProvider } from './change-copies.js';
import { openPartInDiffEditor, openWholeChangeInDiffEditor, PartMarker } from './diff-view.js';
import {
  anchorOf,
  buildTree,
  findAnchor,
  reviewStatus,
  pendingReviewSection,
  type TreeComment,
  type TreePart,
  type TreeSection,
} from './tree.js';
import { ReviewComments } from './comments.js';
import { isSubmitKind, SendReviewPage } from './send-page.js';
import { OverviewPanel } from './overview.js';
import { AgentStatusBar } from './agent-status.js';
import { readAgentSettings, reviewAgentChoice } from './agent-settings.js';
import type { Part, PendingReview, ReviewResult } from '@second-look/engine';

export {
  ADD_COMMENT_COMMAND,
  COMMENT_ON_PART_COMMAND,
  DISCARD_COMMENT_COMMAND,
  OPEN_ALL_PARTS_COMMAND,
  OPEN_OVERVIEW_COMMAND,
  OPEN_PART_COMMAND,
  REVIEW_COMMAND,
  REVIEW_TREE_VIEW,
  SUBMIT_REVIEW_COMMAND,
  WHY_THIS_MATTERS_COMMAND,
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

  /** The sections the tree shows now. */
  get current(): readonly TreeSection[] {
    return this.sections;
  }

  getTreeItem(node: TreeNode): vscode.TreeItem {
    if (isSection(node)) {
      const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.Expanded);
      item.tooltip = node.tooltip;
      // Stable ids keep a section's expanded state, and a part's selection,
      // across a regrouping; a part is known by where it starts, since every
      // hunk belongs to exactly one part.
      item.id = `section:${node.label}`;
      return item;
    }
    const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
    item.description = node.description;
    item.tooltip = node.tooltip;
    item.contextValue = node.kind;
    if (node.kind !== 'comment' && node.part !== undefined) {
      item.id = `part:${JSON.stringify(anchorOf(node.part))}`;
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

  getParent(node: TreeNode): TreeNode | undefined {
    if (isSection(node)) return undefined;
    return this.sections.find((section) => section.parts.includes(node));
  }
}

/**
 * Runs the review: asks for the pull request URL unless the command
 * already carries one as its argument, signs in with VS Code's built-in
 * GitHub login, and hands the request to the engine with the token from
 * that sign-in and the agent choice the settings carry — both travel with
 * the request, the token is never stored, and the engine runs every agent
 * pass on the chosen agent, model and account. Progress shows while the
 * engine works, and an engine failure reads as its plain message.
 *
 * A review arrives in stages: the tree shows the plain parts first, with
 * a status line naming the stage still running, then updates in place
 * when the agent's parts arrive and again when its ranking does — keeping
 * the reviewer's place: the part holding the selected part's first hunk
 * stays selected, and the open diff editor stays as it is. A new review
 * replaces one still running.
 *
 * The session keeps the result it shows, so a part click can open the
 * multi-file diff from the same copies the engine downloaded. The review's
 * overview opens with its first result, without taking the focus from the
 * tree, and follows every stage.
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
  /** Counts the reviews started, so a replaced review's late answers are dropped. */
  private reviews = 0;
  /** True while a review's engine request is still out. */
  private running = false;
  private url: string | undefined;
  /** The Send review page of the review under way, once the reviewer opens it. */
  private page: SendReviewPage | undefined;
  /** The review's overview: the story, the description and who made each result. */
  private readonly overview = new OverviewPanel((part) => void this.openPart(part));

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

    // A new review replaces one still running: stopping the engine drops
    // the old request, and the next request starts a fresh engine.
    if (this.running) {
      this.engine?.dispose();
      this.engine = undefined;
    }
    const review = ++this.reviews;
    const current = (): boolean => review === this.reviews;
    let shown = false;
    this.running = true;
    this.treeView.message = undefined;
    try {
      const result = await vscode.window.withProgress(
        { location: { viewId: REVIEW_TREE_VIEW }, title: 'Reading the pull request…' },
        () =>
          this.engineReview(url.trim(), accessToken, (stage) => {
            if (!current()) return;
            void this.show(stage.result, shown, stage.running);
            shown = true;
            this.treeView.message = reviewStatus(stage.result, stage.running);
          }),
      );
      if (!current()) return;
      await this.show(result, shown);
      this.treeView.message = reviewStatus(result);
    } catch (error) {
      if (!current()) return;
      this.treeView.message = undefined;
      vscode.window.showErrorMessage(
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      if (current()) this.running = false;
    }
  }

  /**
   * Shows a result in the tree. The first result of a review starts its
   * pending review, opens the overview and reveals the first section; a
   * later one updates the tree and the overview in place and keeps the
   * reviewer's place, reselecting the part that now holds the selected
   * part's first hunk, with every pending comment kept.
   */
  private async show(result: ReviewResult, update: boolean, running?: string): Promise<void> {
    const selected = this.treeView.selection[0];
    const anchor =
      update &&
      selected !== undefined &&
      !isSection(selected) &&
      selected.kind !== 'comment' &&
      selected.part !== undefined
        ? anchorOf(selected.part)
        : undefined;
    this.result = result;
    this.url = result.pullRequest.url;
    this.copies.setCopies(result.copies);
    // A review's first result starts its pending review afresh — its Send
    // review page closes with the review it belonged to — and a later
    // stage of the same review keeps every comment already written, whose
    // lines and files the regrouping does not change.
    if (!update) {
      this.page?.dispose();
      this.page = undefined;
      this.comments.setReview(result);
    }
    this.tree.setSections(this.sections());
    this.overview.update(result, running);
    if (!update) {
      this.overview.open({ preserveFocus: true });
      await this.revealFirstSection();
      return;
    }
    const node = anchor === undefined ? undefined : findAnchor(this.tree.current, anchor);
    if (node !== undefined) {
      await this.treeView.reveal(node, { select: true, focus: false }).then(
        () => undefined,
        () => undefined,
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

  /** Opens the review's overview at the story's start. */
  openOverview(): void {
    if (!this.overview.open()) {
      vscode.window.showWarningMessage('Review a pull request first, then open its overview.');
    }
  }

  /**
   * A part's "why this matters": opens the overview's story at the first
   * sentence that mentions the part, or says the story does not. The tree
   * passes its element, so the part is read out of whatever the argument
   * carries, and found in the result shown by where it starts.
   */
  whyThisMatters(arg?: unknown): void {
    const part = carriedPart(arg);
    if (part === undefined || this.result === undefined) {
      vscode.window.showWarningMessage('Review a pull request first, then read why its parts matter.');
      return;
    }
    const anchor = JSON.stringify(anchorOf(part));
    const index = this.result.parts.findIndex((each) => JSON.stringify(anchorOf(each)) === anchor);
    this.overview.open(index >= 0 ? { focus: index } : {});
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
   * Submits the pending review through the Send review page: every
   * gathered comment together for one last pass, the overall comment and
   * the submit kind chosen on the page, and the one write only when its
   * Submit button is pressed (ADR 0002).
   *
   * The arguments are the one send without the page: a command carrying
   * a completed review — a genuine submit kind and a body string, the way
   * the real-host test drives the flow, which cannot press the page's own
   * button. The editor's menus forward other things — the tree title's
   * button passes the view's context object — so anything else opens the
   * page.
   */
  async submitReview(submitArg?: unknown, bodyArg?: unknown): Promise<void> {
    if (this.result === undefined || this.url === undefined) {
      vscode.window.showWarningMessage(
        'Review a pull request first, then write comments and submit them.',
      );
      return;
    }
    if (isSubmitKind(submitArg) && typeof bodyArg === 'string') {
      await this.sendPending({
        submit: submitArg,
        ...(bodyArg !== '' ? { body: bodyArg } : {}),
        comments: [...this.comments.pending()],
      });
      return;
    }
    this.page ??= new SendReviewPage({
      comments: this.comments,
      send: (review) => this.sendPending(review),
    });
    this.page.open();
  }

  /**
   * Performs the review's one write to GitHub, wherever it was asked for:
   * the GitHub sign-in is asked for here, at send time only — until this
   * moment nothing of the review has left the companion (ADR 0002) — and
   * a send that fails keeps every comment for the reviewer to send again.
   * True once the review went, false when it was refused or failed.
   */
  private async sendPending(review: PendingReview): Promise<boolean> {
    if (review.comments.some((comment) => comment.body.trim() === '')) {
      vscode.window.showWarningMessage(
        'One comment is empty: write it or drop it before sending.',
      );
      return false;
    }
    if (review.comments.length === 0 && review.body === undefined && review.submit !== 'approve') {
      vscode.window.showWarningMessage(
        'Nothing to send yet: write a comment or an overall comment, or approve.',
      );
      return false;
    }
    return this.comments.sendWhileSealed(async () => {
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
        return false; // The comments stay gathered.
      }

      try {
        const sent = await vscode.window.withProgress(
          { location: { viewId: REVIEW_TREE_VIEW }, title: 'Sending the review…' },
          () => this.engineSend(this.url!, session!.accessToken, review),
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
        return true;
      } catch (error) {
        // The send failed: every comment stays gathered for another try.
        vscode.window.showErrorMessage(
          error instanceof Error ? error.message : String(error),
        );
        return false;
      }
    });
  }

  private async engineSend(
    url: string,
    token: string,
    review: Parameters<EngineClient['sendReview']>[2],
  ) {
    const engine = await this.readyEngine();
    return engine.sendReview(url, token, review);
  }

  private async engineReview(
    url: string,
    token: string,
    onStage: (stage: ReviewStageUpdate) => void,
  ): Promise<ReviewResult> {
    const engine = await this.readyEngine();
    return engine.review(url, token, reviewAgentChoice(readAgentSettings()), onStage);
  }

  /**
   * The engine, started and past its handshake. The agent, model and
   * account the settings choose travel with each review request, so a
   * settings change needs no engine restart: the next review simply runs
   * on the chosen agent, and its result is stamped accordingly.
   */
  private async readyEngine(): Promise<EngineClient> {
    const engine = this.engine ?? (this.engine = new EngineClient(this.spawnEngine ?? spawnEngineProcess));
    if (!engine.initialized) {
      await engine.initialize();
    }
    return engine;
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
    this.page?.dispose();
    this.overview.dispose();
  }
}

/**
 * Activates the companion: registers the review command and the review
 * tree, the read-only file system that serves the change's copies, the
 * commands that open a part — or the whole change, in ranked order —
 * in the editor's multi-file diff, the comment threads the reviewer
 * writes the pending review in, the command that submits it to GitHub,
 * the commands that open the review's overview — at the story's start, or
 * at one part as its "why this matters" — and the status bar entry that
 * shows the agent and model in use.
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
    vscode.commands.registerCommand(SUBMIT_REVIEW_COMMAND, (submit?: unknown, body?: unknown) =>
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
    vscode.commands.registerCommand(OPEN_OVERVIEW_COMMAND, () => session.openOverview()),
    vscode.commands.registerCommand(WHY_THIS_MATTERS_COMMAND, (arg?: unknown) => session.whyThisMatters(arg)),
  );
  return tree;
}

/** Runs at shutdown; the engine stops through the subscriptions activate recorded. */
export function deactivate(): void {
  // Nothing else to do: the engine process was pushed onto the
  // subscriptions when the session was created.
}
