import * as vscode from 'vscode';
import { randomUUID } from 'node:crypto';
import {
  MARK_REVIEWED_COMMAND,
  OPEN_ALL_PARTS_COMMAND,
  OPEN_OVERVIEW_COMMAND,
  OPEN_PART_COMMAND,
  REVIEW_COMMAND,
  SUBMIT_REVIEW_COMMAND,
} from '../commands.js';
import { isBannerPartRef } from '../part-banner.js';
import { partAtAnchor, type PartAnchor } from '../tree.js';
import { sideBarBody, sideBarHtml, type SideBarButton } from './page.js';
import { nextPartToReview, type SideBarState } from './steps.js';

/** The existing command each card button runs, beside the ones that need a part. */
const BUTTON_COMMANDS: Record<Exclude<SideBarButton, 'nextPart'>, string> = {
  review: REVIEW_COMMAND,
  overview: OPEN_OVERVIEW_COMMAND,
  allParts: OPEN_ALL_PARTS_COMMAND,
  send: SUBMIT_REVIEW_COMMAND,
};

/** A press the reviewer makes in the side bar, as its script reports it. */
export type SideBarMessage =
  | { type: 'ready' }
  | { type: 'command'; command: SideBarButton }
  | { type: 'openPart'; anchor: PartAnchor }
  | { type: 'mark'; anchor: PartAnchor; reviewed: boolean };

/** Reads a side-bar message out of what the webview delivered, if it is one. */
export function sideBarMessage(value: unknown): SideBarMessage | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const { type, command, anchor, reviewed } = value as Record<string, unknown>;
  if (type === 'ready') return { type };
  if (type === 'command' && (command === 'nextPart' || (typeof command === 'string' && Object.hasOwn(BUTTON_COMMANDS, command)))) {
    return { type, command: command as SideBarButton };
  }
  const ref = { anchor };
  if (!isBannerPartRef(ref)) return undefined;
  if (type === 'openPart') return { type, anchor: ref.anchor };
  if (type === 'mark' && typeof reviewed === 'boolean') return { type, anchor: ref.anchor, reviewed };
  return undefined;
}

/**
 * The side bar (ADR 0008): one webview view carrying the review path's
 * eight step cards, drawn from the review session's state. Every press
 * runs an existing command — the reviewed checkbox through the same
 * mark-reviewed path as the part banner — so the Command Palette and the
 * side bar act alike. The view's badge counts the parts left to review.
 */
export class SideBarProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined;

  private state: SideBarState;

  private badge: vscode.ViewBadge | undefined;

  constructor(state: SideBarState) {
    this.state = state;
  }

  /** What the side bar shows now. */
  get current(): SideBarState {
    return this.state;
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true, enableCommandUris: false, localResourceRoots: [] };
    view.webview.html = sideBarHtml(randomUUID(), sideBarBody(this.state));
    view.webview.onDidReceiveMessage((message) => this.handle(message));
    view.onDidDispose(() => {
      if (this.view === view) this.view = undefined;
    });
    view.badge = this.badge;
  }

  /** Shows the session as it now stands, with the badge counting the parts left. */
  update(state: SideBarState, badge: vscode.ViewBadge | undefined): void {
    this.state = state;
    this.badge = badge;
    if (this.view === undefined) return;
    this.view.badge = badge;
    this.post();
  }

  private post(): void {
    void this.view?.webview.postMessage({ type: 'render', body: sideBarBody(this.state) });
  }

  private handle(value: unknown): void {
    const message = sideBarMessage(value);
    if (message === undefined) return;
    if (message.type === 'ready') {
      this.post();
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
    if (message.command === 'nextPart') {
      const part = result === undefined ? undefined : nextPartToReview(result, marks);
      if (part !== undefined) this.run(OPEN_PART_COMMAND, part);
      return;
    }
    this.run(BUTTON_COMMANDS[message.command]);
  }

  private run(command: string, ...args: unknown[]): void {
    vscode.commands.executeCommand(command, ...args).then(undefined, (error: unknown) => {
      void vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
    });
  }
}
