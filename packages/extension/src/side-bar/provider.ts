import * as vscode from 'vscode';
import { randomUUID } from 'node:crypto';
import { ASK_KINDS, ASKS, findingAnchor, isFindingRef, type FindingRef } from '@second-look/engine';
import {
  COMMENT_ON_PART_COMMAND,
  DRAFT_COMMENT_COMMAND,
  FETCH_LIBRARY_COMMAND,
  FILTER_CHANGED_COMMAND,
  MARK_REVIEWED_COMMAND,
  OPEN_ALL_PARTS_COMMAND,
  OPEN_LIBRARY_EVIDENCE_COMMAND,
  OPEN_OVERVIEW_COMMAND,
  OPEN_PART_COMMAND,
  OPEN_SETTINGS_COMMAND,
  REVIEW_COMMAND,
  SUBMIT_REVIEW_COMMAND,
  WHY_THIS_MATTERS_COMMAND,
  askCommand,
} from '../commands.js';
import { isBannerPartRef } from '../part-banner.js';
import { partAtAnchor, anchorOf, type PartAnchor } from '../tree.js';
import { COMMENT_ACTIONS, FINDING_ACTIONS, PART_MENUS, sideBarBody, sideBarHtml, type CommentAction, type FindingAction, type PartMenu, type SideBarButton } from './page.js';
import type { PullRequestPicker } from './pull-request-picker.js';
import { pullRequestMessage, waitingBadge, type PullRequestMessage } from './pull-requests.js';
import { setupMessage, type SetupMessage } from './setup.js';
import type { SetupForm } from './setup-form.js';
import { StepTickStore, type StepTick } from './step-ticks.js';
import { nextPartToReview, sideBarSteps, type SideBarState } from './steps.js';

/** The existing command each card button runs, beside the ones that need a part or an argument. */
const BUTTON_COMMANDS: Record<Exclude<SideBarButton, 'nextPart' | 'criteriaHeading' | 'partsMenu' | 'openSent'>, string> = {
  review: REVIEW_COMMAND,
  overview: OPEN_OVERVIEW_COMMAND,
  allParts: OPEN_ALL_PARTS_COMMAND,
  filterChanged: FILTER_CHANGED_COMMAND,
  send: SUBMIT_REVIEW_COMMAND,
  verifyClaim: askCommand('verify'),
};

/** The buttons the provider answers itself, beside the ones that run a command. */
const OWN_BUTTONS: readonly SideBarButton[] = ['nextPart', 'criteriaHeading', 'partsMenu', 'openSent'];

/** What a part row's menus offer: each item's label and the command it runs with the part. */
const PART_MENU_ITEMS: Record<PartMenu, readonly { label: string; command: string }[]> = {
  ask: ASK_KINDS.map((kind) => ({ label: ASKS[kind].title, command: askCommand(kind) })),
  more: [
    { label: 'Comment on this part…', command: COMMENT_ON_PART_COMMAND },
    { label: 'Why this matters', command: WHY_THIS_MATTERS_COMMAND },
  ],
};

/** The setting step 4's ⋯ menu toggles. */
const MIRROR_SETTING = 'mirrorViewedToGitHub';

/** What the side bar needs beyond its own commands: opening a finding's line in the read-only head copy, the store that keeps the steps' ticks, and step 7's presses on the pending review. */
export interface SideBarDeps {
  /** Opens a line of the read-only head copy, the same opening the overview's chips do. */
  openLine(path: string, line: number): void;
  /** Opens the overview at the description line or story sentence a claim's where names, marked. */
  openOverviewAt(options: { descriptionLine?: number; storySentence?: number }): void;
  /** The store that keeps the steps' “I've checked these” ticks, per pull request. */
  ticks: StepTickStore;
  /** Opens a pending comment's or a draft's thread, or discards or adds it, as step 7's rows press. */
  comment(id: number, action: CommentAction): void;
}

/** A press the reviewer makes in the side bar, as its script reports it. */
export type SideBarMessage =
  | { type: 'ready' }
  | { type: 'command'; command: SideBarButton }
  | { type: 'openPart'; anchor: PartAnchor }
  | { type: 'mark'; anchor: PartAnchor; reviewed: boolean }
  | { type: 'finding'; action: FindingAction; finding: FindingRef }
  | { type: 'claimWhere'; claim: number }
  | { type: 'claimEvidence'; claim: number; index: number }
  | { type: 'openIssue'; issue: number }
  | { type: 'tick'; step: StepTick; checked: boolean }
  | { type: 'partMenu'; menu: PartMenu; anchor: PartAnchor }
  | { type: 'comment'; action: CommentAction; id: number }
  | SetupMessage
  | PullRequestMessage;

