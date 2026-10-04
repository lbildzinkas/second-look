import * as vscode from 'vscode';
import { randomUUID } from 'node:crypto';
import {
  hiddenContent,
  parsePullRequestUrl,
  type AgentStamp,
  type Claim,
  type ClaimSource,
  type HiddenKind,
  type Part,
  type ReviewResult,
  type Story,
} from '@second-look/engine';

/** The view type of the overview's one webview panel. */
export const OVERVIEW_VIEW_TYPE = 'second-look.overview' as const;

/** What the overview shows: a result, the stage still running, and the part the story is opened at. */
export interface OverviewState {
  result: ReviewResult;
  /** The stage still running, in words for the reviewer; absent once the review is done. */
  running?: string;
  /** The part the story is opened at, by its index in the result's parts. */
  focus?: number;
}

/** A move the reviewer makes on the page, as its script reports it. */
export interface OverviewMessage {
  type: 'openPart';
  /** The part, by its index in the result's parts. */
  part: number;
}

/** Reads a page message out of what the webview delivered, if it is one. */
function overviewMessage(value: unknown): OverviewMessage | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const { type, part } = value as Record<string, unknown>;
  return type === 'openPart' && Number.isInteger(part) ? { type, part: part as number } : undefined;
}

/**
 * The review's overview (issue #30), the tab at the top of the review in
 * the recorded design (docs/ux): the pull request's title and where it
 * comes from, a chip for each stage done and the one still running, the
 * story with its stamp, each part it mentions a button that opens the part
 * in the diff editor, the claims the change makes with where each is made
 * and the part it is attached to, the pull request's description in full
 * with its hidden content shown and flagged, and who made each result.
 *
 * Everything on the page but the companion's own words was written by
 * someone else, the agent's story and the claims' quotes included, so
 * every byte of it reaches the page as escaped text: no remote image, no
 * link and no markup of theirs renders, under a content security policy
 * that loads nothing but the page's own nonce-marked style and script.
 */
export class OverviewPanel implements vscode.Disposable {
  private panel: vscode.WebviewPanel | undefined;

  private state: OverviewState | undefined;

  private disposed = false;

  /** Opens a part the story links or a claim is attached to, in the diff editor. */
  private readonly openPart: (part: Part) => void;

  constructor(openPart: (part: Part) => void) {
    this.openPart = openPart;
  }

  /**
   * Shows a result, with the stage still running if one is: the page
   * updates when it is open. The story's place resets, since a regrouped
   * result numbers its parts afresh.
   */
  update(result: ReviewResult, running?: string): void {
    this.state = { result, ...(running !== undefined ? { running } : {}) };
    this.render();
  }

  /**
   * Opens the page, or brings it to the front, at the story's start or at
   * the first sentence that mentions one part. True when there was a
   * review to show.
   */
  open(options: { focus?: number; preserveFocus?: boolean } = {}): boolean {
    if (this.disposed || this.state === undefined) return false;
    const { result, running } = this.state;
    this.state = {
      result,
      ...(running !== undefined ? { running } : {}),
      ...(options.focus !== undefined ? { focus: options.focus } : {}),
    };
    if (this.panel === undefined) {
      const panel = vscode.window.createWebviewPanel(
        OVERVIEW_VIEW_TYPE,
        overviewTitle(this.state.result),
        { viewColumn: vscode.ViewColumn.Active, preserveFocus: options.preserveFocus ?? false },
        { enableScripts: true, enableCommandUris: false, localResourceRoots: [] },
      );
      this.panel = panel;
      panel.webview.onDidReceiveMessage((message) => this.handle(message));
      panel.onDidDispose(() => {
        if (this.panel === panel) this.panel = undefined;
      });
    } else {
      this.panel.reveal(undefined, options.preserveFocus ?? false);
    }
    this.render();
    return true;
  }

  /** The part a story or claim button names, opened in the diff editor. */
  private handle(value: unknown): void {
    const message = overviewMessage(value);
    const part = message === undefined ? undefined : this.state?.result.parts[message.part];
    if (part !== undefined) this.openPart(part);
  }

