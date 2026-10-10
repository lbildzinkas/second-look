import * as vscode from 'vscode';
import { randomUUID } from 'node:crypto';
import {
  ASKS,
  CRITERION_VERDICT_KINDS,
  checkFailed,
  hiddenContent,
  isFinding,
  isFindingRef,
  isUnmetCriterion,
  isUnprovenSource,
  parsePullRequestUrl,
  type AcceptanceCriterion,
  type AgentStamp,
  type AskAnswer,
  type CheckRun,
  type Claim,
  type CommentSide,
  type DocLink,
  type ClaimSource,
  type DescribedChange,
  type FindingRef,
  type HiddenKind,
  type LinkedIssue,
  type Part,
  type ReviewResult,
  type Story,
} from '@second-look/engine';
import { sinceLastLookLine } from './tree.js';

/** The view type of the overview's one webview panel. */
export const OVERVIEW_VIEW_TYPE = 'second-look.overview' as const;

/** What the overview shows: a result, the stage still running, and the part the story is opened at. */
export interface OverviewState {
  result: ReviewResult;
  /** The stage still running, in words for the reviewer; absent once the review is done. */
  running?: string;
  /** The part the story is opened at, by its index in the result's parts. */
  focus?: number;
  /** The answers to the reviewer's asks about this review's parts, newest first. */
  answers?: readonly AskAnswer[];
  /** True when the page is opened at the newest answer. */
  focusAnswer?: boolean;
}

/** The evidence of a criterion's verdict that cites lines of the head copy. */
export type CitedEvidence = 'code' | 'tests';

/** A move the reviewer makes on the page, as its script reports it. */
export type OverviewMessage =
  | {
      type: 'openPart' | 'openIssue';
      /** The part or the linked issue, by its index in the result's parts or the criteria's issues. */
      target: number;
    }
  | {
      type: 'openEvidence';
      /** The criterion, by its index in the criteria. */
      criterion: number;
      evidence: CitedEvidence;
      /** The cited line, by its index in that evidence. */
      index: number;
    }
  | {
      type: 'draft';
      /** The finding to draft a comment from. */
      finding: FindingRef;
    }
  | {
      type: 'openCited';
      /** The answer, by its index in the answers shown, newest first. */
      answer: number;
      /** The cited line, by its index in that answer's citations. */
      index: number;
    }
  | {
      type: 'openDoc';
      /** The documentation link, by its index in the result's links. */
      target: number;
    }
  | {
      type: 'openClaimEvidence';
      /** The claim, by its index in the claims. */
      claim: number;
      /** The cited line, by its index in that claim's verdict evidence. */
      index: number;
    };


/** Reads a page message out of what the webview delivered, if it is one. */
function overviewMessage(value: unknown): OverviewMessage | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const { type, part, issue, criterion, evidence, index, finding, answer, doc, claim } = value as Record<string, unknown>;
  if (type === 'openDoc' && Number.isInteger(doc)) return { type, target: doc as number };
  if (type === 'openClaimEvidence' && Number.isInteger(claim) && Number.isInteger(index)) return { type, claim: claim as number, index: index as number };
  if (type === 'openCited' && Number.isInteger(answer) && Number.isInteger(index)) return { type, answer: answer as number, index: index as number };
  if (type === 'openPart' && Number.isInteger(part)) return { type, target: part as number };
  if (type === 'openIssue' && Number.isInteger(issue)) return { type, target: issue as number };
  if (type === 'openEvidence' && Number.isInteger(criterion) && (evidence === 'code' || evidence === 'tests') && Number.isInteger(index)) {
    return { type, criterion: criterion as number, evidence, index: index as number };
  }
  const ref = { kind: finding, index };
  if (type === 'draft' && isFindingRef(ref)) return { type, finding: ref };
  return undefined;
}

/**
 * The review's overview (issue #30), the tab at the top of the review in
 * the recorded design (docs/ux), in its dashboard-and-tables style: the
 * pull request's title and where it comes from, a chip for each stage
 * done and the one still running, count tiles, then each section as a
 * block in a bounded reading column beside a contents rail that scrolls to
 * it — the claims, criteria and unexplained changes as tables, findings
 * first, each row opening in place to its reason and evidence — the
 * story with its stamp, each part it mentions a button that opens the part
 * in the diff editor, the acceptance criteria of the linked issues, each
 * quoted and its issue a button that opens it on GitHub, with its verdict,
 * the code and tests it cites each a button that opens the line in the
 * head copy, and the manual checks the description reports, each its
 * place a button that jumps to the description, the unexplained
 * changes in both directions, the claims the change makes with where each
 * is made and the part it is attached to, each finding with a button that
 * drafts a comment from it, the documentation links of the library APIs the change uses — the
 * inventories' links first, then the agent's suggestions, flagged as not checked, each a button that
 * opens its page in the browser — the pipeline report and whether it is trusted, the checks run on the merge
 * commit with their annotations and failed jobs' trimmed logs, the pull
 * request's description in full with its hidden content shown and flagged,
 * and who made each result.
 *
 * Everything on the page but the companion's own words was written by
 * someone else, the agent's story and reasons, the claims' quotes, the
 * criteria's and the described changes' quotes from untrusted text, the
 * pipeline's findings and the CI's logs included, so every byte of it
 * reaches the page as escaped text: no remote image, no link and no
 * markup of theirs renders, under a content security policy that loads nothing but the
 * page's own nonce-marked style and script.
 */
export class OverviewPanel implements vscode.Disposable {
  private panel: vscode.WebviewPanel | undefined;

  private state: OverviewState | undefined;

  private disposed = false;

  /** Opens a part the story links or a claim is attached to, in the diff editor. */
  private readonly openPart: (part: Part) => void;

  /** Opens a line a criterion's verdict or an answer cites, in the read-only head or base copy. */
  private readonly openLine: (path: string, line: number, side: CommentSide) => void;

  /** Drafts a comment from a finding the page lists. */
  private readonly draft: (finding: FindingRef) => void;

  /** The answers to the reviewer's asks about the review shown, newest first. */
  private answers: AskAnswer[] = [];

