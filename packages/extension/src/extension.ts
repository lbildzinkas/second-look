import * as vscode from 'vscode';
import {
  EngineClient,
  spawnEngineProcess,
  type ReviewStageUpdate,
  type SpawnEngine,
} from './engine-client.js';
import {
  OPEN_ALL_PARTS_COMMAND,
  OPEN_PART_COMMAND,
  REVIEW_COMMAND,
  REVIEW_TREE_VIEW,
} from './commands.js';
import { CHANGE_SCHEME, ChangeCopiesProvider } from './change-copies.js';
import { openPartInDiffEditor, openWholeChangeInDiffEditor, PartMarker } from './diff-view.js';
import {
  anchorOf,
  buildTree,
  findAnchor,
  groupingStatus,
  type TreePart,
  type TreeSection,
} from './tree.js';
import { AgentStatusBar } from './agent-status.js';
import { readAgentSettings, type AgentSettings } from './agent-settings.js';
import type { Part, ReviewResult } from '@second-look/engine';

export { OPEN_ALL_PARTS_COMMAND, OPEN_PART_COMMAND, REVIEW_COMMAND, REVIEW_TREE_VIEW };

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

/** A tree node: either a section or a part inside it. */
type TreeNode = TreeSection | TreePart;

function isSection(node: TreeNode): node is TreeSection {
  return 'parts' in node;
}

/**
 * The side-bar tree: importance groups in order with the reason beside
 * each part and the signals in its tooltip, and the noise last. Clicking
 * a part opens it in the diff editor.
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
    if (node.part !== undefined) {
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
 * that sign-in — the token travels with the request and is never stored.
 * Progress shows while the engine works, and an engine failure reads as
 * its plain message.
 *
 * A review arrives in stages: the tree shows the plain parts first, with
 * a status line naming the stage still running, then updates in place
 * when the agent's parts arrive — keeping the reviewer's place: the part
 * holding the selected part's first hunk stays selected, and the open
 * diff editor stays as it is. A new review replaces one still running.
 *
 * The session keeps the result it shows, so a part click can open the
 * multi-file diff from the same copies the engine downloaded.
 */
class ReviewSession {
  private readonly tree: ReviewTreeProvider;
  private readonly treeView: vscode.TreeView<TreeNode>;
  private readonly copies: ChangeCopiesProvider;
  private readonly marker: PartMarker;
  private readonly spawnEngine: ExtensionDeps['spawnEngine'];
  private engine: EngineClient | undefined;
  /** The agent and model the running engine was started with. */
  private engineAgent: Pick<AgentSettings, 'agent' | 'model'> | undefined;
  private result: ReviewResult | undefined;
  /** Counts the reviews started, so a replaced review's late answers are dropped. */
  private reviews = 0;
  /** True while a review's engine request is still out. */
  private running = false;

  constructor(
    tree: ReviewTreeProvider,
    treeView: vscode.TreeView<TreeNode>,
    copies: ChangeCopiesProvider,
    marker: PartMarker,
    deps: ExtensionDeps,
  ) {
    this.tree = tree;
    this.treeView = treeView;
    this.copies = copies;
    this.marker = marker;
    this.spawnEngine = deps.spawnEngine;
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
            void this.show(stage.result, shown);
            shown = true;
            this.treeView.message = groupingStatus(stage.result, stage.running);
          }),
      );
      if (!current()) return;
      await this.show(result, shown);
      this.treeView.message = groupingStatus(result);
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
   * Shows a result in the tree. The first result of a review reveals the
   * first section; a later one updates the tree in place and keeps the
   * reviewer's place, reselecting the part that now holds the selected
   * part's first hunk.
   */
  private async show(result: ReviewResult, update: boolean): Promise<void> {
    const selected = this.treeView.selection[0];
    const anchor =
      update && selected !== undefined && !isSection(selected) && selected.part !== undefined
        ? anchorOf(selected.part)
        : undefined;
    this.result = result;
    this.copies.setCopies(result.copies);
    this.tree.setSections(buildTree(result));
    if (!update) {
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

  private async engineReview(
    url: string,
    token: string,
    onStage: (stage: ReviewStageUpdate) => void,
  ): Promise<ReviewResult> {
    const chosen: Pick<AgentSettings, 'agent' | 'model'> = readAgentSettings();
    if (
      this.engine === undefined ||
      this.engineAgent?.agent !== chosen.agent ||
      this.engineAgent?.model !== chosen.model
    ) {
      this.engine?.dispose();
      this.engineAgent = chosen;
      this.engine = new EngineClient(this.spawnEngine ?? (() => spawnEngineProcess(chosen)));
    }
    const engine = this.engine;
    if (!engine.initialized) {
      await engine.initialize();
    }
    return engine.review(url, token, onStage);
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
 * in the editor's multi-file diff, and the status bar entry that shows
 * the agent and model in use. Nothing here runs anything from the
 * workspace — the engine is started from the companion's own install and
 * only ever reads GitHub.
 *
 * Returns the review tree's data provider, so a test running in a real
 * editor can read the tree the command filled.
 */
export function activate(
  context: vscode.ExtensionContext,
  deps: ExtensionDeps = {},
): vscode.TreeDataProvider<TreeSection | TreePart> {
  const tree = new ReviewTreeProvider();
  const treeView = vscode.window.createTreeView(REVIEW_TREE_VIEW, {
    treeDataProvider: tree,
  });
  const copies = new ChangeCopiesProvider();
  const marker = new PartMarker();
  const session = new ReviewSession(tree, treeView, copies, marker, deps);
  const agentStatusBar = new AgentStatusBar(deps.env);
  agentStatusBar.refresh();
  context.subscriptions.push(
    treeView,
    marker,
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
  );
  return tree;
}

/** Runs at shutdown; the engine stops through the subscriptions activate recorded. */
export function deactivate(): void {
  // Nothing else to do: the engine process was pushed onto the
  // subscriptions when the session was created.
}