  private render(): void {
    if (this.panel === undefined || this.state === undefined) return;
    this.panel.title = overviewTitle(this.state.result);
    this.panel.webview.html = overviewHtml(this.state, randomUUID());
  }

  dispose(): void {
    this.disposed = true;
    this.panel?.dispose();
    this.panel = undefined;
  }
}

/** The overview tab's title, as the recorded design names it. */
export function overviewTitle(result: ReviewResult): string {
  return `Second Look: #${result.pullRequest.number} overview`;
}

/** Escapes text for HTML, so every character of it shows as text. */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** How the page names each kind of hidden content. */
const HIDDEN_LABELS: Record<HiddenKind, string> = {
  'html comment': 'hidden HTML comment',
  'tag characters': 'hidden tag characters, decoded',
  'zero-width characters': 'zero-width characters',
  'bidirectional controls': 'bidirectional controls',
};

/** Untrusted text as the page renders it, with how many hidden runs of each kind it holds. */
export interface SanitisedText {
  html: string;
  hidden: Partial<Record<HiddenKind, number>>;
}

/**
 * The sanitiser: untrusted text, such as a pull request's description, as
 * HTML that shows every character as text. Nothing in it renders as
 * markup — no image, no link, no element of its own — and each hidden run
 * GitHub would not show is made visible and flagged with its kind.
 */
export function sanitiseUntrusted(text: string): SanitisedText {
  const hidden: Partial<Record<HiddenKind, number>> = {};
  const html = hiddenContent(text)
    .map((piece) => {
      if (piece.hidden === undefined) return escapeHtml(piece.text);
      hidden[piece.hidden] = (hidden[piece.hidden] ?? 0) + 1;
      return (
        `<span class="hidden" data-kind="${escapeHtml(piece.hidden)}">` +
        `<span class="flag">${escapeHtml(HIDDEN_LABELS[piece.hidden])}</span>` +
        `<span class="shown">${escapeHtml(piece.shown)}</span></span>`
      );
    })
    .join('');
  return { html, hidden };
}

/** One count of hidden runs in words, such as `2 HTML comments`. */
function hiddenCount(kind: HiddenKind, count: number): string {
  const plural = count === 1 ? '' : 's';
  switch (kind) {
    case 'html comment':
      return `${count} HTML comment${plural}`;
    case 'tag characters':
      return `${count} run${plural} of tag characters`;
    case 'zero-width characters':
      return `${count} run${plural} of zero-width characters`;
    case 'bidirectional controls':
      return `${count} run${plural} of bidirectional controls`;
  }
}

/** The line above a description that holds hidden content: what GitHub hides, and what the agent read of it. */
function hiddenSummary(hidden: SanitisedText['hidden']): string {
  const kinds = Object.keys(hidden) as HiddenKind[];
  if (kinds.length === 0) return '';
  const counts = kinds.map((kind) => hiddenCount(kind, hidden[kind]!)).join(', ');
  return (
    `<p class="alert">This description holds content GitHub does not show: ${escapeHtml(counts)}. ` +
    'It is shown and flagged below. The agent read each HTML comment marked as hidden, and none of the invisible characters.</p>'
  );
}

/** Where the pull request comes from, on one line: repository and number, author, branches and head commit. */
function metaLine(result: ReviewResult): string {
  const { pullRequest } = result;
  const ref = parsePullRequestUrl(pullRequest.url);
  const where = ref ? `${ref.owner}/${ref.repo} #${pullRequest.number}` : `#${pullRequest.number}`;
  const author = pullRequest.author === '' ? [] : [pullRequest.author];
  return [where, ...author, `${pullRequest.head} → ${pullRequest.base}`, `head ${pullRequest.headSha.slice(0, 7)}`]
    .map(escapeHtml)
    .join(' · ');
}

