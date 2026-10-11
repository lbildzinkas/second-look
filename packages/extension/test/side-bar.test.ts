import { beforeEach, describe, expect, it } from 'vitest';
import { applyMark, markedPart, NO_MARKS, type Comment, type Part, type ReviewedMarks } from '@second-look/engine';
import {
  DRAFT_COMMENT_COMMAND,
  FETCH_LIBRARY_COMMAND,
  MARK_REVIEWED_COMMAND,
  OPEN_ALL_PARTS_COMMAND,
  OPEN_OVERVIEW_COMMAND,
  OPEN_PART_COMMAND,
  OPEN_SETTINGS_COMMAND,
  REVIEW_COMMAND,
  REVIEW_TREE_VIEW,
  SUBMIT_REVIEW_COMMAND,
  askCommand,
} from '../src/commands.js';
import { sideBarBody, sideBarHtml } from '../src/side-bar/page.js';
import { SideBarProvider, sideBarMessage, type SideBarDeps } from '../src/side-bar/provider.js';
import { StepTickStore } from '../src/side-bar/step-ticks.js';
import { nextPartToReview, setupLine, sideBarSteps, type SideBarState } from '../src/side-bar/steps.js';
import { anchorOf, buildTree, pendingReviewSection } from '../src/tree.js';
import { REQUESTS_FETCH, claimsResult, judgedResult, mappedCriteriaResult, mixedResult, offeredResult, unexplainedResult } from './results.js';
import { stub, stubContext, window, type StubWebviewView } from './vscode-stub.js';

const NOW = new Date('2026-10-06T12:00:00Z');
const SETTINGS = { agent: 'claude-code' as const, model: 'sonnet', effort: 'high', account: '' };

function marked(...parts: Part[]): ReviewedMarks {
  return parts.reduce((marks, each) => applyMark(marks, markedPart(each), true, NOW), NO_MARKS);
}

/** The side bar's state for a review shown, with the tree's sections as the session builds them. */
function reviewState(overrides: Partial<SideBarState> = {}, comments: Comment[] = []): SideBarState {
  const result = overrides.result ?? mixedResult();
  const marks = overrides.marks ?? NO_MARKS;
  return {
    settings: SETTINGS,
    result,
    marks,
    sections: [...(comments.length > 0 ? [pendingReviewSection(comments)] : []), ...buildTree(result, marks)],
    reviewing: false,
    storyRead: false,
    ...overrides,
  };
}

const EMPTY: SideBarState = { settings: SETTINGS, marks: NO_MARKS, sections: [], reviewing: false, storyRead: false };

/** Each step's state, in order. */
function states(state: SideBarState): string[] {
  return sideBarSteps(state).map((step) => step.state);
}

