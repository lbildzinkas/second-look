import * as vscode from 'vscode';
import { EngineClient, spawnEngineProcess, type SpawnEngine } from './engine-client.js';
import { buildTree, type TreePart, type TreeSection } from './tree.js';

/** The command a reviewer runs on a pull request URL. */
export const REVIEW_COMMAND = 'second-look.reviewPullRequest';

/** The tree view in the side bar that ranks the parts. */
export const REVIEW_TREE_VIEW = 'second-look.reviewTree';

/** The parts of the environment tests replace; production uses the real ones. */
export interface ExtensionDeps {
  /** Starts the engine process; tests start a fake engine instead. */
  spawnEngine?: SpawnEngine;
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
 * each part and the signals in its tooltip, and the noise last.
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
 */
class ReviewSession {
  private readonly tree: ReviewTreeProvider;
  private readonly treeView: vscode.TreeView<TreeNode>;
  private readonly spawnEngine: ExtensionDeps['spawnEngine'];
  private engine: EngineClient | undefined;

  constructor(
    tree: ReviewTreeProvider,
    treeView: vscode.TreeView<TreeNode>,
    deps: ExtensionDeps,
  ) {
    this.tree = tree;
    this.treeView = treeView;
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

    try {
      const result = await vscode.window.withProgress(
        { location: { viewId: REVIEW_TREE_VIEW }, title: 'Reading the pull request…' },
        () => this.engineReview(url.trim(), accessToken),
      );
      this.tree.setSections(buildTree(result));
      await this.revealFirstSection();
    } catch (error) {
      vscode.window.showErrorMessage(
        error instanceof Error ? error.message : String(error),
      );
    }
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
 * tree. Nothing here runs anything from the workspace — the engine is
 * started from the companion's own install and only ever reads GitHub.
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
  const session = new ReviewSession(tree, treeView, deps);
  context.subscriptions.push(
    treeView,
    { dispose: () => session.dispose() },
    vscode.commands.registerCommand(REVIEW_COMMAND, (url?: string) =>
      session.reviewPullRequest(url),
    ),
  );
  return tree;
}

/** Runs at shutdown; the engine stops through the subscriptions activate recorded. */
export function deactivate(): void {
  // Nothing else to do: the engine process was pushed onto the
  // subscriptions when the session was created.
}
