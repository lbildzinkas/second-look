import { escapeHtml, claimWhere, issueName, sanitiseUntrusted, stageEndLine } from '../overview.js';
import { isFinding, isUnmetCriterion, type AcceptanceCriterion, type Claim, type FindingRef, type LinkedIssue, type ReviewResult, type ReviewStageId } from '@second-look/engine';
import { anchorOf, type PartAnchor, type TreeComment, type TreePart, type TreeSection } from '../tree.js';
import { progressBody } from './progress.js';
import { pullRequestsBody } from './pull-requests.js';
import { setupFormBody } from './setup.js';
import type { StepTick } from './step-ticks.js';
import { pullRequestLine, sideBarSteps, type SideBarState, type Step, type StepState } from './steps.js';

/** The buttons the side bar's cards carry, each running an existing command. */
export type SideBarButton = 'review' | 'overview' | 'nextPart' | 'allParts' | 'send' | 'verifyClaim' | 'criteriaHeading';

/** The actions a finding's row offers, each running the existing command for it. */
export const FINDING_ACTIONS = ['draft', 'open', 'verify', 'fetch'] as const;
export type FindingAction = (typeof FINDING_ACTIONS)[number];

/** A verdict or a state as a finding's row shows it: its glyph in its tone's colour, with its word. */
const FINDING_STATES: Record<string, { tone: string; icon: string }> = {
  refuted: { tone: 'bad', icon: '✕' },
  unverifiable: { tone: 'warn', icon: '?' },
  verified: { tone: 'ok', icon: '✓' },
  'not met': { tone: 'bad', icon: '✕' },
  'partly met': { tone: 'warn', icon: '◐' },
  'needs manual check': { tone: 'info', icon: '⚑' },
  "can't tell": { tone: 'mut', icon: '○' },
  met: { tone: 'ok', icon: '✓' },
  'in the code, not explained': { tone: 'warn', icon: '!' },
  'described, not in the code': { tone: 'warn', icon: '!' },
};

const STATE_ICONS: Record<StepState, string> = { done: '✓', current: '●', running: '↻', waiting: '◷', 'to come': '○' };

/** A button on a card, known by a stable id so the keyboard focus survives a redraw. */
function button(step: number, command: SideBarButton, label: string, options: { primary?: boolean; disabled?: boolean } = {}): string {
  const kind = options.primary ? 'primary' : 'secondary';
  const disabled = options.disabled ? ' disabled' : '';
  return `<button type="button" id="step-${step}-${command}" class="${kind}" data-command="${command}"${disabled}>${escapeHtml(label)}</button>`;
}

function note(text: string): string {
  return `<p class="note">${escapeHtml(text)}</p>`;
}

/** True while one of the stages that produce a step's results is still running or yet to come. */
function producing(state: SideBarState, ...ids: ReviewStageId[]): boolean {
  const { reviewing, result } = state;
  if (!reviewing || result === undefined) return false;
  const stages = result.stages;
  if (stages === undefined) return true;
  return stages.some((stage) => ids.includes(stage.id) && (stage.state === 'running' || stage.state === 'to come'));
}