/** A chip for each stage done, and one for the stage still running. */
function stageChips(state: OverviewState): string {
  const { result } = state;
  const chips: { text: string; done: boolean }[] = [
    { text: 'parts', done: true },
    { text: 'noise checks', done: true },
  ];
  const grouping = result.grouping.agent;
  if (grouping) chips.push({ text: grouping.outcome === 'grouped' ? 'grouped by the agent' : 'plain grouping kept', done: true });
  const ranking = result.ranking.agent;
  if (ranking) chips.push({ text: result.ranking.by === 'agent' ? 'ranked by the agent' : 'plain ranking kept', done: true });
  if (result.story) chips.push({ text: result.story.outcome === 'written' ? 'story' : 'no story', done: true });
  if (result.claims) chips.push({ text: result.claims.outcome === 'listed' ? 'claims' : 'no claims', done: true });
  if (state.running !== undefined) chips.push({ text: state.running, done: false });
  return chips
    .map((chip) => `<span class="stg ${chip.done ? 'done' : 'run'}">${escapeHtml(chip.text)}${chip.done ? '' : '…'}</span>`)
    .join('');
}

/** A result's stamp in the recorded design's words: agent · model · effort · prompt version. */
export function stampText(stamp: AgentStamp, prompt: string, promptVersion: string): string {
  const effort = stamp.effort === null ? [] : [`effort ${stamp.effort}`];
  return [stamp.agent, stamp.model ?? 'model unknown', ...effort, `${prompt} prompt v${promptVersion}`].join(' · ');
}

function stampChip(text: string): string {
  return `<span class="stamp">${escapeHtml(text)}</span>`;
}

/** A story's sentences, each part a button that opens it; the sentence that first mentions the focused part is marked. */
function storySentences(story: Story, focus: number | undefined): string {
  const focused = focus === undefined ? -1 : story.sentences.findIndex((sentence) => sentence.segments.some((segment) => segment.part === focus));
  return story.sentences
    .map((sentence, index) => {
      const runs = sentence.segments
        .map((segment) => {
          if (segment.part !== undefined) {
            return `<button type="button" class="pt${segment.part === focus ? ' focus' : ''}" data-part="${segment.part}">${escapeHtml(segment.text)}</button>`;
          }
          return segment.code ? `<code>${escapeHtml(segment.text)}</code>` : escapeHtml(segment.text);
        })
        .join('');
      return `<span class="sentence${index === focused ? ' focus' : ''}">${runs}</span>`;
    })
    .join(' ');
}

/** The story section: the story with its stamp, why there is none, or that it is still coming. */
function storySection(state: OverviewState): string {
  const { result, focus } = state;
  const story = result.story;
  const part = focus === undefined ? undefined : result.parts[focus];
  const missing =
    part !== undefined && story !== undefined && !story.sentences.some((sentence) => sentence.segments.some((segment) => segment.part === focus))
      ? `<p class="note">The story does not mention ${escapeHtml(part.name ?? part.path)}.</p>`
      : '';
  if (story === undefined) {
    const why = state.running !== undefined ? 'The story comes once the agent has written it.' : 'No story was written for this review.';
    return `<h2>Story</h2><p class="note">${why}</p>`;
  }
  const stamp = stampChip(stampText(story.stamp, 'story', story.promptVersion));
  if (story.outcome === 'fell back') {
    return `<h2>Story ${stamp}</h2><p class="note">No story: ${escapeHtml(story.detail)}.</p>`;
  }
  return `<h2>Story ${stamp}</h2>${missing}<div class="story">${storySentences(story, focus)}</div>`;
}

/** How the page names each claim source. */
const CLAIM_SOURCES: Record<ClaimSource, string> = {
  description: 'pull request description',
  docstring: 'docstring',
  comment: 'comment',
  agent: "the companion's story",
};

/** Where a claim is made, in words: its source and its place there. */
export function claimWhere(claim: Claim): string {
  const source = CLAIM_SOURCES[claim.source];
  const { location } = claim;
  switch (location.kind) {
    case 'description':
      return `${source}, line ${location.line}`;
    case 'story':
      return `${source}, sentence ${location.sentence + 1}`;
    case 'file': {
      const lines = location.endLine > location.line ? `${location.line}–${location.endLine}` : `${location.line}`;
      return `${source} · ${location.path}:${lines}`;
    }
  }
}