/** Reads a side-bar message out of what the webview delivered, if it is one. */
export function sideBarMessage(value: unknown): SideBarMessage | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const { type, command, anchor, reviewed, action, kind, index, issue, step, checked, menu, id, claim } = value as Record<string, unknown>;
  if (type === 'ready') return { type };
  if (type === 'setup') return setupMessage(value);
  if (type === 'pullRequests') return pullRequestMessage(value);
  if (type === 'command' && typeof command === 'string' && ((OWN_BUTTONS as readonly string[]).includes(command) || Object.hasOwn(BUTTON_COMMANDS, command))) {
    return { type, command: command as SideBarButton };
  }
  if (type === 'claimWhere' && Number.isInteger(claim)) return { type, claim: claim as number };
  if (type === 'claimEvidence' && Number.isInteger(claim) && Number.isInteger(index)) return { type, claim: claim as number, index: index as number };
  const ref = { kind, index };
  if (type === 'finding' && (FINDING_ACTIONS as readonly string[]).includes(action as string) && isFindingRef(ref)) {
    return { type, action: action as FindingAction, finding: { kind: ref.kind, index: ref.index } };
  }
  if (type === 'openIssue' && Number.isInteger(issue)) return { type, issue: issue as number };
  if (type === 'tick' && (step === 'claims' || step === 'criteria') && typeof checked === 'boolean') {
    return { type, step, checked };
  }
  if (type === 'comment' && (COMMENT_ACTIONS as readonly string[]).includes(action as string) && Number.isInteger(id)) {
    return { type, action: action as CommentAction, id: id as number };
  }
  const part = { anchor };
  if (!isBannerPartRef(part)) return undefined;
  if (type === 'openPart') return { type, anchor: part.anchor };
  if (type === 'partMenu' && (PART_MENUS as readonly string[]).includes(menu as string)) return { type, menu: menu as PartMenu, anchor: part.anchor };
  if (type === 'mark' && typeof reviewed === 'boolean') return { type, anchor: part.anchor, reviewed };
  return undefined;
}

/**
 * The side bar (ADR 0008): one webview view carrying the review path's
 * eight step cards, drawn from the review session's state. Every press
 * runs an existing command — the reviewed checkbox through the same
 * mark-reviewed path as the part banner, the finding rows' actions the
 * same draft, fetch, evidence and ask commands the threads and the
 * overview offer, a part row's Ask… and ⋯ menus the commands its context
 * menu offers — so the Command Palette and the side bar act alike,
 * except step 1's setup form, whose changes and presses go to the form,
 * step 2's list, whose typing and presses go to the list, a finding's
 * Open, which opens its line in the read-only head copy the way the
 * overview's chips do, a claim's where, which opens the place it is
 * made — its file's line in the head copy, its description line in the
 * overview's description, or its sentence in the story — a claim's
 * cited lines, which open the head copy's line or, for a CI log, its
 * check run on GitHub, the one outside link, a linked issue, which opens on GitHub, and the
 * steps' “I've checked these” ticks, which the store keeps per pull
 * request, step 7's rows, which act on the pending comments and drafts,
 * step 4's ⋯, which toggles mirroring the reviewed marks to GitHub's
 * Viewed, and step 8's link to the review sent. The view's badge counts the parts left to review, and
 * before a review opens the pull requests waiting on the reviewer.
 */
