import { beforeEach, describe, expect, it } from 'vitest';
import { NO_MARKS, type ListedPullRequest, type ListPullRequestsParams, type PullRequestGroup, type PullRequestList } from '@second-look/engine';
import { REVIEW_COMMAND, REVIEW_TREE_VIEW } from '../src/commands.js';
import { sideBarBody } from '../src/side-bar/page.js';
import { SideBarProvider, sideBarMessage } from '../src/side-bar/provider.js';
import { PullRequestPicker, originRepository, type PullRequestEngine } from '../src/side-bar/pull-request-picker.js';
import { ageText, matchesFilter, pullRequestMessage, pullRequestsBody, waitingBadge, type PullRequestPickerView } from '../src/side-bar/pull-requests.js';
import { sideBarSteps, type SideBarState } from '../src/side-bar/steps.js';
import { mixedResult } from './results.js';
import { stub, window } from './vscode-stub.js';

const READ_AT = '2026-10-11T12:00:00.000Z';
const TOKEN = 'ghp_test-token-do-not-print';
const SETTINGS = { agent: 'claude-code' as const, model: 'sonnet', effort: 'high', account: '' };
const EMPTY: SideBarState = { settings: SETTINGS, marks: NO_MARKS, sections: [], reviewing: false, storyRead: false };

function pullRequest(overrides: Partial<ListedPullRequest> = {}): ListedPullRequest {
  return {
    url: 'https://github.com/octo-org/payments/pull/412',
    repository: 'octo-org/payments',
    number: 412,
    title: 'Retry idempotent charges on timeout',
    author: 'maria-k',
    updatedAt: '2026-10-11T08:00:00Z',
    summary: 'Retries charge calls that time out, using the idempotency key.',
    review: { requested: false, approvals: 0, changesRequested: 0, draft: false },
    size: { additions: 84, deletions: 12, files: 5 },
    newCommitsSinceLastLook: false,
    ...overrides,
  };
}

/** The list the picker shows in the examples: two waiting on the reviewer, one of theirs, one involving them, one in the open folder's repository. */
const GROUPS: PullRequestGroup[] = [
  {
    group: 'review requested',
    pullRequests: [
      pullRequest({ review: { requested: true, approvals: 1, changesRequested: 0, draft: false }, waitingSince: '2026-10-09T12:00:00Z' }),
      pullRequest({
        url: 'https://github.com/octo-org/auth/pull/62',
        repository: 'octo-org/auth',
        number: 62,
        title: 'Rate-limit login attempts',
        author: 'sam-r',
        summary: '',
        review: { requested: true, approvals: 0, changesRequested: 2, draft: false },
        size: { additions: 46, deletions: 9, files: 1 },
        newCommitsSinceLastLook: true,
        waitingSince: '2026-10-10T11:00:00Z',
      }),
    ],
  },
  {
    group: 'yours',
    pullRequests: [
      pullRequest({
        url: 'https://github.com/example-org/interview-coach/pull/97',
        repository: 'example-org/interview-coach',
        number: 97,
        title: 'Add AI engineering study sources',
        author: 'reviewer',
        updatedAt: '2026-10-11T11:20:00Z',
        summary: '`sources.yaml` gains eight sources.',
        review: { requested: false, approvals: 0, changesRequested: 0, draft: true },
      }),
    ],
  },
  { group: 'involving you', pullRequests: [pullRequest({ url: 'https://github.com/octo-org/web/pull/5', repository: 'octo-org/web', number: 5, title: 'Fix the cart badge', author: 'li' })] },
  { group: 'this repository', pullRequests: [pullRequest({ url: 'https://github.com/example-org/second-look/pull/118', repository: 'example-org/second-look', number: 118, title: 'Explain workspace members', author: 'kim' })] },
];

function view(overrides: Partial<PullRequestPickerView> = {}): PullRequestPickerView {
  return { list: { state: 'listed', groups: GROUPS, readAt: READ_AT }, filter: '', chip: 'all', ...overrides };
}

/** The titles of the cards drawn, in order. */
function titles(html: string): string[] {
  return [...html.matchAll(/<p class="pr-title">([^<]*)<\/p>/g)].map((match) => match[1]!);
}