describe('the review path', () => {
  it('names the agent, the model and the effort on the setup line, their defaults included', () => {
    expect(setupLine(SETTINGS)).toBe('Claude Code · sonnet · effort high');
    expect(setupLine({ agent: 'pi', model: '', effort: '', account: 'mine' })).toBe('Pi · default model · default effort');
  });

  it('opens on step 2 before any review, with the setup done and the rest still to come', () => {
    const steps = sideBarSteps(EMPTY);
    expect(steps.map((step) => `${step.number} ${step.title}`)).toEqual([
      '1 Set up the agent',
      '2 Pick a pull request',
      '3 Read the story',
      '4 Review the parts',
      '5 Claims and verdicts',
      '6 Criteria and unexplained',
      '7 Comments',
      '8 Send the review',
    ]);
    expect(states(EMPTY)).toEqual(['done', 'current', 'to come', 'to come', 'to come', 'to come', 'to come', 'to come']);
    expect(steps.map((step) => step.open)).toEqual([false, true, false, false, false, false, false, false]);
    expect(steps[0]!.summary).toBe('Claude Code · sonnet · effort high');
  });

  it('shows step 2 running while the pull request is read', () => {
    const steps = sideBarSteps({ ...EMPTY, reviewing: true });
    expect(steps[1]).toMatchObject({ state: 'running', open: true, summary: 'reading the pull request…' });
  });

  it('follows the review: the story, then the parts, then the claims, each the first step not done', () => {
    const result = mixedResult();
    expect(states(reviewState())).toEqual(['done', 'done', 'current', 'to come', 'to come', 'to come', 'to come', 'to come']);
    expect(sideBarSteps(reviewState())[1]!.summary).toBe('example-org/example-repo #42');

    const reading = reviewState({ storyRead: true, marks: marked(result.parts[0]!) });
    expect(states(reading)).toEqual(['done', 'done', 'done', 'current', 'to come', 'to come', 'to come', 'to come']);
    expect(sideBarSteps(reading)[3]!.summary).toBe('6 of 7 left');

    const allReviewed = reviewState({ storyRead: true, marks: marked(...result.parts) });
    const steps = sideBarSteps(allReviewed);
    expect(states(allReviewed)).toEqual(['done', 'done', 'done', 'done', 'current', 'to come', 'to come', 'to come']);
    expect(steps[3]!.summary).toBe('every part reviewed');
    expect(steps.filter((step) => step.open).map((step) => step.number)).toEqual([5]);
  });

  it('shows the steps whose results are still arriving as running, while the review runs', () => {
    const state = reviewState({ reviewing: true });
    expect(states(state)).toEqual(['done', 'done', 'running', 'to come', 'running', 'running', 'to come', 'to come']);
    // The running story is still the current step, so its card is open.
    expect(sideBarSteps(state)[2]).toMatchObject({ open: true, summary: 'being written…' });
    expect(states({ ...state, reviewing: false })[4]).toBe('to come');
  });

  it('counts the pending comments on step 7, and the listed claims on step 5', () => {
    const comment: Comment = { kind: 'line', path: 'src/retry.py', line: 5, side: 'head', body: 'Why five?' };
    const steps = sideBarSteps(reviewState({ result: claimsResult() }, [comment]));
    expect(steps[6]!.summary).toBe('1 pending');
    expect(steps[4]!.summary).toMatch(/^\d+ listed$/);
  });

  it('sums up the verdicts on step 5 and the criteria and unexplained changes on step 6, findings first', () => {
    const judged = reviewState({ result: judgedResult(), storyRead: true, marks: marked(...mixedResult().parts) });
    expect(sideBarSteps(judged)[4]!.summary).toBe('1 refuted · 2 unverifiable · 1 verified');
    const mapped = reviewState({ result: mappedCriteriaResult(), storyRead: true, marks: marked(...mixedResult().parts) });
    expect(sideBarSteps(mapped)[5]!.summary).toBe('1 not met · 1 met');
    const unexplained = reviewState({ result: unexplainedResult(), storyRead: true, marks: marked(...mixedResult().parts) });
    expect(sideBarSteps(unexplained)[5]!.summary).toBe('2 criteria · 3 unexplained');
  });

  it('marks a step done when its "I\u2019ve checked these" tick holds, and opens the next one', () => {
    const base = { result: judgedResult(), storyRead: true, marks: marked(...mixedResult().parts) } as const;
    expect(states(reviewState(base))).toEqual(['done', 'done', 'done', 'done', 'current', 'to come', 'to come', 'to come']);
    const ticked = reviewState({ ...base, ticks: { claims: true, criteria: false } });
    expect(states(ticked)).toEqual(['done', 'done', 'done', 'done', 'done', 'current', 'to come', 'to come']);
    expect(sideBarSteps(ticked).filter((step) => step.open).map((step) => step.number)).toEqual([6]);
    const both = reviewState({ ...base, ticks: { claims: true, criteria: true } });
    expect(states(both)).toEqual(['done', 'done', 'done', 'done', 'done', 'done', 'current', 'to come']);
  });

  it('opens next the first part in reading order not yet reviewed', () => {
    const result = mixedResult();
    expect(nextPartToReview(result, NO_MARKS)).toBe(result.parts[0]);
    expect(nextPartToReview(result, marked(result.parts[0]!))).toBe(result.parts[1]);
    expect(nextPartToReview(result, marked(...result.parts))).toBeUndefined();
  });
});

