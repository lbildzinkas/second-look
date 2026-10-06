import * as vscode from 'vscode';
import { randomUUID } from 'node:crypto';
import {
  checkFailed,
  hiddenContent,
  isFinding,
  isUnprovenSource,
  parsePullRequestUrl,
  type AcceptanceCriterion,
  type AgentStamp,
  type CheckRun,
  type Claim,
  type ClaimSource,
  type HiddenKind,
  type LinkedIssue,
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
  type: 'openPart' | 'openIssue';
  /** The part or the linked issue, by its index in the result's parts or the criteria's issues. */
  target: number;
}

/** Reads a page message out of what the webview delivered, if it is one. */
function overviewMessage(value: unknown): OverviewMessage | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const { type, part, issue } = value as Record<string, unknown>;
  if (type === 'openPart' && Number.isInteger(part)) return { type, target: part as number };
  if (type === 'openIssue' && Number.isInteger(issue)) return { type, target: issue as number };
  return undefined;
}

/**
 * The review's overview (issue #30), the tab at the top of the review in
 * the recorded design (docs/ux): the pull request's title and where it
 * comes from, a chip for each stage done and the one still running, the
 * story with its stamp, each part it mentions a button that opens the part
 * in the diff editor, the acceptance criteria of the linked issues, each
 * quoted and its issue a button that opens it on GitHub, the claims the
 * change makes with where each is made and the part it is attached to, the
 * pipeline report and whether it is trusted, the checks run on the merge
 * commit with their annotations and failed jobs' trimmed logs, the pull
 * request's description in full with its hidden content shown and flagged,
 * and who made each result.
 *
 * Everything on the page but the companion's own words was written by
 * someone else, the agent's story, the claims' quotes, the criteria's
 * quotes from untrusted issue text, the pipeline's findings and the CI's
 * logs included, so every byte of it reaches the page as escaped text:
 * no remote image, no link and no markup of theirs
 * renders, under a content security policy that loads nothing but the
 * page's own nonce-marked style and script.
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

  /** The part a story or claim button names, opened in the diff editor; a criterion's issue, opened on GitHub. */
  private handle(value: unknown): void {
    const message = overviewMessage(value);
    if (message === undefined) return;
    if (message.type === 'openPart') {
      const part = this.state?.result.parts[message.target];
      if (part !== undefined) this.openPart(part);
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
  const judging = result.claims?.judging;
  if (judging) chips.push({ text: judging.outcome === 'judged' ? 'verdicts' : 'no verdicts', done: true });
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

/** How the page names each way a pull request links an issue. */
const ISSUE_LINKS: Record<LinkedIssue['link'], string> = {
  closes: 'closes',
  references: 'references',
};

/** A linked issue as the page names it: its number in its repository. */
function issueName(issue: LinkedIssue): string {
  return `#${issue.number} in ${issue.repository}`;
}

/** One acceptance criterion: its quote, the issue it comes from as a button that opens it, and its verdict. */
function criterionItem(criterion: AcceptanceCriterion, criteria: NonNullable<ReviewResult['criteria']>): string {
  const issue = criteria.issues[criterion.issue];
  const from =
    issue === undefined
      ? ''
      : `<button type="button" class="pt issue" data-issue="${criterion.issue}">${escapeHtml(issueName(issue))}</button> · ${escapeHtml(ISSUE_LINKS[issue.link])} · `;
  return (
    `<li><q class="quote">${sanitiseUntrusted(criterion.quote).html}</q>` +
    `<div class="where">${from}<span class="verdict">${escapeHtml(criterion.verdict.kind)}</span></div></li>`
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
 * The acceptance criteria section: each condition from the issues the
 * pull request links, quoted from the checklist under the heading, its
 * issue a button that opens it, and its verdict — not checked, since
 * judging them is a later pass. What was read, and why nothing was — a
 * pull request into a non-default branch among the reasons — is said
 * plainly. Issue text is untrusted: every quote reaches the page escaped,
 * and the content GitHub hides is shown and flagged.
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
  const note = `<p class="note">Each condition listed in the issues this pull request links${heading}. Issue text is untrusted: its hidden content is shown and flagged. None is checked yet.</p>`;
  const list =
    criteria.criteria.length === 0
      ? ''
      : `<ol class="claims criteria">${criteria.criteria.map((criterion) => criterionItem(criterion, criteria)).join('')}</ol>`;
  return `<h2>Acceptance criteria</h2>${detail}${note}${list}${issuesWithoutChecklist(criteria)}`;
}

/** How the page names each claim source. */
const CLAIM_SOURCES: Record<ClaimSource, string> = {
  pipeline: 'pipeline report',
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
 * was judged against — and why the engine dropped it, when it did;
 * nothing for a claim not checked.
 */
function verdictDetail(claim: Claim): string {
  const { verdict } = claim;
  if (verdict.kind === 'not checked') return '';
  const lines = [`${verdict.source}: ${verdict.reason}`];
  const { library, libraryFetch: offer } = verdict;
  const decompiled = library?.archive === 'decompiled NuGet package';
  for (const cited of verdict.evidence) {
    lines.push(`${citedWhere(cited)}${decompiled ? ' (decompiled)' : isUnprovenSource(cited.path, library?.unproven) ? ' (unproven)' : ''} — ${cited.quote}`);
  }
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
  return lines.map((line) => `<div class="why">${escapeHtml(line)}</div>`).join('');
}

/** One claim: its quote, where it is made, the part it is attached to as a button that opens it, and its verdict with its evidence. */
function claimItem(claim: Claim, result: ReviewResult): string {
  const part = result.parts[claim.part];
  const button =
    part === undefined
      ? ''
      : ` · <button type="button" class="pt" data-part="${claim.part}">${escapeHtml(part.name ?? part.path)}</button>`;
  return (
    `<li><q class="quote">${sanitiseUntrusted(claim.quote).html}</q>` +
    `<div class="where">${escapeHtml(claimWhere(claim))}${button} · <span class="verdict${isFinding(claim) ? ' finding' : ''}">${escapeHtml(claim.verdict.kind)}</span></div>` +
    `${verdictDetail(claim)}</li>`
  );
}

/** What the claims section says of their verdicts: judged, why none was, or that none is yet. */
function verdictsNote(claims: NonNullable<ReviewResult['claims']>): string {
  const judging = claims.judging;
  if (judging === undefined) return 'None is checked yet.';
  if (judging.outcome === 'fell back') return `None is checked: ${judging.detail}.`;
  return (
    `Each is judged against the change, its read-only copy and any failed check's CI log by ${stampText(judging.stamp, 'verdicts', judging.promptVersion)}; ` +
    'the refuted and unverifiable ones are findings, each a thread on the diff.'
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
  const fellBack = claims.outcome === 'fell back' ? `<p class="note">Only the pipeline's claims are listed: ${escapeHtml(claims.detail)}.</p>` : '';
  return `<h2>Claims ${stamp}</h2>${fellBack}${note}<ol class="claims">${claims.claims.map((claim) => claimItem(claim, result)).join('')}</ol>`;
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
  .verdict.finding { color: var(--vscode-editorWarning-foreground); font-weight: 600; }
  .why { color: var(--vscode-descriptionForeground); font-size: 12px; overflow-wrap: anywhere; }
  .findings, .checks { padding-left: 18px; margin: 0; }
  .findings li, .checks li { margin-bottom: 6px; overflow-wrap: anywhere; }
  .att, .sev, .check { font-size: 11px; font-weight: 600; border: 1px solid var(--vscode-panel-border); border-radius: 10px; padding: 0 7px; }
  .att.stale, .att.malformed, .sev.error, .sev.warning, .check.failed { color: var(--vscode-editorWarning-foreground); }
  .att.fresh, .check.passed { color: var(--vscode-testing-iconPassed, #89d185); }
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
<main>
  <h1>${escapeHtml(result.pullRequest.title)}</h1>
  <div class="meta">${metaLine(result)}</div>
  <div class="stages">${stageChips(state)}</div>
  <section id="story">${storySection(state)}</section>
  <section id="criteria">${criteriaSection(state)}</section>
  <section id="claims">${claimsSection(state)}</section>
  <section id="pipeline">${pipelineSection(result)}</section>
  <section id="description">${descriptionSection(result)}</section>
  <section id="stamps">${stampsSection(state)}</section>
</main>
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
  var focused = document.querySelector('.sentence.focus');
  if (focused !== null) {
    focused.scrollIntoView({ block: 'center' });
  }
}());
</script>
</body>
</html>`;
}
