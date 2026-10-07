import * as vscode from 'vscode';
import {
  EngineClient,
  spawnEngineProcess,
  type ReviewStageUpdate,
  type SpawnEngine,
} from './engine-client.js';
import {
  ADD_COMMENT_COMMAND,
  ADD_DRAFT_COMMAND,
  COMMENT_ON_PART_COMMAND,
  DISCARD_COMMENT_COMMAND,
  DISCARD_DRAFT_COMMAND,
  DRAFT_COMMENT_COMMAND,
  FETCH_LIBRARY_COMMAND,
  FILTER_CHANGED_COMMAND,
  OPEN_ALL_PARTS_COMMAND,
  OPEN_LIBRARY_EVIDENCE_COMMAND,
  OPEN_OVERVIEW_COMMAND,
  OPEN_PART_COMMAND,
  REVIEW_COMMAND,
  REVIEW_TREE_VIEW,
  SUBMIT_REVIEW_COMMAND,
  WHY_THIS_MATTERS_COMMAND,
  askCommand,
} from './commands.js';
import { CHANGE_SCHEME, ChangeCopiesProvider, changeUri, libraryUri } from './change-copies.js';
import { openPartInDiffEditor, openWholeChangeInDiffEditor, PartMarker } from './diff-view.js';
import {
  anchorOf,
  buildTree,
  findAnchor,
  reviewBadge,
  treeMessage,
  pendingReviewSection,
  type TreeComment,
  type TreePart,
  type TreeSection,
} from './tree.js';
import { draftTarget, ReviewComments } from './comments.js';
import { escapeMarkdown, FindingThreads } from './findings.js';
import { isSubmitKind, SendReviewPage } from './send-page.js';
import { OverviewPanel } from './overview.js';
import { AgentStatusBar } from './agent-status.js';
import { readAgentSettings, reviewAgentChoice } from './agent-settings.js';
import {
  ASK_KINDS,
  ASKS,
  NO_MARKS,
  draftFinding,
  filesOfPart,
  isFindingRef,
  markedPart,
  parsePullRequestUrl,
  wholeFilesReviewed,
  type AskKind,
  type CommentSide,
  type LibraryFetchOffer,
  type Part,
  type PendingReview,
  type ReviewedMarks,
  type ReviewResult,
} from '@second-look/engine';

