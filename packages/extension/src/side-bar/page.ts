import { escapeHtml } from '../overview.js';
import { anchorOf, type PartAnchor, type TreeComment, type TreePart, type TreeSection } from '../tree.js';
import { pullRequestLine, sideBarSteps, type SideBarState, type Step, type StepState } from './steps.js';

/** The buttons the side bar's cards carry, each running an existing command. */
export type SideBarButton = 'review' | 'overview' | 'nextPart' | 'allParts' | 'send';

const STATE_ICONS: Record<StepState, string> = { done: '✓', current: '●', running: '↻', 'to come': '○' };

/** A button on a card, known by a stable id so the keyboard focus survives a redraw. */
function button(step: number, command: SideBarButton, label: string, options: { primary?: boolean; disabled?: boolean } = {}): string {
  const kind = options.primary ? 'primary' : 'secondary';
  const disabled = options.disabled ? ' disabled' : '';
  return `<button type="button" id="step-${step}-${command}" class="${kind}" data-command="${command}"${disabled}>${escapeHtml(label)}</button>`;
}

function note(text: string): string {
  return `<p class="note">${escapeHtml(text)}</p>`;
}

/** A stable key for a part, from where it starts, for its row's ids. */
function partKey(anchor: PartAnchor): string {
  return escapeHtml(`${anchor.path}@${anchor.hunk?.oldStart ?? ''},${anchor.hunk?.newStart ?? ''}`);
}

/**
 * A part's row: its reviewed checkbox, which Space ticks, the button that
 * opens it in the diff editor, which Enter presses, and what the tree
 * shows beside it, its tooltip on hover; a right click offers the asks,
 * Why this matters and Comment on this part, as the part banner does.
 */
function partRow(node: TreePart): string {
  if (node.part === undefined) return '';
  const anchor = anchorOf(node.part);
  const key = partKey(anchor);
  const data = escapeHtml(JSON.stringify(anchor));
  const label = escapeHtml(node.label);
  const checked = node.reviewed === 'reviewed' ? ' checked' : '';
  const title = node.tooltip === undefined ? '' : ` title="${escapeHtml(node.tooltip)}"`;
  const description = node.description === undefined ? '' : `<span class="desc">${escapeHtml(node.description)}</span>`;
  // A right click on the row offers the part's context menu, whose
  // commands read the part from the anchor, as the banner's links carry it.
  const context = escapeHtml(JSON.stringify({ webviewSection: 'part', anchor, preventDefaultContextMenuItems: true }));
  return (
    `<li class="part ${node.kind}" data-vscode-context="${context}">` +
    `<input type="checkbox" id="mark-${key}" data-anchor="${data}" aria-label="Reviewed: ${label}"${checked}>` +
    `<span class="row"><button type="button" class="open" id="open-${key}" data-anchor="${data}"${title}>${label}</button>${description}</span>` +
    `</li>`
  );
}

function commentRow(node: TreeComment): string {
  const title = node.tooltip === undefined ? '' : ` title="${escapeHtml(node.tooltip)}"`;
  const description = node.description === undefined ? '' : `<span class="desc">${escapeHtml(node.description)}</span>`;
  return `<li class="comment"${title}><span class="row"><span>${escapeHtml(node.label)}</span>${description}</span></li>`;
}

function isPartSection(section: TreeSection): boolean {
  return section.parts.every((node) => node.kind !== 'comment');
}

/** Step 4's body: the parts grouped by importance, then the buttons that open them. */
function partsBody(state: SideBarState, allReviewed: boolean): string {
  if (state.result === undefined) return note('The parts show here, must review first, once a review opens.');
  const groups = state.sections.filter(isPartSection).map(
    (section) =>
      `<h3 class="group" title="${escapeHtml(section.tooltip)}">${escapeHtml(section.label)}</h3>` +
      `<ul class="parts" aria-label="${escapeHtml(section.label)}">${section.parts.map((node) => partRow(node as TreePart)).join('')}</ul>`,
  );
  const message = state.message === undefined ? '' : note(state.message);
  return (
    message +
    groups.join('') +
    `<div class="actions">${button(4, 'nextPart', 'Open next part', { primary: true, disabled: allReviewed })}${button(4, 'allParts', 'All in order')}</div>`
  );
}

/** Step 7's body: the pending review's comments, and the button that opens the diff they are written on. */
function commentsBody(state: SideBarState): string {
  const comments = state.sections.filter((section) => !isPartSection(section)).flatMap((section) => section.parts as TreeComment[]);
  const list = comments.length === 0 ? note('No comment yet: write them in threads on the diff.') : `<ul class="comments" aria-label="Pending review">${comments.map(commentRow).join('')}</ul>`;
  return list + `<div class="actions">${button(7, 'allParts', 'Open the threads in the diff', { disabled: state.result === undefined })}</div>`;
}