/** One claim: its quote, where it is made, the part it is attached to as a button that opens it, and its verdict. */
function claimItem(claim: Claim, result: ReviewResult): string {
  const part = result.parts[claim.part];
  const button =
    part === undefined
      ? ''
      : ` · <button type="button" class="pt" data-part="${claim.part}">${escapeHtml(part.name ?? part.path)}</button>`;
  return (
    `<li><q class="quote">${sanitiseUntrusted(claim.quote).html}</q>` +
    `<div class="where">${escapeHtml(claimWhere(claim))}${button} · <span class="verdict">${escapeHtml(claim.verdict.kind)}</span></div></li>`
  );
}

/** The claims section: the claims with their stamp, why there are none, or that they are still coming. */
function claimsSection(state: OverviewState): string {
  const { result } = state;
  const claims = result.claims;
  if (claims === undefined) {
    const why = state.running !== undefined ? 'The claims come once the agent has listed them.' : 'No claims were listed for this review.';
    return `<h2>Claims</h2><p class="note">${why}</p>`;
  }
  const stamp = stampChip(stampText(claims.stamp, 'claims', claims.promptVersion));
  if (claims.outcome === 'fell back') return `<h2>Claims ${stamp}</h2><p class="note">No claims: ${escapeHtml(claims.detail)}.</p>`;
  if (claims.claims.length === 0) return `<h2>Claims ${stamp}</h2><p class="note">The agent found no claim in the change.</p>`;
  const note =
    '<p class="note">Statements about how code or a library behaves, from the description, the docstrings and comments ' +
    'the change adds, and the story, in that order. None is checked yet.</p>';
  return `<h2>Claims ${stamp}</h2>${note}<ol class="claims">${claims.claims.map((claim) => claimItem(claim, result)).join('')}</ol>`;
}

/** The description section: the description in full, its hidden content shown and flagged. */
function descriptionSection(result: ReviewResult): string {
  const description = result.pullRequest.description;
  if (description.trim() === '') return '<h2>Pull request description</h2><p class="note">The pull request has no description.</p>';
  const { html, hidden } = sanitiseUntrusted(description);
  return `<h2>Pull request description</h2>${hiddenSummary(hidden)}<div class="description">${html}</div>`;
}

/** Who made each result: the plain pass or the agent, with its stamp, or why the plain result stayed. */
function stampsSection(state: OverviewState): string {
  const { result } = state;
  const rows: [string, string][] = [];
  const grouping = result.grouping.agent;
  rows.push([
    'Parts',
    grouping === undefined
      ? 'grouped by the plain pass'
      : grouping.outcome === 'grouped'
        ? `grouped by ${stampText(grouping.stamp, 'grouping', grouping.promptVersion)}: ${grouping.detail}`
        : `plain grouping kept: ${grouping.detail}`,
  ]);
  const ranking = result.ranking.agent;
  rows.push([
    'Ranking',
    ranking === undefined
      ? 'ranked by the plain rule'
      : result.ranking.by === 'agent' && ranking.stamp
        ? `ranked by ${stampText(ranking.stamp, 'ranking', ranking.promptVersion)}: ${ranking.detail}`
        : `plain ranking kept: ${ranking.detail}`,
  ]);
  const story = result.story;
  if (story) {
    rows.push([
      'Story',
      story.outcome === 'written'
        ? `written by ${stampText(story.stamp, 'story', story.promptVersion)}: ${story.detail}`
        : `none: ${story.detail}`,
    ]);
  }
  const claims = result.claims;
  if (claims) {
    rows.push([
      'Claims',
      claims.outcome === 'listed'
        ? `listed by ${stampText(claims.stamp, 'claims', claims.promptVersion)}: ${claims.detail}`
        : `none: ${claims.detail}`,
    ]);
  }
  const items = rows.map(([what, how]) => `<li><b>${escapeHtml(what)}</b> ${escapeHtml(how)}</li>`).join('');
  return `<h2>How these results were made</h2><ul class="stamps">${items}</ul>`;
}