export class SideBarProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined;

  private state: SideBarState;

  private badge: vscode.ViewBadge | undefined;

  /** Step 1's setup form, when the side bar carries one. */
  private readonly setup: SetupForm | undefined;

  /** Step 2's list of the reviewer's pull requests, when the side bar carries one. */
  private readonly picker: PullRequestPicker | undefined;

  /** What the side bar needs beyond its own commands, when it carries it. */
  private readonly deps: SideBarDeps | undefined;

  constructor(state: SideBarState, setup?: SetupForm, picker?: PullRequestPicker, deps?: SideBarDeps) {
    this.state = state;
    this.setup = setup;
    this.picker = picker;
    this.deps = deps;
  }

  /** What the side bar shows now, step 1's setup form, step 2's list and the steps' ticks included. */
  get current(): SideBarState {
    const { result } = this.state;
    return {
      ...this.state,
      ...(result !== undefined && this.deps !== undefined ? { ticks: this.deps.ticks.read(result.pullRequest.url, result.pullRequest.headSha) } : {}),
      ...(this.setup !== undefined ? { setup: this.setup.current } : {}),
      ...(this.picker !== undefined ? { pullRequests: this.picker.current } : {}),
    };
  }

  /** The badge: the parts left while a review is open, else the pull requests waiting on the reviewer. */
  private get shownBadge(): vscode.ViewBadge | undefined {
    if (this.state.result !== undefined || this.picker === undefined) return this.badge;
    return waitingBadge(this.picker.current);
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true, enableCommandUris: false, localResourceRoots: [] };
    view.webview.html = sideBarHtml(randomUUID(), sideBarBody(this.current));
    view.webview.onDidReceiveMessage((message) => this.handle(message));
    view.onDidDispose(() => {
      if (this.view === view) this.view = undefined;
    });
    view.badge = this.shownBadge;
    this.setup?.shown();
    this.showList();
  }

  /** Draws the side bar again, such as when step 1's setup form changed. */
  redraw(): void {
    this.post();
  }

  /** Shows the session as it now stands, with the badge counting the parts left. */
  update(state: SideBarState, badge: vscode.ViewBadge | undefined): void {
    this.state = state;
    this.badge = badge;
    this.post();
  }

  private post(): void {
    if (this.view === undefined) return;
    this.view.badge = this.shownBadge;
    void this.view.webview.postMessage({ type: 'render', body: sideBarBody(this.current) });
    this.showList();
  }

  /** Loads step 2's list once its card shows open, before any review. */
  private showList(): void {
    const current = this.current;
    if (this.picker === undefined || current.result !== undefined || current.reviewing || sideBarSteps(current)[1]?.open !== true) return;
    this.picker.shown();
  }

  private handle(value: unknown): void {
    const message = sideBarMessage(value);
    if (message === undefined) return;
    if (message.type === 'ready') {
      this.post();
      return;
    }
    if (message.type === 'setup') {
      this.setup?.handle(message).then(undefined, (error: unknown) => {
        void vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
      });
      return;
    }
    if (message.type === 'pullRequests') {
      this.picker?.handle(message).then(undefined, (error: unknown) => {
        void vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
      });
      return;
    }
    const { result, marks } = this.state;
    if (message.type === 'mark') {
      this.run(MARK_REVIEWED_COMMAND, { anchor: message.anchor }, message.reviewed);
      return;
    }
    if (message.type === 'openPart') {
      const part = result === undefined ? undefined : partAtAnchor(result.parts, message.anchor);
      if (part !== undefined) this.run(OPEN_PART_COMMAND, part);
      return;
    }
    if (message.type === 'openIssue') {
      const issue = result?.criteria?.issues[message.issue];
      if (issue !== undefined && issue.url.startsWith('https://')) void vscode.env.openExternal(vscode.Uri.parse(issue.url));
      return;
    }
    if (message.type === 'finding') {
      this.finding(message.finding, message.action);
      return;
    }
    if (message.type === 'claimWhere') {
      const claim = result?.claims?.claims[message.claim];
      const { location } = claim ?? {};
      if (location?.kind === 'file') this.deps?.openLine(location.path, location.line);
      // A pull request description has no line anchors on GitHub, and the story lives only in the overview: both open there, marked.
      else if (location?.kind === 'description') this.deps?.openOverviewAt({ descriptionLine: location.line });
      else if (location?.kind === 'story') this.deps?.openOverviewAt({ storySentence: location.sentence });
      return;
    }
    if (message.type === 'claimEvidence') {
      const claim = result?.claims?.claims[message.claim];
      const verdict = claim === undefined || claim.verdict.kind === 'not checked' ? undefined : claim.verdict;
      const cited = verdict?.evidence[message.index];
      if (cited === undefined) return;
      if (cited.ciLog === true) {
        // The one outside link a row carries: the check run's own page on GitHub, opened only for a github.com address.
        const url = result?.ci?.checks.find((check) => check.name === cited.path)?.url;
        if (url !== undefined && url.startsWith('https://github.com/')) void vscode.env.openExternal(vscode.Uri.parse(url));
        return;
      }
      // A line of fetched library source is not a line of the head copy; the row shows it as text, so it never opens.
      if (verdict !== undefined && verdict.library === undefined) this.deps?.openLine(cited.path, cited.line);
      return;
    }
    if (message.type === 'comment') {
      this.deps?.comment(message.id, message.action);
      return;
    }
    if (message.type === 'partMenu') {
      const part = result === undefined ? undefined : partAtAnchor(result.parts, message.anchor);
      if (part !== undefined) void this.partMenu(message.menu, part.name ?? part.path, message.anchor);
      return;
    }
    if (message.type === 'tick') {
      if (result === undefined || this.deps === undefined) return;
      this.deps.ticks.check(result.pullRequest.url, result.pullRequest.headSha, message.step, message.checked).then(
        () => this.post(),
        (error: unknown) => {
          void vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
        },
      );
      return;
    }
    if (message.command === 'criteriaHeading') {
      this.run(OPEN_SETTINGS_COMMAND, '@id:second-look.criteriaHeading');
      return;
    }
    if (message.command === 'partsMenu') {
      void this.toggleMirror();
      return;
    }
    if (message.command === 'openSent') {
      const url = this.state.sent?.url;
      if (url !== undefined && url.startsWith('https://')) void vscode.env.openExternal(vscode.Uri.parse(url));
      return;
    }
    if (message.command === 'nextPart') {
      const part = result === undefined ? undefined : nextPartToReview(result, marks);
      if (part !== undefined) this.run(OPEN_PART_COMMAND, part);
      return;
    }
    this.run(BUTTON_COMMANDS[message.command]);
  }

  /**
   * Runs the existing command for one action on a finding the cards
   * list: drafting a comment from it, verifying its claim again through
   * the verify ask, pressing its library fetch — which downloads only
   * when pressed — or opening its line read-only, its cited library file,
   * or the part its thread sits on.
   */
  private finding(finding: FindingRef, action: FindingAction): void {
    const { result } = this.state;
    if (result === undefined) return;
    if (action === 'draft') {
      this.run(DRAFT_COMMENT_COMMAND, finding);
      return;
    }
    const claim = finding.kind === 'claim' ? result.claims?.claims[finding.index] : undefined;
    if (claim !== undefined && action === 'fetch') {
      this.run(FETCH_LIBRARY_COMMAND, finding.index);
      return;
    }
    if (claim !== undefined && action === 'verify') {
      const part = result.parts[claim.part];
      if (part !== undefined) this.run(askCommand('verify'), { anchor: anchorOf(part), claim: finding.index });
      return;
    }
    if (action !== 'open') return;
    if (claim !== undefined) {
      // The finding's thread sits on this line: the head copy's, read-only.
      const line = findingAnchor(claim, result.parts);
      if (line !== undefined) {
        this.deps?.openLine(line.path, line.line);
        return;
      }
      const verdict = claim.verdict.kind === 'not checked' ? undefined : claim.verdict;
      if (verdict?.library !== undefined && verdict.evidence.length > 0) {
        this.run(OPEN_LIBRARY_EVIDENCE_COMMAND, finding.index, 0);
        return;
      }
      const part = result.parts[claim.part];
      if (part !== undefined) this.run(OPEN_PART_COMMAND, part);
      return;
    }
    if (finding.kind === 'unexplained part') {
      const entry = result.unexplained?.parts[finding.index];
      const part = entry === undefined ? undefined : result.parts[entry.part];
      if (part !== undefined) this.run(OPEN_PART_COMMAND, part);
    }
  }

  /** Offers a part row's menu as a quick pick, and runs the picked item's command with the part, as its context menu does. */
  private async partMenu(menu: PartMenu, name: string, anchor: PartAnchor): Promise<void> {
    const items = PART_MENU_ITEMS[menu];
    const title = menu === 'ask' ? `Ask about ${name}` : name;
    const picked = await vscode.window.showQuickPick(
      items.map((item) => ({ label: item.label })),
      { title },
    );
    const item = items.find((each) => each.label === picked?.label);
    if (item !== undefined) this.run(item.command, { anchor });
  }

  /**
   * Step 4's ⋯ menu: one item that says whether the reviewed marks are
   * mirrored to GitHub's Viewed, and picking it turns the setting the
   * other way, where it is set — the workspace's, when it sets one.
   */
  private async toggleMirror(): Promise<void> {
    const settings = vscode.workspace.getConfiguration('second-look');
    const on = settings.get<boolean>(MIRROR_SETTING, false);
    const picked = await vscode.window.showQuickPick(
      [{ label: `${on ? '$(check) ' : ''}Mirror reviewed files to GitHub’s Viewed`, description: on ? 'on: pick to turn off' : 'off: pick to turn on' }],
      { title: 'Review the parts' },
    );
    if (picked === undefined) return;
    const target = settings.inspect(MIRROR_SETTING)?.workspaceValue === undefined ? vscode.ConfigurationTarget.Global : vscode.ConfigurationTarget.Workspace;
    settings.update(MIRROR_SETTING, !on, target).then(undefined, (error: unknown) => {
      void vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
    });
  }

  private run(command: string, ...args: unknown[]): void {
    vscode.commands.executeCommand(command, ...args).then(undefined, (error: unknown) => {
      void vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
    });
  }
}
