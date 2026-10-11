import { describe, expect, it } from 'vitest';
import { NO_MARKS, type Comment, type ReviewResult } from '@second-look/engine';
import { sideBarBody } from '../src/side-bar/page.js';
import {
  endNotice,
  finishedProgress,
  formatDuration,
  progressBody,
  readingProgress,
  reviewStatusText,
  reviewStatusTooltip,
  reviewTime,
  runningProgress,
  type ReviewProgress,
} from '../src/side-bar/progress.js';
import { sideBarSteps, type SideBarState } from '../src/side-bar/steps.js';
import { buildTree, pendingReviewSection } from '../src/tree.js';
import { claimsResult, criteriaResult, mixedResult, reviewStages, STAGE_MS, STAGES_START } from './results.js';

const SETTINGS = { agent: 'pi' as const, model: '', effort: '', account: '' };

/** A review of claims and criteria, its stages standing as given. */
function staged(stages: ReturnType<typeof reviewStages>): ReviewResult {
  return { ...claimsResult(), criteria: criteriaResult().criteria!, stages };
}

/** The side bar's state while the stage named runs, or once the review ended. */
function state(result: ReviewResult, progress: ReviewProgress | undefined, overrides: Partial<SideBarState> = {}, comments: Comment[] = []): SideBarState {
  return {
    settings: SETTINGS,
    result,
    marks: NO_MARKS,
    sections: [...(comments.length > 0 ? [pendingReviewSection(comments)] : []), ...buildTree(result, NO_MARKS)],
    reviewing: progress?.state === 'running',
    storyRead: false,
    ...(progress !== undefined ? { progress } : {}),
    ...overrides,
  };
}

/** The verdicts stage, seventh of nine, running for 1:42. */
const VERDICTS_RUNNING = reviewStages('verdicts');
const VERDICTS_STARTED = STAGES_START + 6 * STAGE_MS;
const NOW = VERDICTS_STARTED + 102_000;

describe('the review progress', () => {
  it('shows times as minutes and seconds, with hours once there is one', () => {
    expect(formatDuration(0)).toBe('0:00');
    expect(formatDuration(252_000)).toBe('4:12');
    expect(formatDuration(3_723_000)).toBe('1:02:03');
    expect(formatDuration(-5)).toBe('0:00');
  });

  it('takes the stage running from the stage notification, or else from the result it carries', () => {
    const result = staged(VERDICTS_RUNNING);
    const named = { ...VERDICTS_RUNNING[6]!, detail: 'named' };
    expect(runningProgress({ running: 'checking the claims with claude-code', result, stage: named })).toEqual({ state: 'running', stage: named });
    expect(runningProgress({ running: 'checking the claims with claude-code', result })).toEqual({ state: 'running', stage: VERDICTS_RUNNING[6] });
    expect(runningProgress({ running: 'grouping', result: mixedResult() })).toBeUndefined();
    expect(readingProgress(new Date(STAGES_START))).toEqual({
      state: 'running',
      stage: { id: 'plain', position: 1, total: 9, state: 'running', startedAt: '2026-10-11T10:00:00.000Z' },
    });
    expect(finishedProgress(mixedResult())).toBeUndefined();
  });

  it('measures the review from its first stage start to its last stage end', () => {
    expect(reviewTime(reviewStages())).toBe(252_000);
    expect(reviewTime(reviewStages(undefined, { docLinks: { state: 'stopped', startedAt: undefined, durationMs: undefined, agent: undefined } }))).toBe(8 * STAGE_MS);
  });

  it('names the place of the stage running and the agent, model and effort on it, in the status bar', () => {
    const stage = VERDICTS_RUNNING[6]!;
    expect(reviewStatusText(stage, SETTINGS)).toBe('7/9 Second Look: Claude Code · claude-sonnet-5-5 · effort high');
    expect(reviewStatusTooltip(stage)).toBe('Reviewing: checking the claims, stage 7 of 9');
    // The plain pass runs no agent: the settings say who the review runs on.
    const reading = readingProgress(new Date(STAGES_START));
    expect(reading.state === 'running' && reviewStatusText(reading.stage, { agent: 'claude-code', model: '', effort: 'max', account: 'work' })).toBe(
      '1/9 Second Look: Claude Code · default model · effort max · work',
    );
  });
});