describe("the side bar's page", () => {
  it('loads nothing but its own style and script, under a strict content security policy', () => {
    const html = sideBarHtml('n0nce', sideBarBody(EMPTY));
    expect(html).toContain(`<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-n0nce'; script-src 'nonce-n0nce';">`);
    expect(html.match(/<script/g)).toHaveLength(1);
    expect(html).toContain('<script nonce="n0nce">');
    expect(html).toContain('<style nonce="n0nce">');
    expect(html).not.toMatch(/https?:|<img|<link|<iframe| style="| on[a-z]+="/);
  });

  it('colours itself from the theme through --vscode-* variables only', () => {
    const style = /<style[^>]*>([\s\S]*?)<\/style>/.exec(sideBarHtml('n', ''))![1]!;
    expect(style).toContain('var(--vscode-foreground)');
    expect(style).toContain('var(--vscode-sideBar-background)');
    expect(style).toContain('var(--vscode-button-background)');
    expect(style).toContain('var(--vscode-focusBorder)');
    expect(style).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgb\(/);
  });

  it('draws eight cards, the current one open and marked as the current step, the others folded', () => {
    const body = sideBarBody(reviewState());
    // The review's count tiles sit above the cards.
    expect(body).toMatch(/^<section class="progress" aria-label="Review progress">.*<\/section><ol class="steps" aria-label="Review path" data-current="3">/s);
    expect(body.match(/<li class="step /g)).toHaveLength(8);
    expect(body).toContain('<li class="step current" id="step-3" aria-current="step">');
    expect(body).toContain('<button type="button" class="fold" id="step-3-title" data-step="3" aria-expanded="true" aria-controls="step-3-body">');
    expect(body).toContain('<div class="body" id="step-3-body" role="region" aria-labelledby="step-3-title">');
    expect(body).toContain('<button type="button" class="fold" id="step-4-title" data-step="4" aria-expanded="false" aria-controls="step-4-body">');
    expect(body).toContain('<div class="body" id="step-4-body" role="region" aria-labelledby="step-4-title" hidden>');
    expect(body.match(/aria-current/g)).toHaveLength(1);
    expect(body).toContain('<span class="state">done</span>');
    expect(body).toContain('<span class="state">to come</span>');
  });

  it('offers the Review a pull request button before any review', () => {
    expect(sideBarBody(EMPTY)).toContain('<button type="button" id="step-2-review" class="primary" data-command="review">Review a pull request</button>');
  });

  it('lists the parts by importance, each with a labelled checkbox and a button that opens it', () => {
    const result = mixedResult();
    const body = sideBarBody(reviewState({ storyRead: true, marks: marked(result.parts[0]!) }));
    expect(body).toContain('<h3 class="group" title="The parts to read first.">Must review</h3>');
    expect(body.indexOf('>Must review<')).toBeLessThan(body.indexOf('>Worth reviewing<'));
    expect(body.indexOf('>Worth reviewing<')).toBeLessThan(body.indexOf('>Noise<'));
    expect(body.match(/<input type="checkbox"/g)).toHaveLength(7);
    expect(body).toMatch(/<input type="checkbox" id="mark-src\/retry\.py@[^"]*" data-anchor="[^"]*" aria-label="Reviewed: src\/retry\.py" checked>/);
    expect(body).toMatch(/<input type="checkbox" id="mark-src\/settings\.ts@[^"]*" data-anchor="[^"]*" aria-label="Reviewed: src\/settings\.ts">/);
    expect(body).toContain('class="open" id="open-src/retry.py@');
    expect(body).toContain('<span class="desc">New code the send path now runs on every delivery.</span>');
    expect(body).toContain(`data-anchor="${JSON.stringify(anchorOf(result.parts[0]!)).replace(/"/g, '&quot;')}"`);
    expect(body).toContain('data-command="nextPart">Open next part</button>');
    expect(body).toContain('data-command="allParts">All in order</button>');
  });

  it("gives each part row the context its menu's commands read the part from", () => {
    const body = sideBarBody(reviewState());
    const context = JSON.stringify({ webviewSection: 'part', anchor: anchorOf(mixedResult().parts[0]!), preventDefaultContextMenuItems: true });
    expect(body).toContain(`<li class="part part" data-vscode-context="${context.replace(/"/g, '&quot;')}">`);
  });

  it('turns Open next part off once every part is reviewed', () => {
    const result = mixedResult();
    expect(sideBarBody(reviewState({ marks: marked(...result.parts) }))).toContain('data-command="nextPart" disabled>Open next part</button>');
  });

  it("shows every piece of the pull request's text as text", () => {
    const result = mixedResult();
    const hostile = { ...result, pullRequest: { ...result.pullRequest, title: '<img src=x onerror=alert(1)>' }, parts: [{ ...result.parts[0]!, name: '<script>x</script>' }] };
    const body = sideBarBody(reviewState({ result: hostile }));
    expect(body).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(body).toContain('&lt;script&gt;x&lt;/script&gt;');
    expect(body).not.toMatch(/<img|<script/);
  });

  it('lists the pending comments on step 7, with the button that opens their threads in the diff', () => {
    const comment: Comment = { kind: 'line', path: 'src/retry.py', line: 5, side: 'head', body: 'Why five?' };
    const body = sideBarBody(reviewState({}, [comment]));
    expect(body).toContain('<ul class="comments" aria-label="Pending review"><li class="comment" title="Why five?"><span class="row"><span>src/retry.py:5</span><span class="desc">Why five?</span></span></li></ul>');
    expect(body).toContain('id="step-7-allParts" class="secondary" data-command="allParts">Open the threads in the diff</button>');
    expect(body).toContain('id="step-8-send" class="primary" data-command="send">Open the Send review page</button>');
    expect(body).toContain('id="step-5-overview" class="secondary" data-command="overview">Open the overview</button>');
  });

  it('lists the claim findings on step 5, each with its verdict, where it is made, and the existing actions', () => {
    const result = judgedResult();
    const body = sideBarBody(reviewState({ result, storyRead: true, marks: marked(...mixedResult().parts) }));
    // The docstring claim is refuted, the comment and story ones unverifiable: findings first, the verified one folded.
    expect(body).toContain('<span class="pill tone-bad"><span class="icon" aria-hidden="true">✕</span> refuted</span><span class="where">docstring · src/retry.py:3–4</span>');
    expect(body).toContain('<span class="pill tone-warn"><span class="icon" aria-hidden="true">?</span> unverifiable</span><span class="where">comment · src/retry.py:9</span>');
    expect(body).toContain('<q class="quote">Gives up after three attempts, whatever the status.</q>');
    expect(body).toContain('id="step-5-draft-claim-1" class="secondary" data-finding="draft" data-kind="claim" data-index="1">Draft comment</button>');
    expect(body).toContain('id="step-5-open-claim-1" class="secondary" data-finding="open" data-kind="claim" data-index="1">Open</button>');
    expect(body).toContain('id="step-5-verify-claim-1" class="secondary" data-finding="verify" data-kind="claim" data-index="1">Verify again</button>');
    expect(body).not.toContain('data-finding="fetch"');
    expect(body).toContain('<p class="folded"><span class="tone-ok" aria-hidden="true">✓</span> 1 verified</p>');
    expect(body).toContain('id="step-5-verifyClaim" class="secondary" data-command="verifyClaim">Verify a claim…</button>');
    expect(body).toMatch(/<input type="checkbox" id="step-5-tick" data-tick="claims" aria-label="I&#39;ve checked the claims">/);
  });

  it('offers the library fetch on a claim that needs one, and only as a button that presses it', () => {
    const result = offeredResult();
    const body = sideBarBody(reviewState({ result, storyRead: true, marks: marked(...mixedResult().parts) }));
    expect(body).toContain('id="step-5-fetch-claim-2" class="secondary" data-finding="fetch" data-kind="claim" data-index="2">Fetch library</button>');
    // The verdict's own words, which name the library, are the reason the thread shows; the card names the button only.
    expect(body).not.toContain('>Decompile<');
    // A .NET package with no exact source turns the button into the decompile offer, still pressed only when pressed.
    const claims = result.claims!;
    const decompiled = {
      ...result,
      claims: {
        ...claims,
        claims: claims.claims.map((claim, index) =>
          index === 2 && claim.verdict.kind !== 'not checked'
            ? { ...claim, verdict: { ...claim.verdict, libraryFetch: { ...REQUESTS_FETCH, decompile: { licence: 'MIT' } } } }
            : claim,
        ),
      },
    };
    expect(sideBarBody(reviewState({ result: decompiled, storyRead: true, marks: marked(...mixedResult().parts) }))).toContain(
      'id="step-5-fetch-claim-2" class="secondary" data-finding="fetch" data-kind="claim" data-index="2">Decompile</button>',
    );
  });

  it('lists the criteria not fully met on step 6 with their issue links, the met ones folded, then the unexplained changes', () => {
    const mapped = mappedCriteriaResult();
    const withUnexplained = { ...mapped, unexplained: unexplainedResult().unexplained };
    const body = sideBarBody(reviewState({ result: withUnexplained, storyRead: true, marks: marked(...mixedResult().parts) }));
    // The logging criterion is not met, with its issue and its draft; the retry one is met, folded.
    expect(body).toContain('<span class="pill tone-bad"><span class="icon" aria-hidden="true">✕</span> not met</span>');
    expect(body).toContain('<q class="quote">The retries are logged</q>');
    expect(body).toContain('<button type="button" class="issue" id="step-6-issue-criterion-1" data-issue="0" aria-label="Open #30 in example-org/example-repo on GitHub">#30 in example-org/example-repo</button> · closes');
    expect(body).toContain('id="step-6-draft-criterion-1" class="secondary" data-finding="draft" data-kind="criterion" data-index="1">Draft comment</button>');
    expect(body).toContain('<p class="folded"><span class="tone-ok" aria-hidden="true">✓</span> 1 met</p>');
    // The settings part is unexplained with its reason and a button that opens it; one described change is quoted from the issue that describes it.
    expect(body).toContain('<h3 class="group">Unexplained changes</h3>');
    expect(body).toContain('<span class="pill tone-warn"><span class="icon" aria-hidden="true">!</span> in the code, not explained</span>');
    expect(body).toContain(`<button type="button" class="open" data-anchor="${JSON.stringify(anchorOf(mixedResult().parts[1]!)).replace(/"/g, '&quot;')}">src/settings.ts</button><span class="where">Raises the timeout from 10 to 30 seconds, which &lt;b&gt;nothing&lt;/b&gt; mentions.</span>`);
    expect(body).toContain('id="step-6-draft-unexplained-part-0" class="secondary" data-finding="draft" data-kind="unexplained part" data-index="0">Draft comment</button>');
    expect(body).toContain('<span class="pill tone-warn"><span class="icon" aria-hidden="true">!</span> described, not in the code</span>');
    expect(body).toContain('id="step-6-draft-described-change-1" class="secondary" data-finding="draft" data-kind="described change" data-index="1">Draft comment</button>');
    expect(body).toMatch(/<input type="checkbox" id="step-6-tick" data-tick="criteria" aria-label="I&#39;ve checked the criteria">/);
    // The ⋯ beside the heading opens the settings at the criteria heading setting.
    expect(body).toContain('<button type="button" class="link" id="step-6-criteriaHeading" data-command="criteriaHeading" aria-label="Change the criteria heading setting">⋯</button>');
  });

  it('keeps every piece of the claims\u2019 and criteria\u2019s text as text on steps 5 and 6', () => {
    const hostile = judgedResult();
    hostile.claims!.claims[1]!.quote = '<img src=x onerror=alert(1)>';
    const criteria = mappedCriteriaResult();
    criteria.criteria!.criteria[1]!.quote = 'The retries are <script>logged</script>';
    const body = sideBarBody(reviewState({ result: { ...hostile, criteria: criteria.criteria, unexplained: unexplainedResult().unexplained }, storyRead: true, marks: marked(...mixedResult().parts) }));
    expect(body).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(body).toContain('The retries are &lt;script&gt;logged&lt;/script&gt;');
    expect(body).not.toMatch(/<img|<script/);
  });
});

describe('the side bar messages', () => {
  const anchor = { path: 'src/retry.py', hunk: { oldStart: 3, newStart: 3 } };

  it('reads only the presses its script reports', () => {
    expect(sideBarMessage({ type: 'ready' })).toEqual({ type: 'ready' });
    expect(sideBarMessage({ type: 'command', command: 'send' })).toEqual({ type: 'command', command: 'send' });
    expect(sideBarMessage({ type: 'command', command: 'verifyClaim' })).toEqual({ type: 'command', command: 'verifyClaim' });
    expect(sideBarMessage({ type: 'command', command: 'criteriaHeading' })).toEqual({ type: 'command', command: 'criteriaHeading' });
    expect(sideBarMessage({ type: 'command', command: 'nextPart' })).toEqual({ type: 'command', command: 'nextPart' });
    expect(sideBarMessage({ type: 'mark', anchor, reviewed: true })).toEqual({ type: 'mark', anchor, reviewed: true });
    expect(sideBarMessage({ type: 'openPart', anchor })).toEqual({ type: 'openPart', anchor });
    expect(sideBarMessage({ type: 'finding', action: 'draft', kind: 'claim', index: 2 })).toEqual({ type: 'finding', action: 'draft', finding: { kind: 'claim', index: 2 } });
    expect(sideBarMessage({ type: 'finding', action: 'fetch', kind: 'criterion', index: 0 })).toEqual({ type: 'finding', action: 'fetch', finding: { kind: 'criterion', index: 0 } });
    expect(sideBarMessage({ type: 'openIssue', issue: 1 })).toEqual({ type: 'openIssue', issue: 1 });
    expect(sideBarMessage({ type: 'tick', step: 'criteria', checked: true })).toEqual({ type: 'tick', step: 'criteria', checked: true });
    expect(sideBarMessage({ type: 'command', command: 'workbench.action.terminal.new' })).toBeUndefined();
    expect(sideBarMessage({ type: 'command', command: 'toString' })).toBeUndefined();
    expect(sideBarMessage({ type: 'mark', anchor, reviewed: 'yes' })).toBeUndefined();
    expect(sideBarMessage({ type: 'openPart', anchor: { path: 3 } })).toBeUndefined();
    expect(sideBarMessage({ type: 'finding', action: 'discard', kind: 'claim', index: 2 })).toBeUndefined();
    expect(sideBarMessage({ type: 'finding', action: 'draft', kind: 'part', index: 2 })).toBeUndefined();
    expect(sideBarMessage({ type: 'finding', action: 'draft', kind: 'claim', index: 'two' })).toBeUndefined();
    expect(sideBarMessage({ type: 'openIssue', issue: '0' })).toBeUndefined();
    expect(sideBarMessage({ type: 'tick', step: 'parts', checked: true })).toBeUndefined();
    expect(sideBarMessage({ type: 'tick', step: 'claims', checked: 'yes' })).toBeUndefined();
    expect(sideBarMessage(null)).toBeUndefined();
  });
});

describe('the side bar view', () => {
  beforeEach(() => stub.reset());

  /** A provider given a state before its view opened, then resolved the way opening the container does. */
  function resolved(state: SideBarState): { provider: SideBarProvider; view: StubWebviewView } {
    const provider = new SideBarProvider(EMPTY);
    provider.update(state, { value: 7, tooltip: '7 of 7 parts left to review' });
    window.registerWebviewViewProvider(REVIEW_TREE_VIEW, provider);
    return { provider, view: stub.webviewViewProviders[0]!.resolve() };
  }

  it('draws the state it was given before the view opened, with the badge counting the parts left', () => {
    const { view } = resolved(reviewState());
    expect(view.webview.options).toEqual({ enableScripts: true, enableCommandUris: false, localResourceRoots: [] });
    expect(view.webview.html).toContain('<li class="step current" id="step-3" aria-current="step">');
    expect(view.badge).toEqual({ value: 7, tooltip: '7 of 7 parts left to review' });
  });

  it('redraws by message, keeping the page, and answers a reloaded page with the cards', () => {
    const { provider, view } = resolved(reviewState());
    const html = view.webview.html;
    provider.update(reviewState({ storyRead: true }), undefined);
    expect(view.webview.html).toBe(html);
    expect(view.badge).toBeUndefined();
    expect(view.webview.posted.at(-1)).toEqual({ type: 'render', body: sideBarBody(reviewState({ storyRead: true })) });

    view.webview.posted.length = 0;
    view.webview.receive({ type: 'ready' });
    expect(view.webview.posted).toEqual([{ type: 'render', body: sideBarBody(reviewState({ storyRead: true })) }]);
  });

  it('runs the existing command for every button, and for the checkbox the mark-reviewed path', () => {
    const result = mixedResult();
    const { view } = resolved(reviewState({ marks: marked(result.parts[0]!) }));
    const first = anchorOf(result.parts[0]!);
    for (const command of ['review', 'overview', 'nextPart', 'allParts', 'send']) view.webview.receive({ type: 'command', command });
    view.webview.receive({ type: 'mark', anchor: first, reviewed: false });
    view.webview.receive({ type: 'openPart', anchor: first });
    view.webview.receive({ type: 'openPart', anchor: { path: 'nowhere.ts' } });

    expect(stub.executedCommands).toEqual([
      { id: REVIEW_COMMAND, args: [] },
      { id: OPEN_OVERVIEW_COMMAND, args: [] },
      { id: OPEN_PART_COMMAND, args: [result.parts[1]] },
      { id: OPEN_ALL_PARTS_COMMAND, args: [] },
      { id: SUBMIT_REVIEW_COMMAND, args: [] },
      { id: MARK_REVIEWED_COMMAND, args: [{ anchor: first }, false] },
      { id: OPEN_PART_COMMAND, args: [result.parts[0]] },
    ]);
  });

  it('runs the existing command for every finding action, opens the issue on GitHub and the setting in the Settings editor', async () => {
    const result = { ...offeredResult(), criteria: mappedCriteriaResult().criteria };
    const opened: [string, number][] = [];
    const deps: SideBarDeps = {
      openLine: (path, line) => opened.push([path, line]),
      ticks: new StepTickStore(stubContext().globalState),
    };
    const provider = new SideBarProvider(reviewState({ result, storyRead: true, marks: marked(...mixedResult().parts) }), undefined, undefined, deps);
    window.registerWebviewViewProvider(REVIEW_TREE_VIEW, provider);
    const view = stub.webviewViewProviders[0]!.resolve();
    const part = result.parts[result.claims!.claims[1]!.part]!;
    const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

    view.webview.receive({ type: 'finding', action: 'draft', kind: 'claim', index: 1 });
    view.webview.receive({ type: 'finding', action: 'verify', kind: 'claim', index: 1 });
    view.webview.receive({ type: 'finding', action: 'fetch', kind: 'claim', index: 2 });
    view.webview.receive({ type: 'finding', action: 'open', kind: 'claim', index: 1 });
    view.webview.receive({ type: 'finding', action: 'open', kind: 'claim', index: 3 });
    view.webview.receive({ type: 'finding', action: 'open', kind: 'unexplained part', index: 0 });
    view.webview.receive({ type: 'finding', action: 'draft', kind: 'described change', index: 0 });
    view.webview.receive({ type: 'finding', action: 'open', kind: 'claim', index: 99 });
    view.webview.receive({ type: 'command', command: 'verifyClaim' });
    view.webview.receive({ type: 'command', command: 'criteriaHeading' });
    view.webview.receive({ type: 'openIssue', issue: 0 });
    view.webview.receive({ type: 'openIssue', issue: 9 });
    await settle;
    await Promise.all(stub.commandRuns);

    expect(stub.executedCommands).toEqual([
      { id: DRAFT_COMMENT_COMMAND, args: [{ kind: 'claim', index: 1 }] },
      { id: askCommand('verify'), args: [{ anchor: anchorOf(part), claim: 1 }] },
      { id: FETCH_LIBRARY_COMMAND, args: [2] },
      // The docstring claim opens its line in the head copy; the story claim, with no line of its own, its part; a claim that is not there, nothing.
      { id: OPEN_PART_COMMAND, args: [result.parts[1]] },
      { id: DRAFT_COMMENT_COMMAND, args: [{ kind: 'described change', index: 0 }] },
      { id: askCommand('verify'), args: [] },
      { id: OPEN_SETTINGS_COMMAND, args: ['@id:second-look.criteriaHeading'] },
    ]);
    expect(opened).toEqual([['src/retry.py', 3]]);
    expect(stub.openedExternals).toEqual(['https://github.com/example-org/example-repo/issues/30']);
  });

  it('keeps the steps\u2019 ticks per pull request, and redraws the cards with the tick the reviewer pressed', async () => {
    const result = judgedResult();
    const deps: SideBarDeps = { openLine: () => undefined, ticks: new StepTickStore(stubContext().globalState) };
    const provider = new SideBarProvider(reviewState({ result, storyRead: true, marks: marked(...mixedResult().parts) }), undefined, undefined, deps);
    window.registerWebviewViewProvider(REVIEW_TREE_VIEW, provider);
    const view = stub.webviewViewProviders[0]!.resolve();
    expect(view.webview.html).not.toContain('id="step-5-tick" checked');

    /** Waits until the condition holds, polling the way a redraw lands. */
    const until = async (condition: () => boolean): Promise<void> => {
      for (let waited = 0; !condition(); waited += 10) {
        if (waited > 5_000) throw new Error('timed out waiting for the redraw');
        await new Promise((done) => setTimeout(done, 10));
      }
    };
    const lastBody = (): string => {
      const renders = view.webview.posted.filter((message): message is { body: string } => (message as { type?: string }).type === 'render');
      return renders.at(-1)?.body ?? '';
    };
    view.webview.receive({ type: 'tick', step: 'claims', checked: true });
    await until(() => lastBody().includes('aria-label="I&#39;ve checked the claims" checked'));
    const drawn = lastBody();
    expect(drawn).toMatch(/<input type="checkbox" id="step-5-tick" data-tick="claims" aria-label="I&#39;ve checked the claims" checked>/);
    expect(drawn).toContain('<li class="step done" id="step-5">');
    expect(deps.ticks.read(result.pullRequest.url, result.pullRequest.headSha)).toEqual({ claims: true, criteria: false });

    // A tick only holds at the head it was taken on: new commits re-open the step.
    expect(deps.ticks.read(result.pullRequest.url, '998ded4a1234567890abcdef1234567890abcdef12')).toEqual({ claims: false, criteria: false });
    view.webview.receive({ type: 'tick', step: 'claims', checked: false });
    await until(() => !lastBody().includes('aria-label="I&#39;ve checked the claims" checked'));
    expect(deps.ticks.read(result.pullRequest.url, result.pullRequest.headSha)).toEqual({ claims: false, criteria: false });
  });
});