/**
 * The page's HTML: the recorded design's overview tab, styled by the
 * editor's own theme. Every piece of text comes in escaped, and the
 * content security policy allows only the page's own style and script,
 * marked with this render's nonce: no image, font, frame or connection
 * of any origin.
 */
export function overviewHtml(state: OverviewState, nonce: string): string {
  const { result } = state;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<style nonce="${nonce}">
  body {
    color: var(--vscode-foreground);
    background-color: var(--vscode-editor-background);
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size, 13px);
    margin: 0;
    padding: 0 26px;
  }
  main { max-width: 900px; padding: 18px 0 48px; }
  h1 { font-size: 20px; font-weight: 600; margin: 0 0 4px; }
  h2 { font-size: 15px; font-weight: 600; margin: 16px 0 8px; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .meta, .note { color: var(--vscode-descriptionForeground); font-size: 12px; }
  .note { margin: 0 0 6px; }
  .stages { display: flex; gap: 6px; flex-wrap: wrap; margin: 10px 0 4px; }
  .stg { font-size: 12px; border: 1px solid var(--vscode-panel-border); border-radius: 12px; padding: 1px 9px; }
  .stg.done::before { content: "✓ "; color: var(--vscode-testing-iconPassed, #89d185); }
  .stg.run { color: var(--vscode-descriptionForeground); }
  .stamp { font-size: 11px; font-weight: 400; color: var(--vscode-descriptionForeground); }
  .story {
    border: 1px solid var(--vscode-panel-border);
    border-left: 3px solid var(--vscode-textLink-foreground);
    border-radius: 3px;
    padding: 10px 12px;
    font-size: 13.5px;
    line-height: 1.55;
  }
  .sentence.focus { background-color: var(--vscode-editor-findMatchHighlightBackground); }
  .pt {
    font: inherit;
    color: var(--vscode-textLink-foreground);
    background: none;
    border: none;
    border-bottom: 1px dotted var(--vscode-textLink-foreground);
    padding: 0;
    cursor: pointer;
  }
  .pt.focus { font-weight: 600; }
  code, .shown { font-family: var(--vscode-editor-font-family, monospace); font-size: 12px; }
  .description {
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    border: 1px solid var(--vscode-panel-border);
    border-radius: 3px;
    padding: 10px 12px;
  }
  .alert {
    border-left: 3px solid var(--vscode-editorWarning-foreground);
    padding: 4px 10px;
    margin: 0 0 8px;
  }
  .hidden {
    border: 1px dashed var(--vscode-editorWarning-foreground);
    border-radius: 3px;
    padding: 0 4px;
  }
  .flag {
    color: var(--vscode-editorWarning-foreground);
    font-size: 11px;
    font-weight: 600;
    margin-right: 6px;
  }
  .claims { padding-left: 22px; margin: 0; }
  .claims li { margin-bottom: 8px; }
  .quote { overflow-wrap: anywhere; }
  .where { color: var(--vscode-descriptionForeground); font-size: 12px; margin-top: 2px; }
  .verdict { font-style: italic; }
  .stamps { padding-left: 18px; margin: 0; }
  .stamps li { margin-bottom: 4px; }
</style>
</head>
<body>
<main>
  <h1>${escapeHtml(result.pullRequest.title)}</h1>
  <div class="meta">${metaLine(result)}</div>
  <div class="stages">${stageChips(state)}</div>
  <section id="story">${storySection(state)}</section>
  <section id="claims">${claimsSection(state)}</section>
  <section id="description">${descriptionSection(result)}</section>
  <section id="stamps">${stampsSection(state)}</section>
</main>
<script nonce="${nonce}">
(function () {
  'use strict';
  var vscode = acquireVsCodeApi();
  Array.prototype.forEach.call(document.querySelectorAll('button.pt'), function (button) {
    button.addEventListener('click', function () {
      vscode.postMessage({ type: 'openPart', part: Number(button.getAttribute('data-part')) });
    });
  });
  var focused = document.querySelector('.sentence.focus');
  if (focused !== null) {
    focused.scrollIntoView({ block: 'center' });
  }
}());
</script>
</body>
</html>`;
}