describe("step 2's list", () => {
  it('draws a card per pull request in its group: title, repository and number, author, age, summary, review state, size and Review', () => {
    const html = pullRequestsBody(view());
    expect([...html.matchAll(/<h3 class="group">([^<]*) <span class="count">(\d+)<\/span>/g)].map((match) => `${match[1]} ${match[2]}`)).toEqual([
      'Review requested from you 2',
      'Your pull requests 1',
      'Involving you 1',
      'Open in this repository 1',
    ]);
    expect(titles(html)).toEqual(['Retry idempotent charges on timeout', 'Rate-limit login attempts', 'Add AI engineering study sources', 'Fix the cart badge', 'Explain workspace members']);
    expect(html).toContain('<p class="pr-meta"><span>octo-org/payments #412</span> · <span>maria-k</span> · <span>waiting on you 2 days</span></p>');
    expect(html).toContain('<p class="pr-summary">Retries charge calls that time out, using the idempotency key.</p>');
    expect(html).toContain('<span class="pill">your review</span><span class="pill">1 approval</span><span class="pr-size"><span class="add">+84</span> <span class="del">−12</span> · 5 files</span>');
    expect(html).toContain(
      '<button type="button" id="pr-review-octo-org_payments__412" class="secondary" data-pr-action="review" data-value="https://github.com/octo-org/payments/pull/412" aria-label="Review octo-org/payments #412: Retry idempotent charges on timeout">Review</button>',
    );
    // The second waits a day, with new commits since the last look, two reviewers asking for changes and no summary.
    expect(html).toContain('<span>octo-org/auth #62</span> · <span>sam-r</span> · <span>waiting on you 1 day</span>');
    expect(html).toContain('<span class="pill">your review</span><span class="pill">new commits since your last look</span><span class="pill">2 reviewers asking for changes</span>');
    expect(html).toContain('· 1 file</span>');
    // The reviewer's own: "you", its age since the last update, a draft with no review yet.
    expect(html).toContain('<span>example-org/interview-coach #97</span> · <span>you</span> · <span>40 min ago</span>');
    expect(html).toContain('<span class="pill">draft</span><span class="pill">no review yet</span>');
    expect(html.match(/<p class="pr-summary">/g)).toHaveLength(4);
  });

  it('shows the chips with their counts, the pressed one alone, and only its group', () => {
    const all = pullRequestsBody(view());
    expect([...all.matchAll(/data-value="([^"]*)" aria-pressed="(true|false)">([^<]*)</g)].map((match) => `${match[3]} ${match[2]}`)).toEqual([
      'All 5 true',
      'Review requested 2 false',
      'Mine 1 false',
      'Involving 1 false',
    ]);
    expect(all).toContain('<div class="chips" role="group" aria-label="Groups shown">');
    expect(titles(pullRequestsBody(view({ chip: 'review requested' })))).toEqual(['Retry idempotent charges on timeout', 'Rate-limit login attempts']);
    expect(titles(pullRequestsBody(view({ chip: 'yours' })))).toEqual(['Add AI engineering study sources']);
    expect(titles(pullRequestsBody(view({ chip: 'involving you' })))).toEqual(['Fix the cart badge']);
  });

  it('filters as the reviewer types, on the title, the repository and number, the author and the summary, every word', () => {
    expect(titles(pullRequestsBody(view({ filter: 'RATE login' })))).toEqual(['Rate-limit login attempts']);
    expect(titles(pullRequestsBody(view({ filter: 'auth #62' })))).toEqual(['Rate-limit login attempts']);
    expect(titles(pullRequestsBody(view({ filter: 'kim' })))).toEqual(['Explain workspace members']);
    expect(titles(pullRequestsBody(view({ filter: 'idempotency' })))).toEqual(['Retry idempotent charges on timeout', 'Fix the cart badge', 'Explain workspace members']);
    expect(pullRequestsBody(view({ filter: 'nothing like it' }))).toContain('<p class="note" role="status">No pull request matches the filter.</p>');
    expect(matchesFilter(pullRequest(), '')).toBe(true);
    // The chips keep counting the whole list while it is filtered.
    expect(pullRequestsBody(view({ filter: 'kim' }))).toContain('>All 5</button>');
  });

  it('offers the review of a pull request URL in the box, which keeps working in every state', () => {
    const url = 'https://github.com/octo-org/payments/pull/9';
    for (const list of [
      { state: 'not loaded' },
      { state: 'loading' },
      { state: 'signed out', reason: 'Not signed in to GitHub: sign in to list your pull requests.' },
      { state: 'unreachable', reason: 'GitHub could not be reached: check the connection and try again.' },
      { state: 'failed', message: 'the engine stopped before answering' },
      { state: 'listed', groups: [], readAt: READ_AT },
      { state: 'listed', groups: GROUPS, readAt: READ_AT },
    ] as PullRequestPickerView['list'][]) {
      const html = pullRequestsBody(view({ list, filter: `  ${url} ` }));
      expect(html).toContain(
        '<input type="search" id="pr-filter" class="pr-filter" value="  https://github.com/octo-org/payments/pull/9 " placeholder="Filter, or paste a pull request URL" aria-label="Filter your pull requests, or paste a pull request URL and press Enter" autocomplete="off" spellcheck="false">',
      );
      expect(html).toContain(`<button type="button" id="pr-review-url" class="primary" data-pr-action="review" data-value="${url}">Review octo-org/payments #9</button>`);
    }
    expect(pullRequestsBody(view({ filter: 'https://example.com/pull/9' }))).not.toContain('pr-review-url');
  });

  it('explains the empty, signed-out and offline lists in plain words, as cards in the same place, with their buttons', () => {
    const body = (list: PullRequestPickerView['list']): string => pullRequestsBody(view({ list }));
    expect(body({ state: 'loading' })).toContain('<p class="note" role="status">Loading your pull requests…</p>');
    expect(body({ state: 'listed', groups: [{ group: 'yours', pullRequests: [] }], readAt: READ_AT })).toContain(
      '<div class="pr-state" role="status"><h3>Nothing waiting on you</h3><p class="note">No open pull requests request your review or involve you. Paste any pull request URL above.</p></div>',
    );
    expect(body({ state: 'signed out', reason: 'Not signed in to GitHub: sign in to list your pull requests.' })).toContain(
      '<div class="pr-state" role="status"><h3>Not signed in to GitHub</h3><p class="note">Not signed in to GitHub: sign in to list your pull requests. Pasting a URL works without it; the review asks then.</p>' +
        '<div class="actions"><button type="button" id="pr-sign-in" class="primary" data-pr-action="signIn" data-value="">Sign in to GitHub</button></div></div>',
    );
    expect(body({ state: 'unreachable', reason: 'GitHub could not be reached: it did not answer within 30 seconds.' })).toContain(
      '<div class="pr-state" role="status"><h3>GitHub could not be reached</h3><p class="note">GitHub could not be reached: it did not answer within 30 seconds. Pasting a URL still works.</p>' +
        '<div class="actions"><button type="button" id="pr-reload" class="secondary" data-pr-action="reload" data-value="">Try again</button></div></div>',
    );
    expect(body({ state: 'failed', message: 'the engine did not answer in time' })).toContain(
      '<h3>Your pull requests could not be listed</h3><p class="note">the engine did not answer in time. Pasting a URL still works.</p>',
    );
    expect(body({ state: 'not loaded' })).toBe(
      '<div class="picker"><input type="search" id="pr-filter" class="pr-filter" value="" placeholder="Filter, or paste a pull request URL" aria-label="Filter your pull requests, or paste a pull request URL and press Enter" autocomplete="off" spellcheck="false"></div>',
    );
  });

  it('escapes every piece of text the authors wrote', () => {
    const hostile = pullRequest({
      title: '<img src=x onerror=alert(1)>',
      author: '"><script>',
      summary: "</p><a href='javascript:1'>",
      repository: 'octo-org/"x',
    });
    const html = pullRequestsBody(view({ list: { state: 'listed', groups: [{ group: 'involving you', pullRequests: [hostile] }], readAt: READ_AT } }));
    expect(html).not.toMatch(/<(img|script|a)[\s>]/);
    expect(html).toContain('<p class="pr-title">&lt;img src=x onerror=alert(1)&gt;</p>');
    expect(html).toContain('<span>&quot;&gt;&lt;script&gt;</span>');
    expect(html).toContain('<p class="pr-summary">&lt;/p&gt;&lt;a href=&#39;javascript:1&#39;&gt;</p>');
    expect(html).toContain('aria-label="Review octo-org/&quot;x #412: &lt;img src=x onerror=alert(1)&gt;"');
    const typed = pullRequestsBody(view({ filter: '"><b>' }));
    expect(typed).not.toMatch(/<b[\s>]/);
    expect(typed).toContain('value="&quot;&gt;&lt;b&gt;"');
  });

  it('counts the ages in minutes, hours, then days, and the badge the pull requests waiting on the reviewer', () => {
    expect(ageText('2026-10-11T11:59:30Z', READ_AT)).toBe('0 min');
    expect(ageText('2026-10-11T12:01:00Z', READ_AT)).toBe('0 min');
    expect(ageText('2026-10-11T10:59:00Z', READ_AT)).toBe('1 h');
    expect(ageText('2026-10-10T11:00:00Z', READ_AT)).toBe('1 day');
    expect(ageText('2026-09-01T12:00:00Z', READ_AT)).toBe('40 days');
    expect(ageText('not a date', READ_AT)).toBe('');

    expect(waitingBadge(view())).toEqual({ value: 2, tooltip: '2 pull requests waiting on your review' });
    expect(waitingBadge(view({ list: { state: 'listed', groups: GROUPS.slice(1), readAt: READ_AT } }))).toBeUndefined();
    expect(waitingBadge(view({ list: { state: 'loading' } }))).toBeUndefined();
  });

  it('reads the messages its box, chips and buttons send, and nothing else', () => {
    expect(pullRequestMessage({ type: 'pullRequests', action: 'filter', value: 'retry', pasted: true })).toEqual({ type: 'pullRequests', action: 'filter', value: 'retry', pasted: true });
    expect(pullRequestMessage({ type: 'pullRequests', action: 'chip', value: 'yours' })).toEqual({ type: 'pullRequests', action: 'chip', value: 'yours', pasted: false });
    expect(sideBarMessage({ type: 'pullRequests', action: 'review', value: 'https://github.com/o/r/pull/1' })).toEqual({ type: 'pullRequests', action: 'review', value: 'https://github.com/o/r/pull/1', pasted: false });
    expect(pullRequestMessage({ type: 'pullRequests', action: 'chip', value: 'toString' })).toBeUndefined();
    expect(pullRequestMessage({ type: 'pullRequests', action: 'run', value: '' })).toBeUndefined();
    expect(pullRequestMessage({ type: 'pullRequests', action: 'filter', value: 3 })).toBeUndefined();
    expect(pullRequestMessage({ type: 'setup', action: 'filter', value: '' })).toBeUndefined();
    expect(pullRequestMessage(null)).toBeUndefined();
  });

  it("reads the open folder's GitHub repository from its origin remote only", () => {
    const config = (url: string): string => `[core]\n\tbare = false\n[remote "upstream"]\n\turl = https://github.com/other/fork.git\n[remote "origin"]\n\turl = ${url}\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n`;
    expect(originRepository(config('https://github.com/lbildzinkas/second-look.git'))).toBe('lbildzinkas/second-look');
    expect(originRepository(config('git@github.com:lbildzinkas/second-look.git'))).toBe('lbildzinkas/second-look');
    expect(originRepository(config('https://github.com/lbildzinkas/second-look'))).toBe('lbildzinkas/second-look');
    expect(originRepository(config('https://gitlab.com/lbildzinkas/second-look.git'))).toBeUndefined();
    expect(originRepository(config('ssh://git@github.com/lbildzinkas/second-look.git'))).toBe('lbildzinkas/second-look');
    expect(originRepository(config('https://example.com/github.com/lbildzinkas/second-look.git'))).toBeUndefined();
    expect(originRepository(config('https://github.com/lbildzinkas'))).toBeUndefined();
    expect(originRepository('[remote "upstream"]\n\turl = https://github.com/other/fork.git\n')).toBeUndefined();
  });
});