function stepBody(step: Step, state: SideBarState): string {
  const { result } = state;
  switch (step.number) {
    case 1:
      return note(`Every agent pass runs on ${step.summary}. Change it in the settings or from the status bar.`);
    case 2:
      return result === undefined
        ? note(state.reviewing ? 'Reading the pull request…' : 'Pick the pull request to review.') + `<div class="actions">${button(2, 'review', 'Review a pull request', { primary: true })}</div>`
        : `<p class="pr"><b>${escapeHtml(result.pullRequest.title)}</b><br>${escapeHtml(pullRequestLine(result))}</p><div class="actions">${button(2, 'review', 'Review another pull request')}</div>`;
    case 3:
      return note('The story tells what the change does, in the order to read the parts.') + `<div class="actions">${button(3, 'overview', 'Open the overview', { primary: true, disabled: result === undefined })}</div>`;
    case 4:
      return partsBody(state, step.state === 'done');
    case 5:
      return note('The claims and their verdicts are in the overview.') + `<div class="actions">${button(5, 'overview', 'Open the overview', { disabled: result === undefined })}</div>`;
    case 6:
      return note('The acceptance criteria and the unexplained changes are in the overview.') + `<div class="actions">${button(6, 'overview', 'Open the overview', { disabled: result === undefined })}</div>`;
    case 7:
      return commentsBody(state);
    default:
      return note('Every comment goes to GitHub as one review, only when you submit it.') + `<div class="actions">${button(8, 'send', 'Open the Send review page', { primary: true, disabled: result === undefined })}</div>`;
  }
}

/**
 * One step's card: a heading whose button folds and opens the card, with
 * the step's state as an icon and in words, then its body. The current
 * step's card is marked as the current step for screen readers.
 */
function stepCard(step: Step, state: SideBarState): string {
  const id = `step-${step.number}`;
  const current = step.open ? ' aria-current="step"' : '';
  const hidden = step.open ? '' : ' hidden';
  const summary = step.summary === '' ? '' : `<span class="summary">${escapeHtml(step.summary)}</span>`;
  return (
    `<li class="step ${step.state.replace(' ', '-')}" id="${id}"${current}>` +
    `<h2><button type="button" class="fold" id="${id}-title" data-step="${step.number}" aria-expanded="${step.open}" aria-controls="${id}-body">` +
    `<span class="icon" aria-hidden="true">${STATE_ICONS[step.state]}</span>` +
    `<span class="title">${step.number} ${escapeHtml(step.title)}</span>${summary}<span class="state">${step.state}</span></button></h2>` +
    `<div class="body" id="${id}-body" role="region" aria-labelledby="${id}-title"${hidden}>${stepBody(step, state)}</div>` +
    `</li>`
  );
}

/** The side bar's content: the eight step cards, every piece of text escaped. */
export function sideBarBody(state: SideBarState): string {
  const steps = sideBarSteps(state);
  const current = steps.find((step) => step.open)?.number ?? 0;
  return `<ol class="steps" aria-label="Review path" data-current="${current}">${steps.map((step) => stepCard(step, state)).join('')}</ol>`;
}

/**
 * The side bar's page, styled by the editor's theme through its
 * `--vscode-*` variables. The content security policy allows only the
 * page's own style and script, marked with this render's nonce: no image,
 * font, frame or connection of any origin. The script redraws the cards
 * the extension posts, keeping the keyboard focus and the cards the
 * reviewer folded or opened, and reports each press as a message.
 */
