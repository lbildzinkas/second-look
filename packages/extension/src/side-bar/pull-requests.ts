import { parsePullRequestUrl, type ListedPullRequest, type PullRequestGroup, type PullRequestGroupKind } from '@second-look/engine';
import { escapeHtml } from '../overview.js';

/** The chips above the list, each showing every group or one. */
export type PullRequestChip = 'all' | 'review requested' | 'yours' | 'involving you';

/** Step 2's list of the reviewer's open pull requests (issue 137), as it stands. */
export interface PullRequestPickerView {
  list:
    | { state: 'not loaded' }
    | { state: 'loading' }
    /** `readAt` is when the list was read, which the ages count to. */
    | { state: 'listed'; groups: PullRequestGroup[]; readAt: string }
    | { state: 'signed out'; reason: string }
    | { state: 'unreachable'; reason: string }
    | { state: 'failed'; message: string };
  /** The box's text: the filter, or a pasted pull request URL. */
  filter: string;
  chip: PullRequestChip;
}

/** The presses and the typing in step 2's list. */
export type PullRequestAction = 'show' | 'filter' | 'go' | 'chip' | 'review' | 'signIn' | 'reload';

/**
 * A change or a press in step 2's list, as the side bar's script reports
 * it: `pasted` when the box's text arrived by a paste.
 */
export interface PullRequestMessage {
  type: 'pullRequests';
  action: PullRequestAction;
  value: string;
  pasted: boolean;
}

const ACTIONS: readonly PullRequestAction[] = ['show', 'filter', 'go', 'chip', 'review', 'signIn', 'reload'];

const CHIPS: Record<PullRequestChip, string> = {
  all: 'All',
  'review requested': 'Review requested',
  yours: 'Mine',
  'involving you': 'Involving',
};

const GROUP_TITLES: Record<PullRequestGroupKind, string> = {
  'review requested': 'Review requested from you',
  yours: 'Your pull requests',
  'involving you': 'Involving you',
  'this repository': 'Open in this repository',
};

/** Reads a step 2 list message out of what the webview delivered, if it is one. */
export function pullRequestMessage(value: unknown): PullRequestMessage | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const { type, action, value: text, pasted } = value as Record<string, unknown>;
  if (type !== 'pullRequests' || typeof text !== 'string' || !(ACTIONS as readonly unknown[]).includes(action)) return undefined;
  if (action === 'chip' && !Object.hasOwn(CHIPS, text)) return undefined;
  return { type, action: action as PullRequestAction, value: text, pasted: pasted === true };
}

/** The listed pull requests, every group's. */
function listed(view: PullRequestPickerView): ListedPullRequest[] {
  return view.list.state === 'listed' ? view.list.groups.flatMap((group) => group.pullRequests) : [];
}

/** How many pull requests are listed: step 2's summary. */
export function listedCount(view: PullRequestPickerView): number {
  return listed(view).length;
}

/** The view's badge before a review opens: the pull requests whose review is requested from the reviewer. */
export function waitingBadge(view: PullRequestPickerView): { value: number; tooltip: string } | undefined {
  const waiting = view.list.state === 'listed' ? (view.list.groups.find((group) => group.group === 'review requested')?.pullRequests.length ?? 0) : 0;
  if (waiting === 0) return undefined;
  return { value: waiting, tooltip: `${waiting} pull request${waiting === 1 ? '' : 's'} waiting on your review` };
}

/** How long ago, in the list's short words: minutes, hours, then days. */
export function ageText(since: string, now: string): string {
  const minutes = Math.floor((Date.parse(now) - Date.parse(since)) / 60_000);
  if (Number.isNaN(minutes)) return '';
  if (minutes < 60) return `${Math.max(0, minutes)} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? '' : 's'}`;
}

/** True when every word of the filter is in the pull request's title, repository and number, author or summary. */
export function matchesFilter(pullRequest: ListedPullRequest, filter: string): boolean {
  const text = `${pullRequest.title} ${pullRequest.repository} #${pullRequest.number} ${pullRequest.author} ${pullRequest.summary}`.toLowerCase();
  return filter.toLowerCase().split(/\s+/).every((word) => text.includes(word));
}

/** A press in the list: a button that reports its action and value. */
function prButton(id: string, action: PullRequestAction, label: string, kind: 'primary' | 'secondary', value = '', ariaLabel?: string): string {
  const named = ariaLabel === undefined ? '' : ` aria-label="${escapeHtml(ariaLabel)}"`;
  return `<button type="button" id="${escapeHtml(id)}" class="${kind}" data-pr-action="${action}" data-value="${escapeHtml(value)}"${named}>${escapeHtml(label)}</button>`;
}

/** One of the states the list can be in instead of its pull requests, as a card in the same place. */
function stateCard(title: string, text: string, action = ''): string {
  return `<div class="pr-state" role="status"><h3>${escapeHtml(title)}</h3><p class="note">${escapeHtml(text)}</p>${action === '' ? '' : `<div class="actions">${action}</div>`}</div>`;
}