export {
  ADD_COMMENT_COMMAND,
  ADD_DRAFT_COMMAND,
  COMMENT_ON_PART_COMMAND,
  DISCARD_COMMENT_COMMAND,
  DISCARD_DRAFT_COMMAND,
  DRAFT_COMMENT_COMMAND,
  FETCH_LIBRARY_COMMAND,
  FILTER_CHANGED_COMMAND,
  OPEN_ALL_PARTS_COMMAND,
  OPEN_LIBRARY_EVIDENCE_COMMAND,
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

/** The library fetch a claim of the result offers and the reviewer has not pressed yet, by the claim's index. */
function libraryFetchOf(result: ReviewResult | undefined, index: number): LibraryFetchOffer | undefined {
  const verdict = result?.claims?.claims[index]?.verdict;
  return verdict === undefined || verdict.kind === 'not checked' || verdict.library !== undefined ? undefined : verdict.libraryFetch;
}

/** Whether a value is a comment the editor handed a command, such as a draft as the reviewer edited it. */
function isEditorComment(value: unknown): value is vscode.Comment {
  return typeof value === 'object' && value !== null && 'body' in value && 'mode' in value;
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
 * the diff editor, and its checkbox marks it reviewed.
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
      item.checkboxState =
        node.reviewed === 'reviewed' ? vscode.TreeItemCheckboxState.Checked : vscode.TreeItemCheckboxState.Unchecked;
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
 * tree, and follows every stage, as do the findings — the refuted and
 * unverifiable claims — shown as the companion's own threads on the diff.
 *
 * Each part's checkbox marks it reviewed in the engine's local store for
 * the pull request, which outlives the editor; the tree view's badge
 * counts the parts left, and a part whose content changed since it was
 * marked is unmarked and says so. With the opt-in mirror setting on, a
 * file whose every part is reviewed is marked "Viewed" on GitHub too.
 *
 * The line above the tree says which commit the reviewer's last look was
 * at and how many parts changed since, each flagged in the tree, and the
 * filter shows only those parts.
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
  /** The review's overview: the story, the acceptance criteria, the claims, the description and who made each result. */
  private readonly overview = new OverviewPanel(
    (part) => void this.openPart(part),
    (path, line, side) => void this.openLine(path, line, side),
    (finding) => void this.draftComment(finding),
  );
  /** The review's findings, its refuted and unverifiable claims, as threads on the diff. */
  private readonly findings = new FindingThreads();
  /** The reviewed marks the engine's local store holds, with the pull request they belong to. */
  private stored: { url: string; marks: ReviewedMarks } | undefined;
  /** The files of parts marked while the review still runs, mirrored to GitHub once it finishes. */
  private readonly mirrorWaiting = new Set<string>();
  /** True while the tree shows only the parts changed since the reviewer's last look. */
  private onlyChanged = false;
  /** The stage the review is still running, in words, for the line above the tree. */
  private stage: string | undefined;

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
    // The marks are read while the engine reviews, and the review finishes
    // only once they are in.
    let marksRead: Promise<void> = Promise.resolve();
    this.running = true;
    this.treeView.message = undefined;
    try {
      const result = await vscode.window.withProgress(
        { location: { viewId: REVIEW_TREE_VIEW }, title: 'Reading the pull request…' },
        () =>
          this.engineReview(
            url.trim(),
            accessToken,
            (stage) => {
              if (!current()) return;
              this.stage = stage.running;
              void this.show(stage.result, shown, stage.running);
              shown = true;
            },
            (engine) => (marksRead = this.readMarks(engine, review, url.trim())),
          ),
      );
      if (!current()) return;
      this.stage = undefined;
      await this.show(result, shown);
      await marksRead;
      if (!current()) return;
      this.running = false;
      await this.mirrorViewed();
    } catch (error) {
      if (!current()) return;
      this.stage = undefined;
      this.treeView.message = undefined;
      vscode.window.showErrorMessage(
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      await marksRead;
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
    const previous = this.url;
    this.url = result.pullRequest.url;
    this.copies.setCopies(result.copies);
    this.copies.setLibraries(result);
    // A review's first result starts its pending review afresh — its Send
    // review page closes with the review it belonged to — and a later
    // stage of the same review keeps every comment already written, whose
    // lines and files the regrouping does not change.
    if (!update) {
      this.page?.dispose();
      this.page = undefined;
      this.comments.setReview(result);
      this.mirrorWaiting.clear();
      this.overview.clearAnswers();
      if (previous !== result.pullRequest.url) this.onlyChanged = false;
    }
    this.render();
    this.overview.update(result, running);
    this.findings.show(result);
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
      ...buildTree(this.result, this.marks(), { onlyChangedSinceLastLook: this.onlyChanged }),
    ];
  }

  /**
   * Shows the tree's sections, the line above them — what changed since
   * the last look and the stage still running — and the badge counting
   * the parts left to review.
   */
  private render(): void {
    this.tree.setSections(this.sections());
    if (this.result === undefined) return;
    this.treeView.message = treeMessage(this.result, this.stage, { onlyChangedSinceLastLook: this.onlyChanged });
    this.treeView.badge = reviewBadge(this.result, this.marks());
  }

  /**
   * Toggles the tree between every part and only the parts changed since
   * the reviewer's last look; a first look has nothing to filter.
   */
  filterChanged(): void {
    if (this.result === undefined) {
      vscode.window.showWarningMessage('Review a pull request first, then filter its parts.');
      return;
    }
    if (this.result.sinceLastLook === undefined) {
      vscode.window.showInformationMessage('This is your first look at this pull request, so no part changed since.');
      return;
    }
    this.onlyChanged = !this.onlyChanged;
    this.render();
  }

  /** The reviewed marks of the pull request shown; none until the store's are read. */
  private marks(): ReviewedMarks {
    const shown = this.result === undefined ? null : parsePullRequestUrl(this.result.pullRequest.url);
    const stored = this.stored === undefined ? null : parsePullRequestUrl(this.stored.url);
    const same =
      shown !== null &&
      stored !== null &&
      shown.owner === stored.owner &&
      shown.repo === stored.repo &&
      shown.number === stored.number;
    return same ? this.stored!.marks : NO_MARKS;
  }

  /** Rebuilds the tree's sections after the pending review or the marks changed. */
  private refreshTree(): void {
    if (this.result !== undefined) {
      this.render();
    }
  }

  /**
   * Reads the pull request's reviewed marks from the engine's local store,
   * for the review that asked; a failure only warns, and the parts show
   * unmarked.
   */
  private async readMarks(engine: EngineClient, review: number, url: string): Promise<void> {
    try {
      const marks = await engine.reviewedMarks(url);
      if (review !== this.reviews) return;
      this.stored = { url, marks };
      this.refreshTree();
    } catch (error) {
      if (review !== this.reviews) return;
      vscode.window.showWarningMessage(
        `The reviewed marks could not be read: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Ticks or clears the reviewed checkboxes the reviewer changed, one part
   * at a time, in the engine's local store, then shows the marks as they
   * now stand and mirrors the whole files they complete when the setting
   * asks for it. A review started meanwhile keeps its own marks.
   */
  async markParts(changes: readonly (readonly [TreeNode, vscode.TreeItemCheckboxState])[]): Promise<void> {
    const url = this.url;
    if (url === undefined) return;
    const review = this.reviews;
    try {
      const engine = await this.readyEngine();
      for (const [node, state] of changes) {
        if (isSection(node) || node.kind === 'comment' || node.part === undefined) continue;
        const reviewed = state === vscode.TreeItemCheckboxState.Checked;
        const marks = await engine.markReviewed(url, markedPart(node.part), reviewed);
        if (review !== this.reviews) return;
        this.stored = { url, marks };
        if (reviewed) for (const file of filesOfPart(node.part)) this.mirrorWaiting.add(file.path);
      }
    } catch (error) {
      if (review === this.reviews) {
        vscode.window.showErrorMessage(
          `The reviewed mark was not saved: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    if (review !== this.reviews) return;
    this.refreshTree();
    await this.mirrorViewed();
  }

  /**
   * Marks "Viewed" on GitHub the files of the parts just marked whose
   * every part is now reviewed — only with the opt-in mirror setting on,
   * off by default because the GitHub Pull Requests extension syncs the
   * same field, and only once the review finished, so the engine checks
   * every file against the parts it holds. A file only partly reviewed is
   * never marked, and nothing is unmarked.
   */
  private async mirrorViewed(): Promise<void> {
    if (!vscode.workspace.getConfiguration('second-look').get<boolean>('mirrorViewedToGitHub', false)) {
      this.mirrorWaiting.clear();
      return;
    }
    if (this.running || this.result === undefined || this.url === undefined) return;
    const paths = wholeFilesReviewed(this.result.parts, this.marks(), [...this.mirrorWaiting]);
    this.mirrorWaiting.clear();
    if (paths.length === 0) return;
    const url = this.url;
    let session: vscode.AuthenticationSession | undefined;
    try {
      session = await vscode.authentication.getSession('github', ['repo'], { createIfNone: false });
    } catch {
      session = undefined;
    }
    if (!session) {
      vscode.window.showWarningMessage('Sign in to GitHub to mark reviewed files "Viewed" there.');
      return;
    }
    try {
      await (await this.readyEngine()).markViewed(url, session.accessToken, paths);
    } catch (error) {
      vscode.window.showErrorMessage(
        `The reviewed files were not marked "Viewed" on GitHub: ${error instanceof Error ? error.message : String(error)}`,
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

  /**
   * Presses one finding's library fetch, the claim named by its index in
   * the result's claims: the engine downloads the library the offer names
   * — the exact file the project pins, or the tag the agent named —
   * checks its hash where one is recorded, unpacks it read-only and has
   * the agent the settings pick judge the claim again, and the result it
   * answers with replaces the one shown, keeping the reviewer's place.
   * A .NET library with no exact source comes back offering to decompile
   * it, or saying why not, and pressing that offer decompiles it.
   * Nothing is fetched or decompiled without this press (ADR 0003).
   */
  async fetchLibrary(arg?: unknown): Promise<void> {
    const offer = typeof arg === 'number' ? libraryFetchOf(this.result, arg) : undefined;
    if (offer === undefined || this.url === undefined) {
      vscode.window.showWarningMessage('This finding offers no library fetch; review the pull request again.');
      return;
    }
    const review = this.reviews;
    try {
      const result = await vscode.window.withProgress(
        { location: { viewId: REVIEW_TREE_VIEW }, title: `${offer.decompile === undefined ? 'Fetching' : 'Decompiling'} ${offer.library} ${offer.pinnedVersion} and checking the claim again…` },
        async () => (await this.readyEngine()).fetchLibrary(this.url!, arg as number, reviewAgentChoice(readAgentSettings())),
      );
      // A review started meanwhile replaces this one, fetch and all.
      if (review !== this.reviews) return;
      await this.show(result, true);
      const verdict = result.claims?.claims[arg as number]?.verdict;
      if (verdict !== undefined && verdict.kind !== 'not checked' && verdict.library === undefined) {
        vscode.window.showInformationMessage(`${offer.library} ${offer.pinnedVersion} has no exact source; its finding says whether it can be decompiled.`);
      }
    } catch (error) {
      vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
    }
  }

  /**
   * Drafts a comment from one finding, the reviewer having asked for it:
   * the engine has the agent the settings pick write a short draft from
   * the finding and its evidence, checked before it arrives. A draft from
   * a claim or an unexplained part opens in a thread of its own on the
   * diff, its text open for editing, with the buttons that add it to the
   * pending review or discard it. A draft from a finding on the whole
   * pull request — a described change the diff does not contain, or an
   * unmet acceptance criterion — opens for editing in an input box, and
   * joins the overall comment of the Send review page only when the
   * reviewer accepts it. Nothing is sent on its own (ADR 0002).
   */
  async draftComment(arg?: unknown): Promise<void> {
    const ref = isFindingRef(arg) ? { kind: arg.kind, index: arg.index } : undefined;
    const finding = ref === undefined || this.result === undefined ? undefined : draftFinding(this.result, ref);
    if (ref === undefined || finding === undefined || this.url === undefined) {
      vscode.window.showWarningMessage('This finding cannot be drafted from; review the pull request again.');
      return;
    }
    const review = this.reviews;
    try {
      const draft = await vscode.window.withProgress(
        { location: { viewId: REVIEW_TREE_VIEW }, title: `Drafting a comment from the ${finding.kind}…` },
        async () => (await this.readyEngine()).draftComment(this.url!, ref, reviewAgentChoice(readAgentSettings())),
      );
      // A review started meanwhile replaces this one, drafts and all.
      if (review !== this.reviews || this.result === undefined) return;
      if (draftFinding(this.result, ref)?.statement !== draft.statement) {
        vscode.window.showWarningMessage('The review changed while the comment was drafted; draft it again.');
        return;
      }
      const target = draftTarget(this.result, ref);
      // The draft quotes the pull request's own words, so it shows and
      // sends escaped, the way every agent-derived text does.
      if (target !== undefined) {
        this.comments.draft(target, escapeMarkdown(draft.body), finding.kind);
        return;
      }
      const edited = await vscode.window.showInputBox({
        title: `Draft comment from the ${finding.kind}`,
        prompt: 'Edit the draft, then press Enter to add it to the overall comment, or Escape to discard it. Nothing is sent until you submit the review.',
        value: escapeMarkdown(draft.body),
        ignoreFocusOut: true,
      });
      if (edited === undefined || edited.trim() === '') return;
      // A review started while the box was open replaces this one.
      if (review !== this.reviews) {
        vscode.window.showWarningMessage('The review changed while you edited the draft; draft it again.');
        return;
      }
      if (!this.sendPage().addToOverall(edited.trim())) {
        vscode.window.showWarningMessage('The review is being sent: try again once it finishes.');
        return;
      }
      this.sendPage().open();
    } catch (error) {
      vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
    }
  }

  /** Adds a draft, as the reviewer edited it, to the pending review. */
  addDraft(comment: vscode.Comment): void {
    this.comments.addDraft(comment);
  }

  /** Discards a draft, thread and all. */
  discardDraft(comment: vscode.Comment): void {
    this.comments.discardDraft(comment);
  }

  /** Opens one file a verdict cites in a fetched library's source, read-only, at the cited line. */
  async openLibraryEvidence(claimArg?: unknown, citationArg?: unknown): Promise<void> {
    const claim = typeof claimArg === 'number' ? this.result?.claims?.claims[claimArg] : undefined;
    const verdict = claim?.verdict.kind === 'not checked' ? undefined : claim?.verdict;
    const cited = typeof citationArg === 'number' ? verdict?.evidence[citationArg] : undefined;
    if (verdict?.library === undefined || cited === undefined) {
      vscode.window.showWarningMessage('This finding cites no fetched library file.');
      return;
    }
    const line = cited.line - 1;
    await vscode.commands.executeCommand('vscode.open', libraryUri(verdict.library, cited.path), {
      selection: new vscode.Range(line, 0, line, 0),
      preview: true,
    });
  }

  /**
   * Opens one line of the read-only head or base copy, such as the code
   * or a test a criterion's verdict cites, or a line an answer cites; a
   * base line of a renamed file opens at the file's old path.
   */
  async openLine(path: string, line: number, side: CommentSide): Promise<void> {
    const result = this.result;
    if (result === undefined) return;
    const at = line - 1;
    const file = side === 'base' ? result.parts.flatMap(filesOfPart).find((each) => each.path === path) : undefined;
    const uri = changeUri(side, result.copies[side].commit, file?.previousPath ?? path);
    await vscode.commands.executeCommand('vscode.open', uri, {
      selection: new vscode.Range(at, 0, at, 0),
      preview: true,
    });
  }

  /**
   * Makes one ask about a part, the reviewer having picked it from the
   * part's context menu: the engine has the agent the settings pick answer
   * about the part of its latest review, checked before it arrives, and
   * the overview shows the answer with its stamp. The tree passes its
   * element, so the part is read out of whatever the argument carries,
   * and found in the result shown by where it starts.
   */
  async ask(kind: AskKind, arg?: unknown): Promise<void> {
    const part = carriedPart(arg);
    const anchor = part === undefined ? undefined : JSON.stringify(anchorOf(part));
    const index = this.result?.parts.findIndex((each) => JSON.stringify(anchorOf(each)) === anchor) ?? -1;
    if (this.result === undefined || this.url === undefined || index < 0) {
      vscode.window.showWarningMessage('Review a pull request first, then ask about its parts.');
      return;
    }
    const review = this.reviews;
    const asked = this.result.parts[index]!;
    try {
      const answer = await vscode.window.withProgress(
        { location: { viewId: REVIEW_TREE_VIEW }, title: `${ASKS[kind].title}: asking the agent…` },
        async () => (await this.readyEngine()).ask(this.url!, kind, index, reviewAgentChoice(readAgentSettings())),
      );
      // A review started meanwhile replaces this one, asks and all.
      if (review !== this.reviews || this.result === undefined) return;
      if (answer.partName !== (asked.name ?? asked.path)) {
        vscode.window.showWarningMessage('The review changed while the agent answered; ask again.');
        return;
      }
      this.overview.answer(answer);
    } catch (error) {
      vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
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
    this.sendPage().open();
  }

  /** The Send review page of the review under way, made when first needed. */
  private sendPage(): SendReviewPage {
    this.page ??= new SendReviewPage({
      comments: this.comments,
      send: (review) => this.sendPending(review),
    });
    return this.page;
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

  /**
   * Sends the review request, then hands the engine over for the request
   * that reads the pull request's reviewed marks, so they arrive alongside.
   */
  private async engineReview(
    url: string,
    token: string,
    onStage: (stage: ReviewStageUpdate) => void,
    onSent: (engine: EngineClient) => void,
  ): Promise<ReviewResult> {
    const engine = await this.readyEngine();
    // The heading the acceptance criteria checklist sits under travels
    // with the request like the agent choice, so a settings change
    // reaches the next review without restarting the engine; empty leaves
    // the engine's default heading, "Acceptance criteria".
    const heading = vscode.workspace
      .getConfiguration('second-look')
      .get<string>('criteriaHeading', '')
      .trim();
    const reviewed = engine.review(url, token, reviewAgentChoice(readAgentSettings()), onStage, heading);
    onSent(engine);
    return reviewed;
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
    this.findings.dispose();
  }
}

/**
 * Activates the companion: registers the review command and the review
 * tree, the read-only file system that serves the change's copies, the
 * commands that open a part — or the whole change, in ranked order —
 * in the editor's multi-file diff, the comment threads the reviewer
 * writes the pending review in, the command that submits it to GitHub,
 * the commands that open the review's overview — at the story's start, or
 * at one part as its "why this matters" — the commands that draft a
 * comment from a finding and add the draft to the pending review or
 * discard it, one command for each ask a part's context menu offers,
 * whose answer the overview shows, the parts' reviewed checkboxes, and the status bar entry
 * that shows the agent and model in use.
 * Nothing here runs anything from the workspace — the engine is started
 * from the companion's own install, reads GitHub, and writes only the
 * one review the reviewer sends — and, only with the opt-in mirror
 * setting on, the "Viewed" mark of each file whose every part they
 * reviewed.
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
    // A part's checkbox is its own: a section has none to tick it with.
    manageCheckboxStateManually: true,
  });
  const copies = new ChangeCopiesProvider();
  const marker = new PartMarker();
  const comments = new ReviewComments();
  const session = new ReviewSession(tree, treeView, copies, marker, comments, deps);
  const agentStatusBar = new AgentStatusBar(deps.env);
  agentStatusBar.refresh();
  context.subscriptions.push(
    treeView,
    treeView.onDidChangeCheckboxState((event) => void session.markParts(event.items)),
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
    vscode.commands.registerCommand(FILTER_CHANGED_COMMAND, () => session.filterChanged()),
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
    vscode.commands.registerCommand(FETCH_LIBRARY_COMMAND, (arg?: unknown) => session.fetchLibrary(arg)),
    vscode.commands.registerCommand(OPEN_LIBRARY_EVIDENCE_COMMAND, (claim?: unknown, citation?: unknown) =>
      session.openLibraryEvidence(claim, citation),
    ),
    vscode.commands.registerCommand(DRAFT_COMMENT_COMMAND, (finding?: unknown) => session.draftComment(finding)),
    vscode.commands.registerCommand(ADD_DRAFT_COMMAND, (comment?: unknown) =>
      isEditorComment(comment) ? session.addDraft(comment) : undefined,
    ),
    vscode.commands.registerCommand(DISCARD_DRAFT_COMMAND, (comment?: unknown) =>
      isEditorComment(comment) ? session.discardDraft(comment) : undefined,
    ),
    ...ASK_KINDS.map((kind) => vscode.commands.registerCommand(askCommand(kind), (arg?: unknown) => session.ask(kind, arg))),
  );
  return tree;
}

/** Runs at shutdown; the engine stops through the subscriptions activate recorded. */
export function deactivate(): void {
  // Nothing else to do: the engine process was pushed onto the
  // subscriptions when the session was created.
}