/** An engine double answering the list, recording what each request carried. */
function listingEngine(answer: PullRequestList | Promise<PullRequestList> = { outcome: 'listed', groups: GROUPS }): PullRequestEngine & { requests: ListPullRequestsParams[] } {
  const engine = {
    requests: [] as ListPullRequestsParams[],
    listPullRequests(params: ListPullRequestsParams) {
      engine.requests.push(params);
      return Promise.resolve(answer);
    },
  };
  return engine;
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function picker(engine: PullRequestEngine, repository?: string): { picker: PullRequestPicker; changes: () => number } {
  let changes = 0;
  const made = new PullRequestPicker({
    engine: () => Promise.resolve(engine),
    onChange: () => (changes += 1),
    repository: () => Promise.resolve(repository),
    now: () => new Date(READ_AT),
  });
  return { picker: made, changes: () => changes };
}

describe('the pull request picker', () => {
  beforeEach(() => stub.reset());

  it("lists with the editor's GitHub sign-in, without asking for one, and the open folder's repository", async () => {
    stub.session = { accessToken: TOKEN };
    const engine = listingEngine();
    const { picker: made } = picker(engine, 'example-org/second-look');
    const loaded = made.load();
    expect(made.current.list).toEqual({ state: 'loading' });
    await loaded;

    expect(stub.sessionRequests).toEqual([{ id: 'github', scopes: ['repo'], createIfNone: false }]);
    expect(engine.requests).toEqual([{ token: TOKEN, repository: 'example-org/second-look' }]);
    expect(made.current.list).toEqual({ state: 'listed', groups: GROUPS, readAt: READ_AT });

    // Shown again, it keeps the list; the reload reads it again, here with no repository.
    made.shown();
    expect(engine.requests).toHaveLength(1);
    const { picker: other } = picker(engine);
    await other.load();
    expect(engine.requests.at(-1)).toEqual({ token: TOKEN });
  });

  it('says signed out with no sign-in, asking the engine nothing, and the sign-in button signs in, then lists', async () => {
    const engine = listingEngine();
    const { picker: made } = picker(engine);
    await made.load();
    expect(made.current.list).toEqual({ state: 'signed out', reason: 'Not signed in to GitHub: sign in to list your pull requests.' });
    expect(engine.requests).toEqual([]);

    stub.session = { accessToken: TOKEN };
    await made.handle({ type: 'pullRequests', action: 'signIn', value: '', pasted: false });
    expect(stub.sessionRequests.map((request) => request.createIfNone)).toEqual([false, true, false]);
    expect(made.current.list.state).toBe('listed');

    // A sign-in the reviewer cancels leaves the list saying so again.
    stub.cancelSignIn = true;
    await made.handle({ type: 'pullRequests', action: 'signIn', value: '', pasted: false });
    expect(made.current.list.state).toBe('signed out');
  });

  it("shows the engine's reason when GitHub refuses the sign-in or is out of reach, and its message when it fails", async () => {
    stub.session = { accessToken: TOKEN };
    const refused = picker(listingEngine({ outcome: 'signed out', reason: 'GitHub did not accept your sign-in.' })).picker;
    await refused.load();
    expect(refused.current.list).toEqual({ state: 'signed out', reason: 'GitHub did not accept your sign-in.' });

    const offline = picker(listingEngine({ outcome: 'unreachable', reason: 'GitHub could not be reached.' })).picker;
    await offline.load();
    expect(offline.current.list).toEqual({ state: 'unreachable', reason: 'GitHub could not be reached.' });

    const failing = new PullRequestPicker({ engine: () => Promise.reject(new Error('the engine could not be started')), onChange: () => undefined, repository: () => Promise.resolve(undefined) });
    await failing.load();
    expect(failing.current.list).toEqual({ state: 'failed', message: 'the engine could not be started' });
  });

  it('drops the answer of a load a later one replaced', async () => {
    stub.session = { accessToken: TOKEN };
    let answerFirst: (list: PullRequestList) => void = () => undefined;
    const first = new Promise<PullRequestList>((resolve) => (answerFirst = resolve));
    const answers = [first, Promise.resolve<PullRequestList>({ outcome: 'unreachable', reason: 'offline' })];
    const made = new PullRequestPicker({
      engine: () => Promise.resolve({ listPullRequests: () => answers.shift()! }),
      onChange: () => undefined,
      repository: () => Promise.resolve(undefined),
    });
    const slow = made.load();
    await settle();
    await made.load();
    answerFirst({ outcome: 'listed', groups: GROUPS });
    await slow;
    expect(made.current.list).toEqual({ state: 'unreachable', reason: 'offline' });
  });

  it('filters and picks a chip, and starts a review from a pasted URL, Enter on a URL, or a Review button, through the review command', async () => {
    const { picker: made, changes } = picker(listingEngine());
    const url = 'https://github.com/octo-org/payments/pull/9';
    const send = (action: 'filter' | 'go' | 'chip' | 'review', value: string, pasted = false): Promise<void> => made.handle({ type: 'pullRequests', action, value, pasted });

    await send('chip', 'yours');
    await send('filter', 'retry');
    expect(made.current).toMatchObject({ chip: 'yours', filter: 'retry' });
    expect(changes()).toBe(2);

    // Typing a URL only offers it: a half-typed URL is still a URL.
    await send('filter', url);
    expect(stub.executedCommands).toEqual([]);
    await send('filter', `${url} `, true);
    await send('go', url);
    await send('review', 'https://github.com/octo-org/auth/pull/62');
    // Enter on words, or a review of anything but a pull request URL, starts nothing.
    await send('go', 'retry');
    await send('review', 'https://example.com/pull/1');
    expect(stub.executedCommands).toEqual([
      { id: REVIEW_COMMAND, args: [url] },
      { id: REVIEW_COMMAND, args: [url] },
      { id: REVIEW_COMMAND, args: ['https://github.com/octo-org/auth/pull/62'] },
    ]);
  });
});

describe("the side bar's step 2", () => {
  beforeEach(() => stub.reset());

  /** A side bar carrying a picker on the double engine, resolved the way opening the container does. */
  function opened(state: SideBarState, engine = listingEngine()): { provider: SideBarProvider; view: ReturnType<(typeof stub.webviewViewProviders)[number]['resolve']>; engine: typeof engine } {
    const drawn: { provider?: SideBarProvider } = {};
    const made = new PullRequestPicker({ engine: () => Promise.resolve(engine), onChange: () => drawn.provider?.redraw(), repository: () => Promise.resolve(undefined), now: () => new Date(READ_AT) });
    const provider = new SideBarProvider(state, undefined, made);
    drawn.provider = provider;
    window.registerWebviewViewProvider(REVIEW_TREE_VIEW, provider);
    return { provider, view: stub.webviewViewProviders[0]!.resolve(), engine };
  }

  it('loads the list as step 2 first shows, counts it beside the title, and badges the pull requests waiting on the reviewer', async () => {
    stub.session = { accessToken: TOKEN };
    const { provider, view, engine } = opened(EMPTY);
    await settle();

    expect(engine.requests).toEqual([{ token: TOKEN }]);
    expect(view.badge).toEqual({ value: 2, tooltip: '2 pull requests waiting on your review' });
    expect(sideBarSteps(provider.current)[1]).toMatchObject({ state: 'current', open: true, summary: '5 open' });
    const body = sideBarBody(provider.current);
    expect(body).toContain('id="pr-filter"');
    expect(body).not.toContain('id="step-2-review"');
    expect(view.webview.posted.at(-1)).toEqual({ type: 'render', body });

    // Once a review opens, the badge counts its parts left; step 2 still carries the list below the pull request.
    provider.update({ ...EMPTY, result: mixedResult() }, { value: 7, tooltip: '7 of 7 parts left to review' });
    expect(view.badge).toEqual({ value: 7, tooltip: '7 of 7 parts left to review' });
    provider.update({ ...EMPTY, result: mixedResult() }, undefined);
    expect(view.badge).toBeUndefined();
    expect(sideBarBody(provider.current)).toMatch(/id="step-2-review"[^]*id="pr-filter"[^]*Retry idempotent charges on timeout/);
  });

  it('waits for step 2 to show while a review is open or runs, then loads when the reviewer opens its card', async () => {
    stub.session = { accessToken: TOKEN };
    const { view, engine } = opened({ ...EMPTY, result: mixedResult() });
    await settle();
    expect(engine.requests).toEqual([]);

    view.webview.receive({ type: 'pullRequests', action: 'show', value: '' });
    await settle();
    expect(engine.requests).toHaveLength(1);

    stub.reset();
    stub.session = { accessToken: TOKEN };
    const running = opened({ ...EMPTY, reviewing: true });
    await settle();
    expect(running.engine.requests).toEqual([]);
  });

  it("sends the box's typing and the list's presses to the list, and Review runs the review command", async () => {
    stub.session = { accessToken: TOKEN };
    const { provider, view } = opened(EMPTY);
    await settle();
    view.webview.receive({ type: 'pullRequests', action: 'filter', value: 'login', pasted: false });
    view.webview.receive({ type: 'pullRequests', action: 'chip', value: 'review requested' });
    await settle();
    expect(provider.current.pullRequests).toMatchObject({ filter: 'login', chip: 'review requested' });
    expect(titles(sideBarBody(provider.current))).toEqual(['Rate-limit login attempts']);

    view.webview.receive({ type: 'pullRequests', action: 'review', value: 'https://github.com/octo-org/auth/pull/62' });
    view.webview.receive({ type: 'pullRequests', action: 'chip', value: 'constructor' });
    await settle();
    expect(stub.executedCommands).toEqual([{ id: REVIEW_COMMAND, args: ['https://github.com/octo-org/auth/pull/62'] }]);
    expect(provider.current.pullRequests?.chip).toBe('review requested');
  });
});