/** The pills under a pull request: where it stands in review. */
function pills(pullRequest: ListedPullRequest): string[] {
  const { review } = pullRequest;
  const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? '' : 's'}`;
  return [
    ...(review.draft ? ['draft'] : []),
    ...(review.requested ? ['your review'] : []),
    ...(pullRequest.newCommitsSinceLastLook ? ['new commits since your last look'] : []),
    ...(review.approvals > 0 ? [plural(review.approvals, 'approval')] : []),
    ...(review.changesRequested > 0 ? [`${plural(review.changesRequested, 'reviewer')} asking for changes`] : []),
    ...(review.approvals === 0 && review.changesRequested === 0 ? ['no review yet'] : []),
  ];
}

/** A pull request's card: title, repository and number, author, age, summary, review state, size and its Review button. */
function pullRequestCard(pullRequest: ListedPullRequest, group: PullRequestGroupKind, readAt: string): string {
  const where = `${pullRequest.repository} #${pullRequest.number}`;
  const author = group === 'yours' ? 'you' : pullRequest.author;
  const age = pullRequest.waitingSince === undefined ? `${ageText(pullRequest.updatedAt, readAt)} ago` : `waiting on you ${ageText(pullRequest.waitingSince, readAt)}`;
  const meta = [where, author, age].filter((text) => text !== '').map((text) => `<span>${escapeHtml(text)}</span>`).join(' · ');
  const summary = pullRequest.summary === '' ? '' : `<p class="pr-summary">${escapeHtml(pullRequest.summary)}</p>`;
  const { additions, deletions, files } = pullRequest.size;
  const size = `<span class="pr-size"><span class="add">+${additions}</span> <span class="del">−${deletions}</span> · ${files} file${files === 1 ? '' : 's'}</span>`;
  const id = `pr-review-${where}`.replace(/[^\w-]/g, '_');
  return (
    `<li class="pr-card">` +
    `<p class="pr-title">${escapeHtml(pullRequest.title)}</p>` +
    `<p class="pr-meta">${meta}</p>` +
    summary +
    `<p class="pr-meta">${pills(pullRequest).map((pill) => `<span class="pill">${escapeHtml(pill)}</span>`).join('')}${size}` +
    `${prButton(id, 'review', 'Review', 'secondary', pullRequest.url, `Review ${where}: ${pullRequest.title}`)}</p>` +
    `</li>`
  );
}

/** The chips that show every group or one, each with its count, the one shown pressed. */
function chips(view: PullRequestPickerView, groups: readonly PullRequestGroup[]): string {
  const count = (chip: PullRequestChip): number =>
    groups.filter((group) => chip === 'all' || group.group === chip).reduce((sum, group) => sum + group.pullRequests.length, 0);
  const buttons = (Object.keys(CHIPS) as PullRequestChip[]).map(
    (chip) =>
      `<button type="button" id="pr-chip-${chip.replace(' ', '-')}" class="chip" data-pr-action="chip" data-value="${chip}" aria-pressed="${view.chip === chip}">${CHIPS[chip]} ${count(chip)}</button>`,
  );
  return `<div class="chips" role="group" aria-label="Groups shown">${buttons.join('')}</div>`;
}

/** The list itself, or the card that explains why there is none. */
function listBody(view: PullRequestPickerView): string {
  const { list } = view;
  if (list.state === 'not loaded') return '';
  if (list.state === 'loading') return '<p class="note" role="status">Loading your pull requests…</p>';
  const tryAgain = prButton('pr-reload', 'reload', 'Try again', 'secondary');
  if (list.state === 'signed out') {
    return stateCard('Not signed in to GitHub', `${list.reason} Pasting a URL works without it; the review asks then.`, prButton('pr-sign-in', 'signIn', 'Sign in to GitHub', 'primary'));
  }
  if (list.state === 'unreachable') return stateCard('GitHub could not be reached', `${list.reason} Pasting a URL still works.`, tryAgain);
  if (list.state === 'failed') return stateCard('Your pull requests could not be listed', `${list.message.replace(/\.$/, '')}. Pasting a URL still works.`, tryAgain);
  if (listedCount(view) === 0) {
    return stateCard('Nothing waiting on you', 'No open pull requests request your review or involve you. Paste any pull request URL above.');
  }
  const filter = view.filter.trim();
  const shown = list.groups
    .filter((group) => view.chip === 'all' || group.group === view.chip)
    .map((group) => ({ ...group, pullRequests: group.pullRequests.filter((pullRequest) => matchesFilter(pullRequest, filter)) }))
    .filter((group) => group.pullRequests.length > 0);
  const groups = shown.map(
    (group) =>
      `<h3 class="group">${GROUP_TITLES[group.group]} <span class="count">${group.pullRequests.length}</span></h3>` +
      `<ul class="pr-list" aria-label="${GROUP_TITLES[group.group]}">${group.pullRequests.map((pullRequest) => pullRequestCard(pullRequest, group.group, list.readAt)).join('')}</ul>`,
  );
  const none = filter === '' ? 'No open pull request in this group.' : 'No pull request matches the filter.';
  return chips(view, list.groups) + (groups.length === 0 ? `<p class="note" role="status">${none}</p>` : groups.join(''));
}

/**
 * Step 2's list (issue 137): a box that filters as the reviewer types and
 * starts the review of a pull request URL pasted into it, the chips, then
 * a card per pull request in its group — or, in the same place, the card
 * that says the list is empty, needs a sign-in, or could not reach
 * GitHub. Every piece of text is escaped; the box works in every state.
 */
export function pullRequestsBody(view: PullRequestPickerView): string {
  const pasted = parsePullRequestUrl(view.filter.trim());
  const url =
    pasted === null
      ? ''
      : `<div class="actions">${prButton('pr-review-url', 'review', `Review ${pasted.owner}/${pasted.repo} #${pasted.number}`, 'primary', view.filter.trim())}</div>`;
  return (
    `<div class="picker">` +
    `<input type="search" id="pr-filter" class="pr-filter" value="${escapeHtml(view.filter)}" placeholder="Filter, or paste a pull request URL" aria-label="Filter your pull requests, or paste a pull request URL and press Enter" autocomplete="off" spellcheck="false">` +
    url +
    listBody(view) +
    `</div>`
  );
}