/** How one of the stages that produce a step's results ended, as the overview words it; undefined while it runs or is yet to come. */
function stageLine(state: SideBarState, id: ReviewStageId): string | undefined {
  const { result, progress } = state;
  if (result === undefined) return undefined;
  const stages = progress?.state === 'finished' ? progress.stages : result.stages;
  return stageEndLine(stages?.find((record) => record.id === id));
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

/** A verdict or a state as a finding's row shows it: its glyph in its tone's colour, with its word. */
function statePill(state: string): string {
  const { tone, icon } = FINDING_STATES[state] ?? { tone: 'mut', icon: '○' };
  return `<span class="pill tone-${tone}"><span class="icon" aria-hidden="true">${icon}</span> ${escapeHtml(state)}</span>`;
}

/** A button on a finding's row, carrying the finding so the press runs the existing command for its action. */
function findingButton(step: number, action: FindingAction, finding: FindingRef, label: string): string {
  const key = `${finding.kind.replace(/ /g, '-')}-${finding.index}`;
  return `<button type="button" id="step-${step}-${action}-${key}" class="secondary" data-finding="${action}" data-kind="${escapeHtml(finding.kind)}" data-index="${finding.index}">${escapeHtml(label)}</button>`;
}

/** The step's “I've checked these” tick, kept per pull request and re-opened by new commits. */
function tickRow(step: number, tick: StepTick, checked: boolean, label: string): string {
  return `<div class="tick"><input type="checkbox" id="step-${step}-tick" data-tick="${tick}" aria-label="${escapeHtml(label)}"${checked ? ' checked' : ''}><label for="step-${step}-tick">${escapeHtml(label)}</label></div>`;
}

/** Step 5's row for one claim finding: its verdict and where it is made, its quote, and its actions. */
function claimFindingRow(claim: Claim, index: number): string {
  const verdict = claim.verdict.kind === 'not checked' ? undefined : claim.verdict;
  const offer = verdict === undefined || verdict.library !== undefined ? undefined : verdict.libraryFetch;
  const fetch = offer === undefined ? '' : findingButton(5, 'fetch', { kind: 'claim', index }, offer.decompile === undefined ? 'Fetch library' : 'Decompile');
  const finding = { kind: 'claim' as const, index };
  return (
    `<li class="finding">` +
    `<div class="head">${statePill(claim.verdict.kind)}<span class="where">${escapeHtml(claimWhere(claim))}</span></div>` +
    `<q class="quote">${sanitiseUntrusted(claim.quote).html}</q>` +
    `<div class="actions">${findingButton(5, 'draft', finding, 'Draft comment')}${findingButton(5, 'open', finding, 'Open')}${findingButton(5, 'verify', finding, 'Verify again')}${fetch}</div>` +
    `</li>`
  );
}

/** What step 5 says of claims none of which is checked: how the listing ended with none, why the judging left none, or that the verdicts are still to come. */
function unjudgedNote(state: SideBarState, claims: NonNullable<ReviewResult['claims']>): string {
  if (claims.claims.length === 0) return claims.outcome === 'fell back' ? `No claims: ${claims.detail}.` : 'The agent found no claim in the change.';
  if (claims.judging !== undefined) return `None is checked: ${claims.judging.detail}.`;
  if (producing(state, 'verdicts')) return 'The verdicts show here once the claims are checked.';
  return `None is checked: ${stageLine(state, 'verdicts') ?? 'the verdicts pass did not run'}.`;
}

/** Step 5's body: the claim findings with their actions, the verified claims folded below them, the verify ask, and the tick. */
function claimsBody(state: SideBarState): string {
  const { result, ticks } = state;
  if (result === undefined) return note('The claims and their verdicts show here once a review opens.');
  const listing = result.claims;
  const claims = listing?.claims ?? [];
  const judged = claims.some((claim) => claim.verdict.kind !== 'not checked');
  if (!judged) {
    if (producing(state, 'claims', 'verdicts')) {
      return note(listing === undefined ? 'The claims show here once the review lists them.' : unjudgedNote(state, listing)) + `<div class="actions">${button(5, 'overview', 'Open the overview')}</div>`;
    }
    return (
      note(listing === undefined ? 'No claims were listed for this review.' : unjudgedNote(state, listing)) +
      `<div class="actions">${button(5, 'verifyClaim', 'Verify a claim…')}${button(5, 'overview', 'Open the overview')}</div>` +
      tickRow(5, 'claims', ticks?.claims === true, "I've checked the claims")
    );
  }
  const rows: string[] = [];
  let verified = 0;
  for (const [index, claim] of claims.entries()) {
    if (isFinding(claim)) rows.push(claimFindingRow(claim, index));
    else if (claim.verdict.kind === 'verified') verified += 1;
  }
  const list = rows.length === 0 ? note('No refuted or unverifiable claim.') : `<ul class="findings" aria-label="Claim findings">${rows.join('')}</ul>`;
  const folded = verified === 0 ? '' : `<p class="folded"><span class="tone-ok" aria-hidden="true">✓</span> ${verified} verified</p>`;
  return (
    list +
    folded +
    `<div class="actions">${button(5, 'verifyClaim', 'Verify a claim…')}${button(5, 'overview', 'Open the overview')}</div>` +
    tickRow(5, 'claims', ticks?.claims === true, "I've checked the claims")
  );
}

/** The linked issue a criterion comes from, as a button that opens it on GitHub. */
function issueButton(issue: LinkedIssue, id: string, index: number): string {
  return `<button type="button" class="issue" id="${id}" data-issue="${index}" aria-label="Open ${escapeHtml(issueName(issue))} on GitHub">${escapeHtml(issueName(issue))}</button>`;
}

/** Step 6's row for one criterion not fully met: its verdict, its quote, its issue link, and the draft. */
function criterionRow(criterion: AcceptanceCriterion, index: number, issues: readonly LinkedIssue[]): string {
  const issue = issues[criterion.issue];
  const from = issue === undefined ? '' : `<div class="meta">${issueButton(issue, `step-6-issue-criterion-${index}`, criterion.issue)} · ${escapeHtml(issue.link)}</div>`;
  const draft = isUnmetCriterion(criterion) ? `<div class="actions">${findingButton(6, 'draft', { kind: 'criterion', index }, 'Draft comment')}</div>` : '';
  return (
    `<li class="finding">` +
    `<div class="head">${statePill(criterion.verdict.kind)}</div>` +
    `<q class="quote">${sanitiseUntrusted(criterion.quote).html}</q>` +
    from +
    draft +
    `</li>`
  );
}

/** Where a described change is quoted from: a description line, or a linked issue as a button, with its line. */
function describedWhere(change: { location: { kind: 'description'; line: number } | { kind: 'issue'; issue: number; line: number } }, index: number, issues: readonly LinkedIssue[]): string {
  const { location } = change;
  if (location.kind === 'description') return `<span>${escapeHtml(`pull request description, line ${location.line}`)}</span>`;
  const issue = issues[location.issue];
  return issue === undefined
    ? `<span>${escapeHtml(`linked issue, line ${location.line}`)}</span>`
    : `${issueButton(issue, `step-6-issue-described-${index}`, location.issue)} <span>${escapeHtml(`line ${location.line}`)}</span>`;
}

/** Step 6's rows for the unexplained changes in both directions: the parts nothing explains, then the changes described that the diff lacks. */
function unexplainedRows(result: ReviewResult, settled: boolean): { heading: boolean; body: string } {
  const unexplained = result.unexplained;
  if (unexplained === undefined) {
    return {
      heading: false,
      body: note(settled ? 'The change was not compared with its description and issues for this review.' : 'The unexplained changes show here once the change is compared with its description.'),
    };
  }
  if (unexplained.outcome !== 'compared') return { heading: false, body: note(`Not compared: ${unexplained.detail}.`) };
  if (unexplained.parts.length === 0 && unexplained.described.length === 0) {
    return { heading: false, body: `<p class="folded"><span class="tone-ok" aria-hidden="true">✓</span> Every part is explained, and every change the description promises is in the diff.</p>` };
  }
  const issues = result.criteria?.issues ?? [];
  const parts = unexplained.parts.map(({ part, reason }, index) => {
    const shown = result.parts[part];
    const open = shown === undefined ? escapeHtml(reason) : `<button type="button" class="open" data-anchor="${escapeHtml(JSON.stringify(anchorOf(shown)))}">${escapeHtml(shown.name ?? shown.path)}</button><span class="where">${escapeHtml(reason)}</span>`;
    return (
      `<li class="finding">` +
      `<div class="head">${statePill('in the code, not explained')}</div>` +
      `<div class="meta">${open}</div>` +
      `<div class="actions">${findingButton(6, 'draft', { kind: 'unexplained part', index }, 'Draft comment')}</div>` +
      `</li>`
    );
  });
  const described = unexplained.described.map((change, index) => (
    `<li class="finding">` +
    `<div class="head">${statePill('described, not in the code')}</div>` +
    `<q class="quote">${sanitiseUntrusted(change.quote).html}</q>` +
    `<div class="meta">${describedWhere(change, index, issues)}</div>` +
    `<div class="actions">${findingButton(6, 'draft', { kind: 'described change', index }, 'Draft comment')}</div>` +
    `</li>`
  ));
  return { heading: true, body: `<ul class="findings" aria-label="Unexplained changes">${[...parts, ...described].join('')}</ul>` };
}

/** What step 6 says of criteria none of which is checked: how the reading ended with none, why the mapping left none, or that the verdicts are still to come. */
function unmappedNote(state: SideBarState, criteria: NonNullable<ReviewResult['criteria']>): string {
  if (criteria.mapping !== undefined) return `None is checked: ${criteria.mapping.detail}.`;
  if (criteria.criteria.length === 0) return 'None is checked: no checklist was found to map.';
  if (producing(state, 'criteria')) return 'The verdicts show here once the criteria are mapped.';
  return `None is checked: ${stageLine(state, 'criteria') ?? 'the criteria mapping did not run'}.`;
}

/** Step 6's body: the criteria not fully met with their issue links and drafts, the met ones folded, the unexplained changes, and the tick. */
function criteriaBody(state: SideBarState): string {
  const { result, ticks } = state;
  if (result === undefined) return note('The acceptance criteria and the unexplained changes show here once a review opens.');
  const criteria = result.criteria;
  const rows: string[] = [];
  let met = 0;
  if (criteria !== undefined) {
    for (const [index, criterion] of criteria.criteria.entries()) {
      const { kind } = criterion.verdict;
      if (kind === 'not checked') continue;
      if (kind === 'met') met += 1;
      else rows.push(criterionRow(criterion, index, criteria.issues));
    }
  }
  // The tick shows once the step's results are in: its stages ended, whatever they left.
  const settled = !producing(state, 'unexplained', 'criteria');
  const unexplained = unexplainedRows(result, settled);
  const list =
    criteria === undefined
      ? note(settled ? 'No criteria were read for this review.' : 'The acceptance criteria show here once the review reads the linked issues.')
      : criteria.outcome === 'unreadable'
        ? note(`${criteria.detail}. No criteria were read, so none is checked.`)
        : rows.length > 0
          ? `<ul class="findings" aria-label="Criteria not fully met">${rows.join('')}</ul>`
          : criteria.criteria.some((criterion) => criterion.verdict.kind !== 'not checked')
            ? note('Every criterion is met.')
            : note(unmappedNote(state, criteria));
  const folded = met === 0 ? '' : `<p class="folded"><span class="tone-ok" aria-hidden="true">✓</span> ${met} met</p>`;
  const unexplainedHeading = unexplained.heading ? '<h3 class="group">Unexplained changes</h3>' : '';
  return (
    list +
    folded +
    unexplainedHeading +
    unexplained.body +
    `<div class="actions">${button(6, 'overview', 'Open the overview')}</div>` +
    (settled ? tickRow(6, 'criteria', ticks?.criteria === true, "I've checked the criteria") : '')
  );
}

function stepBody(step: Step, state: SideBarState): string {
  const { result } = state;
  switch (step.number) {
    case 1:
      return state.setup?.open === true
        ? setupFormBody(state.setup)
        : note(`Every agent pass runs on ${step.summary}. Change it with the change link, in the settings or from the status bar.`);
    case 2: {
      // The list of the reviewer's pull requests, with its URL box, when the side bar carries one.
      const picker = state.pullRequests === undefined ? undefined : pullRequestsBody(state.pullRequests);
      if (result !== undefined) {
        return `<p class="pr"><b>${escapeHtml(result.pullRequest.title)}</b><br>${escapeHtml(pullRequestLine(result))}</p><div class="actions">${button(2, 'review', 'Review another pull request')}</div>${picker ?? ''}`;
      }
      if (picker !== undefined) return (state.reviewing ? note('Reading the pull request…') : '') + picker;
      return note(state.reviewing ? 'Reading the pull request…' : 'Pick the pull request to review.') + `<div class="actions">${button(2, 'review', 'Review a pull request', { primary: true })}</div>`;
    }
    case 3:
      return note('The story tells what the change does, in the order to read the parts.') + `<div class="actions">${button(3, 'overview', 'Open the overview', { primary: true, disabled: result === undefined })}</div>`;
    case 4:
      return partsBody(state, step.state === 'done');
    case 5:
      return claimsBody(state);
    case 6:
      return criteriaBody(state);
    case 7:
      return commentsBody(state);
    default:
      return note('Every comment goes to GitHub as one review, only when you submit it.') + `<div class="actions">${button(8, 'send', 'Open the Send review page', { primary: true, disabled: result === undefined })}</div>`;
  }
}

/** Step 1's change link, which opens the setup form, beside its folded heading. */
function changeLink(step: Step, state: SideBarState): string {
  if (step.number !== 1 || state.setup === undefined || state.setup.open) return '';
  return '<button type="button" class="link" id="step-1-change" data-action="open" data-value="" aria-label="Change the agent, model and effort">change</button>';
}

/** Step 6's ⋯ link, which opens the editor's settings at the criteria heading setting. */
function criteriaHeadingLink(step: Step): string {
  if (step.number !== 6) return '';
  return '<button type="button" class="link" id="step-6-criteriaHeading" data-command="criteriaHeading" aria-label="Change the criteria heading setting">⋯</button>';
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
    `<span class="title">${step.number} ${escapeHtml(step.title)}</span>${summary}<span class="state">${step.state}</span></button>${changeLink(step, state)}${criteriaHeadingLink(step)}</h2>` +
    `<div class="body" id="${id}-body" role="region" aria-labelledby="${id}-title"${hidden}>${stepBody(step, state)}</div>` +
    `</li>`
  );
}

