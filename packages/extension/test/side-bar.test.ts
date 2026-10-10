import { beforeEach, describe, expect, it } from 'vitest';
import { applyMark, markedPart, NO_MARKS, type Comment, type Part, type ReviewedMarks } from '@second-look/engine';
import {
  MARK_REVIEWED_COMMAND,
  OPEN_ALL_PARTS_COMMAND,
  OPEN_OVERVIEW_COMMAND,
  OPEN_PART_COMMAND,
  REVIEW_COMMAND,
  REVIEW_TREE_VIEW,
  SUBMIT_REVIEW_COMMAND,
} from '../src/commands.js';
import { sideBarBody, sideBarHtml } from '../src/side-bar/page.js';
import { SideBarProvider, sideBarMessage } from '../src/side-bar/provider.js';
import { nextPartToReview, setupLine, sideBarSteps, type SideBarState } from '../src/side-bar/steps.js';
import { anchorOf, buildTree, pendingReviewSection } from '../src/tree.js';
import { claimsResult, mixedResult } from './results.js';
import { stub, window, type StubWebviewView } from './vscode-stub.js';

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
    expect(body).toMatch(/^<ol class="steps" aria-label="Review path" data-current="3">/);
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
});

describe('the side bar messages', () => {
  const anchor = { path: 'src/retry.py', hunk: { oldStart: 3, newStart: 3 } };

  it('reads only the presses its script reports', () => {
    expect(sideBarMessage({ type: 'ready' })).toEqual({ type: 'ready' });
    expect(sideBarMessage({ type: 'command', command: 'send' })).toEqual({ type: 'command', command: 'send' });
    expect(sideBarMessage({ type: 'command', command: 'nextPart' })).toEqual({ type: 'command', command: 'nextPart' });
    expect(sideBarMessage({ type: 'mark', anchor, reviewed: true })).toEqual({ type: 'mark', anchor, reviewed: true });
    expect(sideBarMessage({ type: 'openPart', anchor })).toEqual({ type: 'openPart', anchor });
    expect(sideBarMessage({ type: 'command', command: 'workbench.action.terminal.new' })).toBeUndefined();
    expect(sideBarMessage({ type: 'command', command: 'toString' })).toBeUndefined();
    expect(sideBarMessage({ type: 'mark', anchor, reviewed: 'yes' })).toBeUndefined();
    expect(sideBarMessage({ type: 'openPart', anchor: { path: 3 } })).toBeUndefined();
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
});