describe('the progress strip and the count tiles', () => {
  it('shows the stage running, the agent, model and effort, the time so far and "stage 7 of 9", with a spinner on the claims tile', () => {
    const result = staged(VERDICTS_RUNNING);
    const html = progressBody(state(result, { state: 'running', stage: VERDICTS_RUNNING[6]! }), NOW);

    expect(html).toContain('<b>Checking the claims</b> · Claude Code · claude-sonnet-5-5 · effort high');
    expect(html).toContain(`<span class="elapsed" data-started="${VERDICTS_STARTED}">1:42</span> · stage 7 of 9`);
    expect(html).toContain(`<span class="big">${result.parts.length}<small>/${result.parts.length}</small></span><span class="lb">parts left</span>`);
    expect(html).toContain(`<span class="sr-only">being produced</span></span><span class="lb">claims · ${result.claims!.claims.length}</span>`);
    expect(html).toContain(`<span class="big">${result.criteria!.criteria.length}</span><span class="lb">criteria</span>`);
    expect(html).toContain('<span class="big">0</span><span class="lb">comments</span>');
  });

  it('counts a dash for what has not landed, and the pending comments', () => {
    const comment: Comment = { kind: 'line', path: 'src/retry.py', line: 5, side: 'head', body: 'Why five?' };
    const html = progressBody(state(mixedResult(), undefined, {}, [comment]));
    expect(html).toContain('<span class="big">–</span><span class="lb">claims</span>');
    expect(html).toContain('<span class="big">–</span><span class="lb">criteria</span>');
    expect(html).toContain('<span class="big">1</span><span class="lb">comments</span>');
    expect(html).not.toContain('class="strip');
  });

  it('reads "Review complete in 4:12" at the end, with each stage that fell back or failed and why, escaped', () => {
    const stages = reviewStages(undefined, {
      ranking: { state: 'fell back', detail: 'no ranking evaluation for <b>this</b> combination yet' },
      story: { state: 'failed', detail: 'the agent stopped' },
    });
    const html = progressBody(state(staged(stages), finishedProgress(staged(stages))));

    expect(html).toContain('<b>Review complete</b> in 4:12');
    expect(html).toContain('<li class="fell-back"><span class="icon" aria-hidden="true">⊘</span> Ranking fell back: no ranking evaluation for &lt;b&gt;this&lt;/b&gt; combination yet</li>');
    expect(html).toContain('<li class="failed"><span class="icon" aria-hidden="true">✕</span> The story failed: the agent stopped</li>');
    expect(html).not.toContain('<b>this</b>');
    expect(progressBody(state(staged(reviewStages()), finishedProgress(staged(reviewStages()))))).not.toContain('stage-notes');
  });

  it('says what a stop kept from finishing', () => {
    const stopped = { state: 'stopped' as const, detail: 'the review was stopped before this stage finished' };
    const stages = reviewStages(undefined, {
      verdicts: { ...stopped, durationMs: 1_000 },
      criteria: { ...stopped, startedAt: undefined, durationMs: undefined, agent: undefined },
      docLinks: { ...stopped, startedAt: undefined, durationMs: undefined, agent: undefined },
    });
    const html = progressBody(state(staged(stages), finishedProgress(staged(stages))));

    expect(html).toContain('<b>Review stopped</b> after 2:49');
    expect(html).toContain('Stopped: the verdicts, the criteria mapping and the documentation links');
    expect(progressBody(state(mixedResult(), { state: 'stopped early' }))).toContain('<b>Review stopped</b> before its first result landed, so nothing was kept');
  });

  it('draws the tiles and the strip above the steps, and nothing before any review', () => {
    const html = sideBarBody(state(staged(VERDICTS_RUNNING), { state: 'running', stage: VERDICTS_RUNNING[6]! }), NOW);
    expect(html.indexOf('<section class="progress" aria-label="Review progress">')).toBe(0);
    expect(html.indexOf('class="tiles"')).toBeLessThan(html.indexOf('<ol class="steps"'));
    expect(progressBody({ settings: SETTINGS, marks: NO_MARKS, sections: [], reviewing: false, storyRead: false })).toBe('');
  });
});

describe('the steps while a review runs in stages', () => {
  it('spins on the step being produced and shows a clock on the steps waiting for it', () => {
    const steps = sideBarSteps(state(staged(VERDICTS_RUNNING), { state: 'running', stage: VERDICTS_RUNNING[6]! }));
    // Stage 7, the verdicts, runs: step 5 spins and step 6 waits on the criteria mapping.
    expect(steps.map((step) => step.state)).toEqual(['done', 'done', 'current', 'to come', 'running', 'waiting', 'to come', 'to come']);

    const grouping = staged(reviewStages('grouping'));
    const early = sideBarSteps(state({ ...grouping, story: undefined }, { state: 'running', stage: grouping.stages![1]! }));
    expect(early.map((step) => step.state)).toEqual(['done', 'done', 'waiting', 'running', 'waiting', 'waiting', 'to come', 'to come']);
    expect(early[2]).toMatchObject({ open: true, summary: 'to be written' });

    const html = sideBarBody(state(staged(VERDICTS_RUNNING), { state: 'running', stage: VERDICTS_RUNNING[6]! }), NOW);
    expect(html).toContain('<li class="step waiting" id="step-6">');
    expect(html).toMatch(/id="step-6"[^]*?<span class="icon" aria-hidden="true">◷<\/span>[^]*?<span class="state">waiting<\/span>/);
  });

  it('runs and waits no more once the review ended', () => {
    const result = staged(reviewStages());
    expect(sideBarSteps(state(result, finishedProgress(result))).map((step) => step.state)).toEqual([
      'done',
      'done',
      'current',
      'to come',
      'to come',
      'to come',
      'to come',
      'to come',
    ]);
  });
});

describe('the notification at the end of a review', () => {
  it('appears only when a stage fell back or failed, saying which and why', () => {
    expect(endNotice(staged(reviewStages()))).toBeUndefined();
    expect(endNotice(mixedResult())).toBeUndefined();
    const fellBack = staged(reviewStages(undefined, { ranking: { state: 'fell back', detail: 'Claude Code with claude-sonnet-5-5 at effort high has no ranking evaluation yet' } }));
    expect(endNotice(fellBack)).toBe(
      'Second Look finished reviewing #42 in 4:12. Ranking fell back: Claude Code with claude-sonnet-5-5 at effort high has no ranking evaluation yet.',
    );
    const failedThenStopped = staged(
      reviewStages(undefined, { grouping: { state: 'failed', detail: 'the agent crashed' }, docLinks: { state: 'stopped', startedAt: undefined, durationMs: undefined } }),
    );
    expect(endNotice(failedThenStopped)).toBe('Second Look stopped reviewing #42 in 3:44. Grouping failed: the agent crashed.');
  });
});