/** The side bar's content: the review's count tiles and progress strip, then the eight step cards, every piece of text escaped. */
export function sideBarBody(state: SideBarState, now: number = Date.now()): string {
  const steps = sideBarSteps(state);
  const current = steps.find((step) => step.open)?.number ?? 0;
  return `${progressBody(state, now)}<ol class="steps" aria-label="Review path" data-current="${current}">${steps.map((step) => stepCard(step, state)).join('')}</ol>`;
}

/**
 * The side bar's page, styled by the editor's theme through its
 * `--vscode-*` variables. The content security policy allows only the
 * page's own style and script, marked with this render's nonce: no image,
 * font, frame or connection of any origin. The script redraws the cards
 * the extension posts, keeping the keyboard focus and the cards the
 * reviewer folded or opened, ticks the running stage's time each second,
 * and reports each press as a message.
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
  h2 { display: flex; align-items: center; margin: 0; font-size: inherit; }
  button { font: inherit; cursor: pointer; }
  button:focus-visible, input:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px; }
  .fold { display: flex; align-items: center; gap: 6px; width: 100%; padding: 5px 8px; color: inherit; background: none; border: none; text-align: left; font-weight: 600; }
  .fold:hover { background-color: var(--vscode-list-hoverBackground); }
  .icon { width: 1em; text-align: center; flex: none; }
  .title { white-space: nowrap; flex: none; }
  .done .icon { color: var(--vscode-testing-iconPassed, var(--vscode-foreground)); }
  .current .icon, .running .icon { color: var(--vscode-progressBar-background, var(--vscode-focusBorder)); }
  .running .icon, .spin { display: inline-block; animation: spin 1.2s linear infinite; }
  .waiting .icon { color: var(--vscode-descriptionForeground); }
  @keyframes spin { to { transform: rotate(360deg); } }
  @media (prefers-reduced-motion: reduce) { .running .icon, .spin { animation: none; } }
  .progress { margin-bottom: 6px; }
  .tiles { list-style: none; margin: 0 0 5px; padding: 0; display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 5px; }
  .tile { display: flex; flex-direction: column; padding: 4px 6px; border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border)); border-radius: 4px; min-width: 0; }
  .tile .big { font-size: 16px; font-weight: 700; line-height: 1.2; }
  .tile small { font-size: 11px; font-weight: 400; color: var(--vscode-descriptionForeground); }
  .tile .lb { font-size: 11px; color: var(--vscode-descriptionForeground); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .strip { margin: 0; padding: 5px 8px; border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border)); border-radius: 4px; overflow-wrap: anywhere; }
  .strip.running .icon { color: var(--vscode-progressBar-background, var(--vscode-focusBorder)); }
  .strip.complete .icon { color: var(--vscode-testing-iconPassed, var(--vscode-foreground)); }
  .stage-notes { list-style: none; margin: 4px 0 0; padding: 0 8px; font-size: 12px; }
  .stage-notes li { margin: 2px 0; overflow-wrap: anywhere; }
  .stage-notes .fell-back .icon { color: var(--vscode-editorWarning-foreground, var(--vscode-foreground)); }
  .stage-notes .failed .icon { color: var(--vscode-errorForeground); }
  .sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
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
  .link { flex: none; padding: 0 8px; color: var(--vscode-textLink-foreground); background: none; border: none; }
  .link:hover { text-decoration: underline; }
  .setup .label { display: block; margin: 8px 0 3px; font-size: 11px; font-weight: 600; color: var(--vscode-descriptionForeground); }
  .choices { display: flex; flex-wrap: wrap; gap: 4px; }
  .choice { display: flex; flex-direction: column; align-items: flex-start; padding: 3px 8px; color: var(--vscode-foreground); background: none; border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border)); border-radius: 3px; text-align: left; }
  .choice[aria-checked="true"] { border-color: var(--vscode-focusBorder); background-color: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground, var(--vscode-foreground)); }
  .choice small { font-size: 11px; color: var(--vscode-descriptionForeground); }
  .setup-text { box-sizing: border-box; width: 100%; padding: 3px 6px; color: var(--vscode-input-foreground); background-color: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, transparent); border-radius: 2px; font: inherit; }
  .problem { color: var(--vscode-errorForeground); }
  .picker { display: flex; flex-direction: column; gap: 6px; margin-top: 4px; }
  .pr-filter { box-sizing: border-box; width: 100%; padding: 3px 6px; color: var(--vscode-input-foreground); background-color: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, transparent); border-radius: 2px; font: inherit; }
  .chip { padding: 0 8px; font-size: 11px; color: var(--vscode-descriptionForeground); background: none; border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border)); border-radius: 10px; line-height: 18px; }
  .chip[aria-pressed="true"] { color: var(--vscode-list-activeSelectionForeground, var(--vscode-foreground)); background-color: var(--vscode-list-activeSelectionBackground); border-color: var(--vscode-focusBorder); }
  .group .count { padding: 0 5px; border-radius: 8px; color: var(--vscode-badge-foreground); background-color: var(--vscode-badge-background); letter-spacing: 0; }
  .pr-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 5px; }
  .pr-card, .pr-state { padding: 6px 8px; border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border)); border-radius: 4px; }
  .pr-state h3 { margin: 0; font-size: inherit; }
  .pr-title { margin: 0; font-weight: 600; overflow-wrap: anywhere; }
  .pr-meta { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 6px; margin: 2px 0 0; font-size: 12px; color: var(--vscode-descriptionForeground); }
  .pr-summary { margin: 3px 0 0; font-size: 12px; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow-wrap: anywhere; }
  .pill { padding: 0 5px; border: 1px solid currentColor; border-radius: 4px; font-size: 11px; line-height: 16px; }
  .pr-size { font-family: var(--vscode-editor-font-family, monospace); font-size: 11px; }
  .pr-size .add { color: var(--vscode-gitDecoration-addedResourceForeground, var(--vscode-foreground)); }
  .pr-size .del { color: var(--vscode-gitDecoration-deletedResourceForeground, var(--vscode-foreground)); }
  .pr-meta button { margin-left: auto; }
  .test { overflow-wrap: anywhere; }
  .findings { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
  .finding { padding: 6px 8px; border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border)); border-radius: 4px; }
  .finding .head { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
  .finding .where { color: var(--vscode-descriptionForeground); font-size: 12px; overflow-wrap: anywhere; }
  .finding .quote { display: block; margin: 3px 0; overflow-wrap: anywhere; }
  .hidden { border: 1px dashed var(--vscode-editorWarning-foreground, var(--vscode-foreground)); border-radius: 3px; padding: 0 4px; }
  .flag { color: var(--vscode-editorWarning-foreground, var(--vscode-foreground)); font-size: 11px; font-weight: 600; margin-right: 6px; }
  .shown { font-family: var(--vscode-editor-font-family, monospace); font-size: 12px; }
  .finding .meta { display: flex; align-items: center; gap: 4px 6px; flex-wrap: wrap; margin-top: 2px; font-size: 12px; color: var(--vscode-descriptionForeground); }
  .pill { display: inline-flex; align-items: center; gap: 4px; font-size: 11px; font-weight: 600; border: 1px solid currentColor; border-radius: 4px; padding: 0 5px; line-height: 16px; white-space: nowrap; }
  .pill .icon { width: 1em; text-align: center; }
  .tone-ok { color: var(--vscode-testing-iconPassed, var(--vscode-foreground)); }
  .tone-bad { color: var(--vscode-errorForeground, var(--vscode-foreground)); }
  .tone-warn { color: var(--vscode-editorWarning-foreground, var(--vscode-foreground)); }
  .tone-info { color: var(--vscode-editorInfo-foreground, var(--vscode-textLink-foreground, var(--vscode-foreground))); }
  .tone-mut { color: var(--vscode-descriptionForeground); }
  .folded { display: flex; align-items: center; gap: 6px; margin: 6px 0 0; font-size: 12px; color: var(--vscode-descriptionForeground); }
  .issue { padding: 0; color: var(--vscode-textLink-foreground); background: none; border: none; font-size: 12px; }
  .issue:hover { color: var(--vscode-textLink-activeForeground, var(--vscode-textLink-foreground)); text-decoration: underline; }
  .tick { display: flex; align-items: center; gap: 6px; margin-top: 8px; padding-top: 6px; border-top: 1px dashed var(--vscode-widget-border, var(--vscode-panel-border)); }
  .tick label { font-size: 12px; }
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
      // Step 2's list loads the first time its card shows.
      if (open && pressed.getAttribute('data-step') === '2') vscode.postMessage({ type: 'pullRequests', action: 'show', value: '' });
    } else if (pressed.classList.contains('open')) {
      vscode.postMessage({ type: 'openPart', anchor: anchorOf(pressed) });
    } else if (pressed.hasAttribute('data-finding')) {
      vscode.postMessage({ type: 'finding', action: pressed.getAttribute('data-finding'), kind: pressed.getAttribute('data-kind'), index: Number(pressed.getAttribute('data-index')) });
    } else if (pressed.hasAttribute('data-issue')) {
      vscode.postMessage({ type: 'openIssue', issue: Number(pressed.getAttribute('data-issue')) });
    } else if (pressed.hasAttribute('data-pr-action')) {
      vscode.postMessage({ type: 'pullRequests', action: pressed.getAttribute('data-pr-action'), value: pressed.getAttribute('data-value') });
    } else if (pressed.hasAttribute('data-command')) {
      vscode.postMessage({ type: 'command', command: pressed.getAttribute('data-command') });
    } else if (pressed.hasAttribute('data-field')) {
      vscode.postMessage({ type: 'setup', field: pressed.getAttribute('data-field'), value: pressed.getAttribute('data-value') });
    } else if (pressed.hasAttribute('data-action')) {
      var fields = {};
      Array.prototype.forEach.call(root.querySelectorAll('input.setup-text'), function (box) { fields[box.getAttribute('data-field')] = box.value; });
      vscode.postMessage({ type: 'setup', action: pressed.getAttribute('data-action'), value: pressed.getAttribute('data-value'), fields: fields });
    }
  });
  root.addEventListener('change', function (event) {
    var box = event.target;
    if (box.classList.contains('setup-text')) {
      vscode.postMessage({ type: 'setup', field: box.getAttribute('data-field'), value: box.value });
      return;
    }
    if (box.type !== 'checkbox') return;
    if (box.hasAttribute('data-tick')) {
      vscode.postMessage({ type: 'tick', step: box.getAttribute('data-tick'), checked: box.checked });
      return;
    }
    vscode.postMessage({ type: 'mark', anchor: anchorOf(box), reviewed: box.checked });
  });
  // The list's box filters as the reviewer types; a paste or Enter can start a review of the URL in it.
  root.addEventListener('input', function (event) {
    var box = event.target;
    if (box.id !== 'pr-filter') return;
    vscode.postMessage({ type: 'pullRequests', action: 'filter', value: box.value, pasted: event.inputType === 'insertFromPaste' });
  });
  root.addEventListener('keydown', function (event) {
    var box = event.target;
    if (box.id !== 'pr-filter' || event.key !== 'Enter') return;
    event.preventDefault();
    vscode.postMessage({ type: 'pullRequests', action: 'go', value: box.value });
  });
  window.addEventListener('message', function (event) {
    var message = event.data;
    if (message === null || typeof message !== 'object' || message.type !== 'render' || typeof message.body !== 'string') return;
    var active = document.activeElement !== null && root.contains(document.activeElement) ? document.activeElement : null;
    var focused = active === null ? '' : active.id;
    // A text box being typed in keeps its text: it reaches the extension only once it changes.
    var typed = active !== null && (active.classList.contains('setup-text') || active.id === 'pr-filter') ? active.value : null;
    var caret = typed === null ? null : [active.selectionStart, active.selectionEnd];
    root.innerHTML = message.body;
    keepFolds();
    var again = focused === '' ? null : document.getElementById(focused);
    if (again !== null && typed !== null) again.value = typed;
    if (again !== null) again.focus();
    if (again !== null && caret !== null && typeof again.setSelectionRange === 'function') again.setSelectionRange(caret[0], caret[1]);
  });
  // The running stage's time so far, as the extension wrote it, moves on each second.
  function elapsed(ms) {
    var seconds = Math.max(0, Math.floor(ms / 1000));
    var hours = Math.floor(seconds / 3600);
    var minutes = Math.floor((seconds % 3600) / 60);
    var rest = seconds % 60;
    var ss = (rest < 10 ? '0' : '') + rest;
    return hours > 0 ? hours + ':' + (minutes < 10 ? '0' : '') + minutes + ':' + ss : minutes + ':' + ss;
  }
  window.setInterval(function () {
    Array.prototype.forEach.call(root.querySelectorAll('.elapsed'), function (span) {
      var started = Number(span.getAttribute('data-started') || NaN);
      if (isFinite(started)) span.textContent = elapsed(Date.now() - started);
    });
  }, 1000);
  keepFolds();
  vscode.postMessage({ type: 'ready' });
}());
</script>
</body>
</html>`;
}