export function sideBarHtml(nonce: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<style nonce="${nonce}">
  body { color: var(--vscode-foreground); background-color: var(--vscode-sideBar-background); font-family: var(--vscode-font-family); font-size: var(--vscode-font-size, 13px); margin: 0; padding: 8px 10px; }
  .steps { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
  .step { border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border)); border-radius: 4px; }
  .step[aria-current] { border-color: var(--vscode-focusBorder); }
  .step.to-come { opacity: 0.75; }
  h2 { margin: 0; font-size: inherit; }
  button { font: inherit; cursor: pointer; }
  button:focus-visible, input:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px; }
  .fold { display: flex; align-items: center; gap: 6px; width: 100%; padding: 5px 8px; color: inherit; background: none; border: none; text-align: left; font-weight: 600; }
  .fold:hover { background-color: var(--vscode-list-hoverBackground); }
  .icon { width: 1em; text-align: center; flex: none; }
  .title { white-space: nowrap; flex: none; }
  .done .icon { color: var(--vscode-testing-iconPassed, var(--vscode-foreground)); }
  .current .icon, .running .icon { color: var(--vscode-progressBar-background, var(--vscode-focusBorder)); }
  .running .icon { animation: spin 1.2s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  @media (prefers-reduced-motion: reduce) { .running .icon { animation: none; } }
  .summary { margin-left: auto; font-weight: 400; color: var(--vscode-descriptionForeground); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
  .state { font-weight: 400; font-size: 11px; color: var(--vscode-descriptionForeground); white-space: nowrap; }
  .summary + .state::before { content: "· "; }
  .fold .title + .state { margin-left: auto; }
  .body { padding: 0 8px 8px; }
  .note { margin: 4px 0; color: var(--vscode-descriptionForeground); }
  .pr { margin: 4px 0; overflow-wrap: anywhere; }
  .group { margin: 8px 0 2px; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; color: var(--vscode-descriptionForeground); }
  .parts, .comments { list-style: none; margin: 0; padding: 0; }
  .part, .comment { display: flex; align-items: flex-start; gap: 6px; padding: 2px 0; }
  .row { display: flex; flex-direction: column; min-width: 0; }
  .open { padding: 0; color: var(--vscode-foreground); background: none; border: none; text-align: left; overflow-wrap: anywhere; }
  .open:hover { color: var(--vscode-textLink-activeForeground, var(--vscode-textLink-foreground)); text-decoration: underline; }
  .desc { font-size: 12px; color: var(--vscode-descriptionForeground); overflow-wrap: anywhere; }
  input[type="checkbox"] { margin: 2px 0 0; accent-color: var(--vscode-button-background); }
  .actions { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 8px; }
  .primary, .secondary { border: 1px solid var(--vscode-button-border, transparent); border-radius: 2px; padding: 3px 10px; }
  .primary { color: var(--vscode-button-foreground); background-color: var(--vscode-button-background); }
  .primary:hover { background-color: var(--vscode-button-hoverBackground); }
  .secondary { color: var(--vscode-button-secondaryForeground); background-color: var(--vscode-button-secondaryBackground); }
  .secondary:hover { background-color: var(--vscode-button-secondaryHoverBackground); }
  button:disabled { opacity: 0.5; cursor: default; }
</style>
</head>
<body>
<main id="root">${body}</main>
<script nonce="${nonce}">
(function () {
  'use strict';
  var vscode = acquireVsCodeApi();
  var root = document.getElementById('root');
  var folds = {};
  var current = null;
  function anchorOf(element) {
    try { return JSON.parse(element.getAttribute('data-anchor')); } catch (error) { return undefined; }
  }
  function setOpen(fold, open) {
    fold.setAttribute('aria-expanded', String(open));
    var body = document.getElementById(fold.getAttribute('aria-controls'));
    if (body !== null) body.hidden = !open;
  }
  function keepFolds() {
    var steps = root.querySelector('.steps');
    var now = steps === null ? null : steps.getAttribute('data-current');
    if (now !== current) { folds = {}; current = now; }
    Array.prototype.forEach.call(root.querySelectorAll('button.fold'), function (fold) {
      var step = fold.getAttribute('data-step');
      if (Object.prototype.hasOwnProperty.call(folds, step)) setOpen(fold, folds[step]);
    });
  }
  root.addEventListener('click', function (event) {
    var pressed = event.target.closest('button');
    if (pressed === null || pressed.disabled) return;
    if (pressed.classList.contains('fold')) {
      var open = pressed.getAttribute('aria-expanded') !== 'true';
      folds[pressed.getAttribute('data-step')] = open;
      setOpen(pressed, open);
    } else if (pressed.classList.contains('open')) {
      vscode.postMessage({ type: 'openPart', anchor: anchorOf(pressed) });
    } else if (pressed.hasAttribute('data-command')) {
      vscode.postMessage({ type: 'command', command: pressed.getAttribute('data-command') });
    }
  });
  root.addEventListener('change', function (event) {
    var box = event.target;
    if (box.type !== 'checkbox') return;
    vscode.postMessage({ type: 'mark', anchor: anchorOf(box), reviewed: box.checked });
  });
  window.addEventListener('message', function (event) {
    var message = event.data;
    if (message === null || typeof message !== 'object' || message.type !== 'render' || typeof message.body !== 'string') return;
    var focused = document.activeElement !== null && root.contains(document.activeElement) ? document.activeElement.id : '';
    root.innerHTML = message.body;
    keepFolds();
    var again = focused === '' ? null : document.getElementById(focused);
    if (again !== null) again.focus();
  });
  keepFolds();
  vscode.postMessage({ type: 'ready' });
}());
</script>
</body>
</html>`;
}