  constructor(openPart: (part: Part) => void, openLine: (path: string, line: number, side: CommentSide) => void, draft: (finding: FindingRef) => void) {
    this.openPart = openPart;
    this.openLine = openLine;
    this.draft = draft;
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

  /** Shows the answer to an ask at the top of the page, which opens at it. */
  answer(answer: AskAnswer): void {
    this.answers = [answer, ...this.answers];
    this.open({ answer: true });
  }

  /** Drops every answer, when a new review replaces the one they were about. */
  clearAnswers(): void {
    this.answers = [];
    this.render();
  }

  /**
   * Opens the page, or brings it to the front, at the story's start, at
   * the first sentence that mentions one part, or at the newest answer.
   * True when there was a review to show.
   */
  open(options: { focus?: number; preserveFocus?: boolean; answer?: boolean } = {}): boolean {
    if (this.disposed || this.state === undefined) return false;
    const { result, running } = this.state;
    this.state = {
      result,
      ...(running !== undefined ? { running } : {}),
      ...(options.focus !== undefined ? { focus: options.focus } : {}),
      ...(options.answer ? { focusAnswer: true } : {}),
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

  /**
   * The part a story, claim or unexplained-change button names, opened in
   * the diff editor; a linked issue, opened on GitHub; a line a criterion's
   * or a claim's verdict cites, opened in the head copy; a line an answer
   * cites, opened in the copy of its side; a finding, drafted from.
   */
  private handle(value: unknown): void {
    const message = overviewMessage(value);
    if (message === undefined) return;
    if (message.type === 'openCited') {
      const cited = this.answers[message.answer]?.cited[message.index];
      if (cited !== undefined) this.openLine(cited.path, cited.line, cited.side);
      return;
    }
    if (message.type === 'draft') {
      this.draft(message.finding);
      return;
    }
    if (message.type === 'openClaimEvidence') {
      const verdict = this.state?.result.claims?.claims[message.claim]?.verdict;
      // A CI log's line, or a line of fetched library source, is not a line of the head copy.
      const cited = verdict === undefined || verdict.kind === 'not checked' || verdict.library !== undefined ? undefined : verdict.evidence[message.index];
      if (cited !== undefined && cited.ciLog !== true) this.openLine(cited.path, cited.line, 'head');
      return;
    }
    if (message.type === 'openEvidence') {
      const verdict = this.state?.result.criteria?.criteria[message.criterion]?.verdict;
      const cited = verdict === undefined || verdict.kind === 'not checked' ? undefined : verdict[message.evidence][message.index];
      if (cited !== undefined) this.openLine(cited.path, cited.line, 'head');
      return;
    }
    if (message.type === 'openPart') {
      const part = this.state?.result.parts[message.target];
      if (part !== undefined) this.openPart(part);
      return;
    }
    if (message.type === 'openDoc') {
      const link = this.state?.result.docLinks?.links[message.target];
      if (link !== undefined && link.url.startsWith('https://')) void vscode.env.openExternal(vscode.Uri.parse(link.url));
      return;
    }
    const issue = this.state?.result.criteria?.issues[message.target];
    if (issue !== undefined) {
      void vscode.env.openExternal(vscode.Uri.parse(issue.url));
    }
  }

  private render(): void {
    if (this.panel === undefined || this.state === undefined) return;
    this.panel.title = overviewTitle(this.state.result);
    this.panel.webview.html = overviewHtml({ ...this.state, answers: this.answers }, randomUUID());
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

/** The line under the meta saying which commit the reviewer's last look was at and what changed since; nothing on a first look. */
function sinceLine(result: ReviewResult): string {
  const line = sinceLastLookLine(result);
  return line === undefined ? '' : `<div class="meta since">${escapeHtml(line)}</div>`;
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
  if (result.unexplained) chips.push({ text: result.unexplained.outcome === 'compared' ? 'unexplained changes' : 'no comparison', done: true });
  if (result.claims) chips.push({ text: result.claims.outcome === 'listed' ? 'claims' : 'no claims', done: true });
  const judging = result.claims?.judging;
  if (judging) chips.push({ text: judging.outcome === 'judged' ? 'verdicts' : 'no verdicts', done: true });
  const mapping = result.criteria?.mapping;
  if (mapping) chips.push({ text: mapping.outcome === 'mapped' ? 'criteria mapped' : 'criteria not mapped', done: true });
  if (result.docLinks) chips.push({ text: 'documentation links', done: true });
  if (state.running !== undefined) chips.push({ text: state.running, done: false });
  return chips
    .map((chip) => `<span class="stg ${chip.done ? 'done' : 'run'}">${escapeHtml(chip.text)}${chip.done ? '' : '…'}</span>`)
    .join('');
}

/**
 * A result's stamp in the recorded design's words: agent · model · effort ·
 * prompt version. The effort always shows, named as the agent's default
 * when the run asked for none.
 */
export function stampText(stamp: AgentStamp, prompt: string, promptVersion: string): string {
  const effort = stamp.effort === null ? 'default effort' : `effort ${stamp.effort}`;
  return [stamp.agent, stamp.model ?? 'model unknown', effort, `${prompt} prompt v${promptVersion}`].join(' · ');
}

function stampChip(text: string): string {
  return `<span class="stamp">${escapeHtml(text)}</span>`;
}

/** The theme colour a state shows in, always beside its icon and its word. */
type Tone = 'ok' | 'bad' | 'warn' | 'info' | 'must' | 'mut';

/** How the page shows each state: its tone, and its icon as a text glyph, which needs no font the page's policy would block. */
const STATES: Record<string, { tone: Tone; icon: string }> = {
  verified: { tone: 'ok', icon: '✓' },
  refuted: { tone: 'bad', icon: '✕' },
  unverifiable: { tone: 'warn', icon: '?' },
  'not checked': { tone: 'mut', icon: '○' },
  met: { tone: 'ok', icon: '✓' },
  'partly met': { tone: 'warn', icon: '◐' },
  'not met': { tone: 'bad', icon: '✕' },
  'needs manual check': { tone: 'info', icon: '⚑' },
  "can't tell": { tone: 'mut', icon: '○' },
  'in the code, not explained': { tone: 'warn', icon: '!' },
  'described, not in the code': { tone: 'warn', icon: '!' },
  unexplained: { tone: 'warn', icon: '!' },
  explained: { tone: 'ok', icon: '✓' },
  'must review': { tone: 'must', icon: '★' },
  answered: { tone: 'info', icon: '↳' },
  links: { tone: 'mut', icon: '↗' },
  failed: { tone: 'bad', icon: '✕' },
};

/** A state's word in a pill of its colour, after its icon. */
function pill(state: string, text = state): string {
  const { tone, icon } = STATES[state]!;
  return `<span class="pl tone-${tone}"><span class="ic" aria-hidden="true">${icon}</span>${escapeHtml(text)}</span>`;
}

/** How many of a section's rows are in one state. */
interface Tally {
  state: string;
  count: number;
}

/** How many rows are in each state, in the order given, which reads findings first; states with none are left out. */
function tally(states: readonly string[], order: readonly string[]): Tally[] {
  return order.map((state) => ({ state, count: states.filter((each) => each === state).length })).filter(({ count }) => count > 0);
}

/** The claims' verdicts in the order a reviewer reads them: findings first, confirmations last. */
const CLAIM_ORDER = ['refuted', 'unverifiable', 'not checked', 'verified'];

/** The criteria's verdicts in the order a reviewer reads them: findings first, confirmations last. */
const CRITERION_ORDER: readonly string[] = [...CRITERION_VERDICT_KINDS, 'not checked'];

function claimTallies(result: ReviewResult): Tally[] {
  return tally(result.claims?.claims.map((claim) => claim.verdict.kind) ?? [], CLAIM_ORDER);
}

function criterionTallies(result: ReviewResult): Tally[] {
  return tally(result.criteria?.criteria.map((criterion) => criterion.verdict.kind) ?? [], CRITERION_ORDER);
}

/** How many unexplained changes the comparison found, in both directions; nothing until it compared. */
function unexplainedTally(result: ReviewResult): Tally | undefined {
  const unexplained = result.unexplained;
  if (unexplained?.outcome !== 'compared') return undefined;
  const count = unexplained.parts.length + unexplained.described.length;
  return { state: count === 0 ? 'explained' : 'unexplained', count };
}

/** A count tile: the number in its state's colour, then its icon and what it counts. */
function tile({ state, count }: Tally, label: string): string {
  const { tone, icon } = STATES[state]!;
  return `<div class="tile"><div class="big tone-${tone}">${count}</div><div class="lb"><span class="tone-${tone}" aria-hidden="true">${icon}</span> ${escapeHtml(label)}</div></div>`;
}

/** The count tiles at the top of the page: the criteria and the claims by verdict, the unexplained changes, and the parts that must be reviewed. */
function countTiles(result: ReviewResult): string {
  const plural = (count: number, one: string, many: string): string => (count === 1 ? one : many);
  const tiles = [
    ...criterionTallies(result).map((each) => tile(each, `${plural(each.count, 'criterion', 'criteria')} ${each.state}`)),
    ...claimTallies(result).map((each) => tile(each, `${plural(each.count, 'claim', 'claims')} ${each.state}`)),
  ];
  const unexplained = unexplainedTally(result);
  if (unexplained) tiles.push(tile(unexplained, plural(unexplained.count, 'unexplained change', 'unexplained changes')));
  const must = result.parts.filter((part) => part.rank?.importance === 'must review').length;
  tiles.push(tile({ state: 'must review', count: must }, `of ${result.parts.length} ${plural(result.parts.length, 'part', 'parts')} must review`));
  return `<div class="dash">${tiles.join('')}</div>`;
}

/** A section's tallies as pills beside its heading. */
function tallyPills(tallies: readonly Tally[]): string {
  return tallies.map(({ state, count }) => ` ${pill(state, `${count} ${state}`)}`).join('');
}

/** A section's rows in the order a reviewer reads them, by state, findings first, each with its index in the section. */
function byState<T>(items: readonly T[], stateOf: (item: T) => string, order: readonly string[]): [T, number][] {
  return items.map((item, index): [T, number] => [item, index]).sort(([a], [b]) => order.indexOf(stateOf(a)) - order.indexOf(stateOf(b)));
}

/** A section's table: the number column, then the headings, then the rows. */
function sectionTable(headings: readonly string[], rows: readonly string[]): string {
  const head = headings.map((heading) => `<th>${escapeHtml(heading)}</th>`).join('');
  return `<table class="ct"><thead><tr><th class="no">#</th>${head}</tr></thead><tbody>${rows.join('')}</tbody></table>`;
}

/**
 * One table row, numbered; with a detail, its number is a toggle that
 * opens the detail in place, in a row of its own edged in the state's
 * colour, and open from the start when asked.
 */
function tableRow(id: string, number: number, state: string, cells: readonly string[], detail: string, open: boolean): string {
  const tds = cells.map((cell) => `<td>${cell}</td>`).join('');
  if (detail === '') return `<tr><td class="no">${number}</td>${tds}</tr>`;
  const toggle = `<button type="button" class="tg" aria-expanded="${open}" aria-controls="${id}" aria-label="${number}: show the reason and evidence">${number}</button>`;
  return (
    `<tr><td class="no">${toggle}</td>${tds}</tr>` +
    `<tr class="ex" id="${id}"${open ? '' : ' hidden'}><td></td><td colspan="${cells.length}"><div class="it edge-${STATES[state]!.tone}">${detail}</div></td></tr>`
  );
}

/** Evidence lines, each a `file:line` chip with its quoted line; after three, the rest fold. */
function foldedLines(lines: readonly string[]): string {
  if (lines.length <= 3) return lines.join('');
  return `${lines.slice(0, 3).join('')}<details class="more"><summary>${lines.length - 3} more</summary>${lines.slice(3).join('')}</details>`;
}

/** A detail's evidence, grouped under each label. */
function evidenceGroups(groups: readonly [string, string][]): string {
  return `<div class="evidence">${groups.map(([label, value]) => `<span class="label">${escapeHtml(label)}</span><span class="v">${value}</span>`).join('')}</div>`;
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

/** Agent text as the page shows it: escaped, each name it sets in backticks as code. */
function withCode(text: string): string {
  return text
    .split('`')
    .map((run, index) => (index % 2 === 1 ? `<code>${escapeHtml(run)}</code>` : escapeHtml(run)))
    .join('');
}

/** One answer: the ask and the part it is about, with its stamp, its sections, and each line it cites as a button that opens it. */
function answerItem(answer: AskAnswer, index: number, state: OverviewState): string {
  const ask = ASKS[answer.ask];
  const shown = state.result.parts[answer.part];
  const part =
    shown !== undefined && (shown.name ?? shown.path) === answer.partName
      ? `<button type="button" class="pt" data-part="${answer.part}">${escapeHtml(answer.partName)}</button>`
      : escapeHtml(answer.partName);
  const sections = answer.sections.map((section) => `<div class="why"><b>${escapeHtml(section.heading)}</b> ${withCode(section.text)}</div>`).join('');
  const cited = answer.cited
    .map(
      (each, at) =>
        `<button type="button" class="pt asked" data-answer="${index}" data-index="${at}">${escapeHtml(`${each.path}:${each.line}${each.side === 'base' ? ' (base)' : ''}`)}</button>` +
        ` <span class="cited">${escapeHtml(each.quote)}</span>`,
    )
    .join('<br>');
  const focus = index === 0 && state.focusAnswer === true ? ' focus' : '';
  return (
    `<li class="answer${focus}"><div class="where"><b>${escapeHtml(ask.title)}</b> · ${part} ${stampChip(stampText(answer.stamp, ask.promptId, answer.promptVersion))}</div>` +
    `${sections}<div class="evidence"><span class="label">Cited</span><span>${cited}</span></div></li>`
  );
}

/**
 * The asks section, at the top of the page once the reviewer has asked
 * about a part: each answer, newest first, with its stamp. Every cited
 * line is one the engine checked: a line the part shows, or one it
 * re-read in the head copy. The agent's text is
 * escaped, its names in backticks set as code.
 */
function asksSection(state: OverviewState): string {
  const answers = state.answers ?? [];
  if (answers.length === 0) return '';
  const note = '<p class="note">Each answers one ask about one part, checked before it is shown: every line it cites is one the part shows or the engine re-read in the head copy.</p>';
  return `<section id="asks"><h2>Asks</h2>${note}<ol class="claims">${answers.map((answer, index) => answerItem(answer, index, state)).join('')}</ol></section>`;
}

/** How the page names each way a pull request links an issue. */
const ISSUE_LINKS: Record<LinkedIssue['link'], string> = {
  closes: 'closes',
  references: 'references',
};

/** A linked issue as the page names it: its number in its repository. */
function issueName(issue: LinkedIssue): string {
  return `#${issue.number} in ${issue.repository}`;
}

/** A criterion's cited lines of one kind, each a chip that opens the line in the head copy, with its quote; or none. */
function citedLines(criterion: number, evidence: CitedEvidence, cited: readonly { path: string; line: number; quote: string }[]): string {
  if (cited.length === 0) return '<span class="none">none</span>';
  return foldedLines(
    cited.map(
      (each, index) =>
        `<span class="l"><button type="button" class="pt ref cite" data-criterion="${criterion}" data-evidence="${evidence}" data-index="${index}">${escapeHtml(`${each.path}:${each.line}`)}</button>` +
        ` <span class="cited">${escapeHtml(each.quote)}</span></span>`,
    ),
  );
}

/**
 * A mapped criterion's evidence: its reason, the code that implements it
 * and the tests that cover it, each a button that opens the line, the
 * manual checks the description reports, each quoted from it with its
 * place a button that jumps to the description, and why
 * the engine dropped the verdict, when it did; nothing for a criterion
 * not checked.
 */
function criterionEvidence(criterion: AcceptanceCriterion, index: number): string {
  const { verdict } = criterion;
  if (verdict.kind === 'not checked') return '';
  const manual =
    verdict.manualChecks.length === 0
      ? '<span class="cited">none reported in the pull request</span>'
      : foldedLines(
          verdict.manualChecks.map(
            (check) =>
              `<span class="l"><button type="button" class="pt ref manual">${escapeHtml(`description, line ${check.line}`)}</button> <q class="quote">${sanitiseUntrusted(check.quote).html}</q></span>`,
          ),
        );
  const recheck = verdict.recheck === undefined ? '' : `<div class="why">${escapeHtml(`dropped to can't tell: ${verdict.recheck}`)}</div>`;
  return (
    `<div class="why">${escapeHtml(verdict.reason)}</div>` +
    evidenceGroups([
      ['Code', citedLines(index, 'code', verdict.code)],
      ['Tests', citedLines(index, 'tests', verdict.tests)],
      ['Manual', manual],
    ]) +
    recheck +
    (isUnmetCriterion(criterion) ? `<div class="acts">${draftButton({ kind: 'criterion', index })}</div>` : '')
  );
}

/** The button that drafts a comment from a finding the page lists. */
function draftButton(finding: FindingRef): string {
  return `<button type="button" class="pt draft" data-draft="${escapeHtml(finding.kind)}" data-index="${finding.index}">Draft comment</button>`;
}

/** One acceptance criterion's row: its verdict, its quote, the issue it comes from as a button that opens it, and, once mapped, its reason and evidence to open. */
function criterionRow(criterion: AcceptanceCriterion, index: number, criteria: NonNullable<ReviewResult['criteria']>, open: boolean): string {
  const issue = criteria.issues[criterion.issue];
  const from =
    issue === undefined
      ? ''
      : `<button type="button" class="pt issue" data-issue="${criterion.issue}">${escapeHtml(issueName(issue))}</button> · ${escapeHtml(ISSUE_LINKS[issue.link])}`;
  const cells = [pill(criterion.verdict.kind), `<q class="quote">${sanitiseUntrusted(criterion.quote).html}</q>`, `<span class="where">${from}</span>`];
  return tableRow(`criterion-${index}`, index + 1, criterion.verdict.kind, cells, criterionEvidence(criterion, index), open);
}

/** What the criteria section says of their verdicts: mapped, why none was, or that none is yet. */
function mappingNote(criteria: NonNullable<ReviewResult['criteria']>): string {
  const mapping = criteria.mapping;
  if (mapping === undefined) return 'None is checked yet.';
  if (mapping.outcome === 'fell back') return `None is checked: ${mapping.detail}.`;
  return (
    'Each is judged against the change, its read-only copy and the manual checks the description reports, ' +
    `by ${stampText(mapping.stamp, 'criteria-mapping', mapping.promptVersion)}; the not met and partly met ones are findings.`
  );
}

/** The issues read but listing no checklist under the heading, each named plainly. */
function issuesWithoutChecklist(criteria: NonNullable<ReviewResult['criteria']>): string {
  const quoted = new Set(criteria.criteria.map((criterion) => criterion.issue));
  const without = criteria.issues.filter((_, index) => !quoted.has(index));
  if (without.length === 0) return '';
  return `<p class="note">No checklist under ${escapeHtml(JSON.stringify(criteria.heading))} in ${without
    .map((issue) => `${escapeHtml(issueName(issue))} (${ISSUE_LINKS[issue.link]})`)
    .join(', ')}.</p>`;
}

/**
 * The acceptance criteria section, at the top of the review after the
 * story: each condition from the issues the pull request links, quoted
 * from the checklist under the heading, its issue a button that opens
 * it, and its verdict — not checked until the agent maps it, then met,
 * partly met, not met, can't tell or needs manual check, with the code,
 * tests and manual checks that show it, and how many have each verdict
 * beside the heading. What was read, and why nothing was — a pull request
 * into a non-default branch among the reasons — is said plainly. Issue
 * text is untrusted: every quote reaches the page escaped, and the
 * content GitHub hides is shown and flagged.
 */
function criteriaSection(state: OverviewState): string {
  const criteria = state.result.criteria;
  if (criteria === undefined) {
    const why = state.running !== undefined ? 'The criteria come once the linked issues are read.' : 'No criteria were read for this review.';
    return `<h2>Acceptance criteria</h2><p class="note">${why}</p>`;
  }
  const detail = `<p class="note">${escapeHtml(criteria.detail)}.</p>`;
  if (criteria.outcome === 'unreadable') {
    return `<h2>Acceptance criteria</h2>${detail}<p class="note">No criteria were read, so none is checked.</p>`;
  }
  const heading = `, quoted from the checklist under ${escapeHtml(JSON.stringify(criteria.heading))}`;
  const note = `<p class="note">Each condition listed in the issues this pull request links${heading}. Issue text is untrusted: its hidden content is shown and flagged. ${escapeHtml(mappingNote(criteria))}</p>`;
  const rows = byState(criteria.criteria, (criterion) => criterion.verdict.kind, CRITERION_ORDER).map(([criterion, index], at) =>
    criterionRow(criterion, index, criteria, at === 0 && isUnmetCriterion(criterion)),
  );
  const list = rows.length === 0 ? '' : sectionTable(['Verdict', 'Criterion', 'From'], rows);
  const { mapping } = criteria;
  const counts = mapping?.outcome === 'mapped' ? tallyPills(criterionTallies(state.result)) : '';
  const title = `Acceptance criteria${counts}${mapping === undefined ? '' : ` ${stampChip(stampText(mapping.stamp, 'criteria-mapping', mapping.promptVersion))}`}`;
  return `<h2>${title}</h2>${detail}${note}${list}${issuesWithoutChecklist(criteria)}`;
}

/** Where a described change is quoted from: a description line, or a linked issue as a button that opens it, with its line. */
function describedWhere(change: DescribedChange, result: ReviewResult): string {
  const { location } = change;
  if (location.kind === 'description') return escapeHtml(`pull request description, line ${location.line}`);
  const issue = result.criteria?.issues[location.issue];
  if (issue === undefined) return escapeHtml(`linked issue, line ${location.line}`);
  return `<button type="button" class="pt issue" data-issue="${location.issue}">${escapeHtml(issueName(issue))}</button> · ${escapeHtml(`line ${location.line}`)}`;
}

/**
 * The unexplained changes section, in both directions: each part neither
 * the description nor a linked issue explains, as a button that opens it,
 * with its one-line reason, then each change they describe that the diff
 * does not contain, quoted from where it is made, with what the diff
 * lacks. The quotes come from untrusted text, so their hidden content is
 * shown and flagged; the agent's reasons reach the page escaped.
 */
function unexplainedSection(state: OverviewState): string {
  const { result } = state;
  const unexplained = result.unexplained;
  if (unexplained === undefined) {
    const why =
      state.running !== undefined
        ? 'The unexplained changes come once the agent has compared the change with its description and issues.'
        : 'The change was not compared with its description and issues for this review.';
    return `<h2>Unexplained changes</h2><p class="note">${why}</p>`;
  }
  const stamp = unexplained.stamp === undefined ? '' : ` ${stampChip(stampText(unexplained.stamp, 'unexplained', unexplained.promptVersion))}`;
  if (unexplained.outcome !== 'compared') {
    const what = unexplained.outcome === 'not compared' ? 'Not compared' : 'No comparison';
    return `<h2>Unexplained changes${stamp}</h2><p class="note">${what}: ${escapeHtml(unexplained.detail)}.</p>`;
  }
  if (unexplained.parts.length === 0 && unexplained.described.length === 0) {
    return `<h2>Unexplained changes${stamp}</h2><p class="note">The agent found every part explained, and every change described in the diff.</p>`;
  }
  const note =
    '<p class="note">The change compared with its description and linked issues in both directions: the parts neither explains, ' +
    'then the changes they describe that the diff does not contain. Each is a finding.</p>';
  const detail = (reason: string, finding: FindingRef): string => `<div class="why">${escapeHtml(reason)}</div><div class="acts">${draftButton(finding)}</div>`;
  const parts = unexplained.parts.map(({ part, reason }, index) => {
    const shown = result.parts[part];
    const button = shown === undefined ? '' : `<button type="button" class="pt" data-part="${part}">${escapeHtml(shown.name ?? shown.path)}</button>`;
    const state = 'in the code, not explained';
    return tableRow(`unexplained-part-${index}`, index + 1, state, [pill(state), button], detail(reason, { kind: 'unexplained part', index }), index === 0);
  });
  const described = unexplained.described.map((change, index) => {
    const state = 'described, not in the code';
    const cells = [pill(state), `<q class="quote">${sanitiseUntrusted(change.quote).html}</q><div class="where">${describedWhere(change, result)}</div>`];
    const number = parts.length + index + 1;
    return tableRow(`described-change-${index}`, number, state, cells, detail(change.reason, { kind: 'described change', index }), number === 1);
  });
  return `<h2>Unexplained changes${tallyPills([unexplainedTally(result)!])}${stamp}</h2>${note}${sectionTable(['State', 'Change'], [...parts, ...described])}`;
}

/** How the page names each claim source. */
const CLAIM_SOURCES: Record<ClaimSource, string> = {
  pipeline: 'pipeline report',
  description: 'pull request description',
  docstring: 'docstring',
  comment: 'comment',
  agent: "the companion's story",
  reviewer: 'your selection',
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
    case 'pipeline': {
      const at = location.path === undefined ? '' : ` · ${location.path}${location.line === undefined ? '' : `:${location.line}`}`;
      return `${source}, ${location.step} step${at}`;
    }
  }
}

/** A citation as the reader reads it: a file's line, or a line of a check's CI log. */
export function citedWhere(cited: { path: string; line: number; ciLog?: true }): string {
  return cited.ciLog ? `CI log of ${cited.path}, line ${cited.line}` : `${cited.path}:${cited.line}`;
}

/**
 * A checked verdict's evidence source, reason, citations, the library it
 * needs — with the library fetch offered for it, or the library source it
 * was judged against — why the engine dropped it, when it did, and that
 * the Verify this claim ask judged the claim alone, when it did;
 * nothing for a claim not checked.
 */
function verdictDetail(claim: Claim, index: number): string {
  const { verdict } = claim;
  if (verdict.kind === 'not checked') return '';
  const reason = [`${verdict.source}: ${verdict.reason}`];
  if (claim.asked === true) reason.push('judged singly by the Verify this claim ask');
  const { library, libraryFetch: offer } = verdict;
  const decompiled = library?.archive === 'decompiled NuGet package';
  // Only a line of the head copy opens: a CI log's line and a line of fetched library source show as text.
  const cited = verdict.evidence.map((each, at) => {
    const where = escapeHtml(`${citedWhere(each)}${decompiled ? ' (decompiled)' : isUnprovenSource(each.path, library?.unproven) ? ' (unproven)' : ''}`);
    const chip =
      each.ciLog === true || library !== undefined
        ? `<span class="ref">${where}</span>`
        : `<button type="button" class="pt ref claim-cite" data-claim="${index}" data-index="${at}">${where}</button>`;
    return `<span class="l">${chip} <span class="cited">${escapeHtml(each.quote)}</span></span>`;
  });
  const evidence = cited.length === 0 ? '' : evidenceGroups([['Evidence', foldedLines(cited)]]);
  const lines: string[] = [];
  if (library !== undefined) {
    lines.push(
      library.archive === 'named repository'
        ? `judged against ${library.library} in ${library.pinnedBy} at tag ${library.pinnedVersion}, which the agent named: a named repository, weaker evidence than pinned source (${library.file})`
        : decompiled
          ? `judged against code decompiled from ${library.library} ${library.pinnedVersion}, as ${library.pinnedBy} pins it: decompiled, not its source (${library.file})`
          : `judged against the source of ${library.library} ${library.pinnedVersion}, as ${library.pinnedBy} pins it (${library.file})`,
    );
    if (library.note !== undefined) lines.push(library.note);
    if (library.unproven !== undefined) lines.push(`unproven, so never verified: ${library.unproven.join(', ')}`);
  } else if (offer !== undefined) {
    lines.push(`${offer.decompile === undefined ? 'library fetch' : 'decompile'} offered: ${offer.reason} Press it on the finding's thread.`);
  } else if (verdict.needsLibrary !== undefined) {
    lines.push(`needs the source of ${verdict.needsLibrary}, which the companion does not have`);
    if (verdict.noLibraryFetch !== undefined) lines.push(verdict.noLibraryFetch);
  }
  if (verdict.recheck !== undefined) lines.push(`dropped to unverifiable: ${verdict.recheck}`);
  const why = (each: string): string => `<div class="why">${escapeHtml(each)}</div>`;
  const draft = isFinding(claim) ? `<div class="acts">${draftButton({ kind: 'claim', index })}</div>` : '';
  return reason.map(why).join('') + evidence + lines.map(why).join('') + draft;
}

/** One claim's row: its verdict, its quote, where it is made with the part it is attached to as a button that opens it, and, once judged, its reason and evidence to open. */
function claimRow(claim: Claim, index: number, result: ReviewResult, open: boolean): string {
  const part = result.parts[claim.part];
  const button =
    part === undefined
      ? ''
      : ` · <button type="button" class="pt" data-part="${claim.part}">${escapeHtml(part.name ?? part.path)}</button>`;
  const cells = [pill(claim.verdict.kind), `<q class="quote">${sanitiseUntrusted(claim.quote).html}</q>`, `<span class="where">${escapeHtml(claimWhere(claim))}${button}</span>`];
  return tableRow(`claim-${index}`, index + 1, claim.verdict.kind, cells, verdictDetail(claim, index), open);
}

/** What the claims section says of their verdicts: judged, why none was, or that none is yet. */
function verdictsNote(claims: NonNullable<ReviewResult['claims']>): string {
  const asked = claims.claims.filter((claim) => claim.asked === true).length;
  const counted = asked === 1 ? 'one checked verdict' : `${asked} checked verdicts`;
  const judging = claims.judging;
  if (judging === undefined) return asked === 0 ? 'None is checked yet.' : `The verdicts pass did not run; the ${counted} came from the Verify this claim ask.`;
  if (judging.outcome === 'fell back') return asked === 0 ? `None is checked: ${judging.detail}.` : `The judging pass fell back (${judging.detail}); the ${counted} came from the Verify this claim ask.`;
  return (
    `Each is judged against the change, its read-only copy and any failed check's CI log by ${stampText(judging.stamp, 'verdicts', judging.promptVersion)}` +
    (asked === 0 ? '' : `, save the ${counted} that came from the Verify this claim ask`) +
    '; the refuted and unverifiable ones are findings, each a thread on the diff.'
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
  if (claims.outcome === 'fell back' && claims.claims.length === 0) return `<h2>Claims ${stamp}</h2><p class="note">No claims: ${escapeHtml(claims.detail)}.</p>`;
  if (claims.claims.length === 0) return `<h2>Claims ${stamp}</h2><p class="note">The agent found no claim in the change.</p>`;
  const note =
    '<p class="note">Statements about how code or a library behaves, from a fresh pipeline report, the description, the docstrings and comments ' +
    `the change adds, and the story, in that order. ${escapeHtml(verdictsNote(claims))}</p>`;
  const askedListed = claims.claims.some((claim) => claim.asked === true);
  const fellBack =
    claims.outcome === 'fell back'
      ? `<p class="note">Only the pipeline's claims are listed${askedListed ? ', with any the reviewer asked to verify' : ''}: ${escapeHtml(claims.detail)}.</p>`
      : '';
  const rows = byState(claims.claims, (claim) => claim.verdict.kind, CLAIM_ORDER).map(([claim, index], at) => claimRow(claim, index, result, at === 0 && isFinding(claim)));
  return `<h2>Claims${tallyPills(claimTallies(result))} ${stamp}</h2>${fellBack}${note}${sectionTable(['Verdict', 'Claim', 'Where it is made'], rows)}`;
}

/** How the page names each state of the pipeline report. */
const ATTESTATIONS: Record<ReviewResult['pipeline']['attestation'], string> = {
  fresh: 'fresh',
  stale: 'stale',
  missing: 'none',
  malformed: 'unreadable',
};

/** The pipeline report: its state with why, its steps, and the findings it leaves open, each as escaped text. */
function pipelineBlock(result: ReviewResult): string {
  const { pipeline } = result;
  const state = `<p><span class="att ${pipeline.attestation}">no-mistakes report: ${escapeHtml(ATTESTATIONS[pipeline.attestation])}</span> <span class="note">${escapeHtml(pipeline.detail)}.</span></p>`;
  const steps = pipeline.steps.length === 0 ? '' : `<div class="note">steps: ${escapeHtml(pipeline.steps.map((step) => `${step.step} ${step.status}`).join(' · '))}</div>`;
  const trust = pipeline.attestation === 'fresh' ? 'each is a claim, listed first' : 'not trusted, so none is a claim';
  const findings =
    pipeline.findings.length === 0
      ? ''
      : `<p class="note">Open findings, ${escapeHtml(trust)}:</p><ul class="findings">${pipeline.findings
          .map((finding) => {
            const at = finding.path === undefined ? '' : ` · ${finding.path}${finding.line === undefined ? '' : `:${finding.line}`}`;
            return `<li><span class="sev ${finding.severity}">${escapeHtml(finding.severity)}</span> ${sanitiseUntrusted(finding.text).html}<div class="where">${escapeHtml(`${finding.step} step${at}`)}</div></li>`;
          })
          .join('')}</ul>`;
  return state + steps + findings;
}

/** One check run: its conclusion, its annotations, and a failed job's trimmed log, labelled as a CI log. */
function checkItem(check: CheckRun): string {
  const outcome = check.conclusion ?? check.status;
  const tone = checkFailed(check.conclusion) ? 'failed' : check.conclusion === 'success' ? 'passed' : 'other';
  const annotations = check.annotations
    .map((annotation) => {
      const lines =
        annotation.startLine === undefined
          ? ''
          : annotation.endLine !== undefined && annotation.endLine > annotation.startLine
            ? `:${annotation.startLine}–${annotation.endLine}`
            : `:${annotation.startLine}`;
      const title = annotation.title === undefined ? '' : `${annotation.title}: `;
      return `<div class="why">${escapeHtml(`${annotation.level} · ${annotation.path}${lines} — ${title}${annotation.message}`)}</div>`;
    })
    .join('');
  const { log } = check;
  const logBlock =
    log === undefined
      ? ''
      : `<div class="why">CI log${log.step === undefined ? '' : ` of the step ${escapeHtml(JSON.stringify(log.step))}`}: ${escapeHtml(log.detail)}</div>` +
        (log.lines.length === 0 ? '' : `<pre class="log">${log.lines.map((line, at) => `${at + 1}: ${sanitiseUntrusted(line).html}`).join('\n')}</pre>`);
  return `<li><span class="check ${tone}">${escapeHtml(outcome)}</span> ${escapeHtml(check.name)}${annotations}${logBlock}</li>`;
}

/** The CI read at the head commit, labelled as run on the merge commit, or why there is none. */
function ciBlock(result: ReviewResult): string {
  const { ci } = result;
  if (ci === undefined) return '<p class="note">No CI was read for this review.</p>';
  const merge = ci.mergeCommit === undefined ? 'the merge commit' : `merge commit ${ci.mergeCommit.slice(0, 7)}`;
  const head = `<p class="note">Checks listed at head ${escapeHtml(ci.headSha.slice(0, 7))}, ran on ${escapeHtml(merge)}: ${escapeHtml(ci.detail)}.</p>`;
  if (ci.checks.length === 0) return head;
  return `${head}<ul class="checks">${ci.checks.map(checkItem).join('')}</ul>`;
}

/** A documentation link: the API, its library as pinned, its page as a button that opens it, and where it came from. */
function docLinkItem(link: DocLink, index: number): string {
  const where = link.uses.slice(0, 3).map((use) => `${use.path}:${use.line}`).join(', ');
  const library = link.ecosystem === '.NET' ? `.NET ${link.version}` : `${link.library} ${link.version}`;
  const source =
    link.from === 'inventory'
      ? `From the published inventory of ${library}, as ${link.pinnedBy} pins it`
      : `Suggested by the agent from what it knows, for ${library} as ${link.pinnedBy} pins it; not checked`;
  const flag = link.from === 'agent' ? '<span class="flag">suggested</span>' : '';
  return (
    `<li>${flag}<code>${escapeHtml(link.api)}</code> <button type="button" class="pt doc" data-doc="${index}">${escapeHtml(link.url)}</button>` +
    `<div class="where">${escapeHtml(`${source} · used at ${where}`)}</div></li>`
  );
}

/**
 * The documentation section: the library APIs the change uses, each
 * linked to its documentation at the pinned version — every link read
 * from a published inventory first, then the agent's suggestions, each
 * flagged as suggested and not checked — then the APIs no link was found
 * for, and the notes on what was read and what the cap left out.
 */
function docsSection(state: OverviewState): string {
  const docs = state.result.docLinks;
  if (docs === undefined) {
    const why = state.running !== undefined ? 'The documentation links come once the review is done.' : 'No documentation links were looked for in this review.';
    return `<h2>Documentation</h2><p class="note">${why}</p>`;
  }
  const suggestions = docs.suggestions;
  const stamp = suggestions === undefined ? '' : ` ${stampChip(stampText(suggestions.stamp, 'doc-links', suggestions.promptVersion))}`;
  const read = docs.links.flatMap((link, index) => (link.from === 'inventory' ? [docLinkItem(link, index)] : []));
  const suggested = docs.links.flatMap((link, index) => (link.from === 'agent' ? [docLinkItem(link, index)] : []));
  const none = docs.links.length === 0 && docs.unlinked.length === 0 ? '<p class="note">The change uses no pinned library API the companion links.</p>' : '';
  const readList = read.length === 0 ? '' : `<ol class="claims">${read.join('')}</ol>`;
  const fellBack = suggestions?.outcome === 'fell back' ? `<p class="note">No suggestions: ${escapeHtml(suggestions.detail)}.</p>` : '';
  const suggestedList =
    suggested.length === 0
      ? ''
      : `<p class="note">Suggested by the agent for the APIs no inventory linked. Nothing checked these pages: open them knowing that.</p><ol class="claims">${suggested.join('')}</ol>`;
  const unlinked =
    docs.unlinked.length === 0
      ? ''
      : `<p class="note">No documentation link found for ${docs.unlinked.map((api) => `<code>${escapeHtml(api.api)}</code> (${escapeHtml(`${api.library} ${api.version}`)})`).join(', ')}.</p>`;
  const notes = docs.notes.map((note) => `<p class="note">${escapeHtml(note)}.</p>`).join('');
  return `<h2>Documentation${stamp}</h2>${none}${readList}${fellBack}${suggestedList}${unlinked}${notes}`;
}

/** The pipeline and CI section: the no-mistakes report and whether it is trusted, then the checks. */
function pipelineSection(result: ReviewResult): string {
  return `<h2>Pipeline and CI</h2>${pipelineBlock(result)}${ciBlock(result)}`;
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
  const unexplained = result.unexplained;
  if (unexplained) {
    rows.push([
      'Unexplained changes',
      unexplained.outcome === 'compared' && unexplained.stamp
        ? `compared by ${stampText(unexplained.stamp, 'unexplained', unexplained.promptVersion)}: ${unexplained.detail}`
        : `none: ${unexplained.detail}`,
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
  const judging = claims?.judging;
  if (judging) {
    rows.push([
      'Verdicts',
      judging.outcome === 'judged'
        ? `judged by ${stampText(judging.stamp, 'verdicts', judging.promptVersion)}: ${judging.detail}`
        : `none: ${judging.detail}`,
    ]);
  }
  const mapping = result.criteria?.mapping;
  if (mapping) {
    rows.push([
      'Acceptance criteria',
      mapping.outcome === 'mapped'
        ? `mapped by ${stampText(mapping.stamp, 'criteria-mapping', mapping.promptVersion)}: ${mapping.detail}`
        : `none: ${mapping.detail}`,
    ]);
  }
  const docs = result.docLinks;
  if (docs) {
    const read = docs.links.filter((link) => link.from === 'inventory').length;
    const suggestions = docs.suggestions;
    const suggested =
      suggestions === undefined
        ? 'no agent was asked for suggestions'
        : suggestions.outcome === 'suggested'
          ? `suggested by ${stampText(suggestions.stamp, 'doc-links', suggestions.promptVersion)}: ${suggestions.detail}`
          : `no suggestions: ${suggestions.detail}`;
    rows.push(['Documentation links', `${read} read from published inventories at the pinned version; ${suggested}`]);
  }
  const items = rows.map(([what, how]) => `<li><b>${escapeHtml(what)}</b> ${escapeHtml(how)}</li>`).join('');
  return `<h2>How these results were made</h2><ul class="stamps">${items}</ul>`;
}

/** One rail entry, a button that scrolls to its section: the section's icon and name, and its first tally's count in that state's colour. */
function railEntry(id: string, name: string, icon: string, first?: Tally): string {
  if (first === undefined) return `<button type="button" class="ri" data-section="${id}"><span class="ic" aria-hidden="true">${icon}</span>${escapeHtml(name)}</button>`;
  const { tone, icon: stateIcon } = STATES[first.state]!;
  return (
    `<button type="button" class="ri" data-section="${id}" aria-label="${escapeHtml(`${name}, ${first.count} ${first.state}`)}">` +
    `<span class="ic tone-${tone}" aria-hidden="true">${stateIcon}</span>${escapeHtml(name)}<span class="n tone-${tone}">${first.count}</span></button>`
  );
}

/**
 * The contents rail, shown beside the reading column on wide windows:
 * every section in page order, each with its count in colour, findings
 * counted first. The page's script scrolls to the section an entry
 * names and highlights the one in view.
 */
function contentsRail(state: OverviewState): string {
  const { result } = state;
  const answers = state.answers?.length ?? 0;
  const links = result.docLinks?.links.length ?? 0;
  const failed = result.ci?.checks.filter((check) => checkFailed(check.conclusion)).length ?? 0;
  const entries = [
    answers === 0 ? '' : railEntry('asks', 'Asks', '↳', { state: 'answered', count: answers }),
    railEntry('story', 'Story', '¶'),
    railEntry('criteria', 'Acceptance criteria', '○', criterionTallies(result)[0]),
    railEntry('unexplained', 'Unexplained changes', '○', unexplainedTally(result)),
    railEntry('claims', 'Claims', '○', claimTallies(result)[0]),
    railEntry('docs', 'Documentation', '↗', links === 0 ? undefined : { state: 'links', count: links }),
    railEntry('pipeline', 'Pipeline and CI', '▸', failed === 0 ? undefined : { state: 'failed', count: failed }),
    railEntry('description', 'Pull request description', '≡'),
    railEntry('stamps', 'How these results were made', 'i'),
  ];
  return `<nav class="rail" aria-label="On this page"><div class="rh">On this page</div>${entries.join('')}</nav>`;
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
  /* State colours come from the theme, each always beside an icon and a word; the fallbacks pass WCAG AA. */
  :root {
    --ok: var(--vscode-testing-iconPassed, #73c991);
    --bad: var(--vscode-errorForeground, #f48771);
    --warn: var(--vscode-editorWarning-foreground, #e2c08d);
    --info: var(--vscode-editorInfo-foreground, #75beff);
    --must: var(--vscode-charts-purple, #d7a4f5);
    --mut: var(--vscode-descriptionForeground, #9d9d9d);
  }
  body.vscode-high-contrast {
    --ok: var(--vscode-testing-iconPassed, #89d185);
    --warn: var(--vscode-editorWarning-foreground, #ffd700);
    --must: var(--vscode-charts-purple, #e0b0ff);
    --mut: var(--vscode-descriptionForeground, #c8c8c8);
  }
  /* The light themes' own passed, warning and info colours fall below AA on a light editor (#bf8803 is 3.1:1 on white), so light themes take the AA colours. */
  body.vscode-light, body.vscode-high-contrast-light { --ok: #2d7a32; --bad: #b3261e; --warn: #855d00; --info: #005fb8; --must: #7a3fa8; --mut: #616161; }
  .tone-ok { color: var(--ok); } .tone-bad { color: var(--bad); } .tone-warn { color: var(--warn); }
  .tone-info { color: var(--info); } .tone-must { color: var(--must); } .tone-mut { color: var(--mut); }
  .edge-ok { border-left-color: var(--ok); } .edge-bad { border-left-color: var(--bad); } .edge-warn { border-left-color: var(--warn); }
  .edge-info { border-left-color: var(--info); } .edge-must { border-left-color: var(--must); } .edge-mut { border-left-color: var(--mut); }
  body {
    color: var(--vscode-foreground);
    background-color: var(--vscode-editor-background);
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size, 13px);
    margin: 0;
  }
  .page { display: flex; justify-content: center; gap: 32px; padding: 0 26px; }
  main { flex: 0 1 880px; min-width: 0; padding: 18px 0 48px; }
  main > section { border: 1px solid var(--vscode-panel-border); border-radius: 6px; padding: 2px 14px 12px; margin: 0 0 12px; scroll-margin-top: 12px; }
  .rail { flex: none; width: 210px; position: sticky; top: 0; align-self: flex-start; max-height: 100vh; overflow-y: auto; padding: 18px 0; box-sizing: border-box; }
  @media (max-width: 1100px) { .rail { display: none; } }
  .rh { color: var(--mut); font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: .06em; margin: 0 0 6px 10px; }
  .ri { display: flex; align-items: center; gap: 7px; width: 100%; font: inherit; font-size: 12.5px; color: var(--vscode-foreground); background: none; border: 0; border-left: 2px solid transparent; padding: 3px 8px; text-align: left; cursor: pointer; }
  .ri:hover { background: var(--vscode-list-hoverBackground); }
  .ri.on { border-left-color: var(--vscode-focusBorder); font-weight: 600; }
  .ri .ic { width: 1em; text-align: center; }
  .ri .n { margin-left: auto; font-weight: 600; font-variant-numeric: tabular-nums; }
  .ri:focus-visible, .tg:focus-visible, .pt:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px; }
  h1 { font-size: 20px; font-weight: 600; margin: 0 0 4px; }
  h2 { font-size: 15px; font-weight: 600; margin: 10px 0 8px; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .meta, .note { color: var(--mut); font-size: 12px; }
  .note { margin: 0 0 6px; }
  .stages { display: flex; gap: 6px; flex-wrap: wrap; margin: 10px 0 4px; }
  .stg { font-size: 12px; border: 1px solid var(--vscode-panel-border); border-radius: 12px; padding: 1px 9px; }
  .stg.done::before { content: "✓ "; color: var(--ok); }
  .stg.run { color: var(--mut); }
  .stamp { margin-left: auto; font-size: 11px; font-weight: 400; color: var(--mut); }
  .dash { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 8px; margin: 12px 0; }
  .tile { border: 1px solid var(--vscode-panel-border); border-radius: 6px; padding: 8px 10px; }
  .tile .big { font-size: 20px; font-weight: 700; line-height: 1.2; }
  .tile .lb { font-size: 12px; }
  .pl { display: inline-flex; align-items: center; gap: 4px; font-size: 12px; font-weight: 600; border: 1px solid currentColor; border-radius: 4px; padding: 0 6px; white-space: nowrap; }
  .ct { width: 100%; border-collapse: collapse; font-size: 12.5px; }
  .ct th, .ct td { border-bottom: 1px solid var(--vscode-panel-border); padding: 5px 6px; text-align: left; vertical-align: top; }
  .ct th { color: var(--mut); font-size: 11px; font-weight: 600; text-transform: uppercase; }
  .ct .no { width: 34px; white-space: nowrap; color: var(--mut); }
  .ct tr.ex td { padding-top: 0; }
  .tg { font: inherit; color: var(--vscode-foreground); background: none; border: 0; padding: 0; cursor: pointer; white-space: nowrap; }
  .tg::before { content: "▸ "; }
  .tg[aria-expanded="true"]::before { content: "▾ "; }
  .it { border-left: 3px solid var(--mut); padding: 4px 10px 6px; margin: 2px 0 4px; }
  .acts { margin-top: 6px; }
  .ref { font-family: var(--vscode-editor-font-family, monospace); font-size: 11.5px; border: 1px solid var(--vscode-panel-border); border-radius: 3px; padding: 0 4px; white-space: nowrap; }
  .more summary { color: var(--mut); cursor: pointer; font-size: 12px; }
  .story {
    font-size: 13.5px;
    line-height: 1.55;
  }
  .sentence.focus, .answer.focus { background-color: var(--vscode-editor-findMatchHighlightBackground); }
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
  .pt.ref { font-family: var(--vscode-editor-font-family, monospace); font-size: 11.5px; border: 1px solid var(--vscode-panel-border); padding: 0 4px; }
  .issue { font-style: italic; }
  code, .shown { font-family: var(--vscode-editor-font-family, monospace); font-size: 12px; }
  .description {
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    border: 1px solid var(--vscode-panel-border);
    border-radius: 3px;
    padding: 10px 12px;
  }
  .alert {
    border-left: 3px solid var(--warn);
    padding: 4px 10px;
    margin: 0 0 8px;
  }
  .hidden {
    border: 1px dashed var(--warn);
    border-radius: 3px;
    padding: 0 4px;
  }
  .flag {
    color: var(--warn);
    font-size: 11px;
    font-weight: 600;
    margin-right: 6px;
  }
  .claims { padding-left: 22px; margin: 0; }
  .claims li { margin-bottom: 8px; }
  .quote { overflow-wrap: anywhere; }
  .where { color: var(--mut); font-size: 12px; margin-top: 2px; }
  .why { font-size: 12px; overflow-wrap: anywhere; margin: 2px 0; }
  .evidence { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 4px 10px; font-size: 12px; margin-top: 4px; }
  .evidence .label { color: var(--mut); font-size: 11px; text-transform: uppercase; letter-spacing: .05em; padding-top: 1px; }
  .evidence .v { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
  .evidence .l { display: flex; gap: 8px; align-items: baseline; min-width: 0; }
  .evidence .cited, .evidence .l .quote { min-width: 0; overflow-wrap: anywhere; }
  .cited { color: var(--mut); }
  .none { color: var(--warn); }
  .findings, .checks { padding-left: 18px; margin: 0; }
  .findings li, .checks li { margin-bottom: 6px; overflow-wrap: anywhere; }
  .att, .sev, .check { font-size: 11px; font-weight: 600; border: 1px solid var(--vscode-panel-border); border-radius: 10px; padding: 0 7px; }
  .att.stale, .att.malformed, .sev.warning { color: var(--warn); }
  .sev.error, .check.failed { color: var(--bad); }
  .att.fresh, .check.passed { color: var(--ok); }
  .att.fresh::before, .check.passed::before { content: "✓ "; }
  .att.stale::before, .att.malformed::before { content: "! "; }
  .check.failed::before { content: "✕ "; }
  .log {
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 12px;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    border: 1px solid var(--vscode-panel-border);
    border-radius: 3px;
    padding: 6px 10px;
    margin: 4px 0;
    max-height: 320px;
    overflow-y: auto;
  }
  .stamps { padding-left: 18px; margin: 0; }
  .stamps li { margin-bottom: 4px; }
</style>
</head>
<body>
<div class="page">
<main>
  <h1>${escapeHtml(result.pullRequest.title)}</h1>
  <div class="meta">${metaLine(result)}</div>
  ${sinceLine(result)}
  <div class="stages">${stageChips(state)}</div>
  ${countTiles(result)}
  ${asksSection(state)}
  <section id="story">${storySection(state)}</section>
  <section id="criteria">${criteriaSection(state)}</section>
  <section id="unexplained">${unexplainedSection(state)}</section>
  <section id="claims">${claimsSection(state)}</section>
  <section id="docs">${docsSection(state)}</section>
  <section id="pipeline">${pipelineSection(result)}</section>
  <section id="description">${descriptionSection(result)}</section>
  <section id="stamps">${stampsSection(state)}</section>
</main>
${contentsRail(state)}
</div>
<script nonce="${nonce}">
(function () {
  'use strict';
  var vscode = acquireVsCodeApi();
  Array.prototype.forEach.call(document.querySelectorAll('button.pt[data-part]'), function (button) {
    button.addEventListener('click', function () {
      vscode.postMessage({ type: 'openPart', part: Number(button.getAttribute('data-part')) });
    });
  });
  Array.prototype.forEach.call(document.querySelectorAll('button.issue'), function (button) {
    button.addEventListener('click', function () {
      vscode.postMessage({ type: 'openIssue', issue: Number(button.getAttribute('data-issue')) });
    });
  });
  Array.prototype.forEach.call(document.querySelectorAll('button.doc'), function (button) {
    button.addEventListener('click', function () {
      vscode.postMessage({ type: 'openDoc', doc: Number(button.getAttribute('data-doc')) });
    });
  });
  Array.prototype.forEach.call(document.querySelectorAll('button.cite'), function (button) {
    button.addEventListener('click', function () {
      vscode.postMessage({
        type: 'openEvidence',
        criterion: Number(button.getAttribute('data-criterion')),
        evidence: button.getAttribute('data-evidence'),
        index: Number(button.getAttribute('data-index'))
      });
    });
  });
  Array.prototype.forEach.call(document.querySelectorAll('button.asked'), function (button) {
    button.addEventListener('click', function () {
      vscode.postMessage({ type: 'openCited', answer: Number(button.getAttribute('data-answer')), index: Number(button.getAttribute('data-index')) });
    });
  });
  Array.prototype.forEach.call(document.querySelectorAll('button.draft'), function (button) {
    button.addEventListener('click', function () {
      vscode.postMessage({ type: 'draft', finding: button.getAttribute('data-draft'), index: Number(button.getAttribute('data-index')) });
    });
  });
  Array.prototype.forEach.call(document.querySelectorAll('button.manual'), function (button) {
    button.addEventListener('click', function () {
      var description = document.getElementById('description');
      if (description !== null) {
        description.scrollIntoView({ block: 'start' });
      }
    });
  });
  Array.prototype.forEach.call(document.querySelectorAll('button.claim-cite'), function (button) {
    button.addEventListener('click', function () {
      vscode.postMessage({ type: 'openClaimEvidence', claim: Number(button.getAttribute('data-claim')), index: Number(button.getAttribute('data-index')) });
    });
  });
  Array.prototype.forEach.call(document.querySelectorAll('button.tg'), function (button) {
    button.addEventListener('click', function () {
      var row = document.getElementById(button.getAttribute('aria-controls'));
      if (row === null) return;
      var open = button.getAttribute('aria-expanded') !== 'true';
      button.setAttribute('aria-expanded', String(open));
      row.hidden = !open;
    });
  });
  // The rail: each entry scrolls to its section, and the entry of the section in view is highlighted.
  var entries = Array.prototype.slice.call(document.querySelectorAll('button.ri'));
  var clicked = null;
  function spy() {
    var current = null;
    entries.forEach(function (entry) {
      var section = document.getElementById(entry.getAttribute('data-section'));
      if (section !== null && (current === null || section.getBoundingClientRect().top <= 80)) current = section;
    });
    // At the page's end a short last section cannot reach the top: the clicked one, in view, is the one shown.
    var atEnd = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 2;
    if (atEnd && clicked !== null && clicked.getBoundingClientRect().top < window.innerHeight) current = clicked;
    entries.forEach(function (entry) {
      var on = current !== null && entry.getAttribute('data-section') === current.id;
      entry.classList.toggle('on', on);
      if (on) entry.setAttribute('aria-current', 'location');
      else entry.removeAttribute('aria-current');
    });
  }
  entries.forEach(function (entry) {
    entry.addEventListener('click', function () {
      var section = document.getElementById(entry.getAttribute('data-section'));
      if (section === null) return;
      clicked = section;
      section.scrollIntoView({ block: 'start' });
      spy();
    });
  });
  window.addEventListener('scroll', spy, { passive: true });
  spy();
  var focused = document.querySelector('.answer.focus') || document.querySelector('.sentence.focus');
  if (focused !== null) {
    focused.scrollIntoView({ block: 'center' });
  }
}());
</script>
</body>
</html>`;
}
