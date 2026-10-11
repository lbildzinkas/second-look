import { isAgentName, partsLeft, REVIEW_STAGE_IDS, type ReviewResult, type ReviewStageId, type ReviewStageRecord } from '@second-look/engine';
import { agentStatusBarText, type AgentSettings } from '../agent-settings.js';
import type { ReviewStageUpdate } from '../engine-client.js';
import { escapeHtml } from '../overview.js';
import { pendingComments, setupLine, type SideBarState } from './steps.js';

/**
 * How the review stands, as the side bar's progress strip and the status
 * bar show it: a stage **running**; **finished**, complete or stopped, with
 * every stage and how it ended; or **stopped early**, before its first
 * result landed, so nothing was kept.
 */
export type ReviewProgress =
  | { state: 'running'; stage: ReviewStageRecord }
  | { state: 'finished'; stages: readonly ReviewStageRecord[] }
  | { state: 'stopped early' };

/** What the strip says a running stage is doing. */
const STAGE_DOING: Record<ReviewStageId, string> = {
  plain: 'Reading the pull request',
  grouping: 'Grouping the hunks',
  ranking: 'Ranking the parts',
  story: 'Writing the story',
  unexplained: 'Comparing the change with its description',
  claims: 'Listing the claims',
  verdicts: 'Checking the claims',
  criteria: 'Mapping the criteria',
  docLinks: 'Linking the documentation',
};

/** What the end of a review calls each stage, as the reviewing guide lists them. */
const STAGE_NAMES: Record<ReviewStageId, string> = {
  plain: 'The plain pass',
  grouping: 'Grouping',
  ranking: 'Ranking',
  story: 'The story',
  unexplained: 'The comparison',
  claims: 'The claims',
  verdicts: 'The verdicts',
  criteria: 'The criteria mapping',
  docLinks: 'The documentation links',
};

/** The plain pass running from `startedAt`: the first stage, before the engine announces any other. */
export function readingProgress(startedAt: Date): ReviewProgress {
  return { state: 'running', stage: { id: 'plain', position: 1, total: REVIEW_STAGE_IDS.length, state: 'running', startedAt: startedAt.toISOString() } };
}

/** The stage a stage notification names running, or the one its result marks running; undefined when neither does. */
export function runningProgress(update: ReviewStageUpdate): ReviewProgress | undefined {
  const stage = update.stage ?? update.result.stages?.find((record) => record.state === 'running');
  return stage === undefined ? undefined : { state: 'running', stage };
}

/** The finished review, with how each stage ended; undefined for a review that ran no stage, such as a plain one. */
export function finishedProgress(result: ReviewResult): ReviewProgress | undefined {
  return result.stages === undefined ? undefined : { state: 'finished', stages: result.stages };
}

/** A time span as the strip shows it: minutes and seconds, with hours once it reaches one. */
export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const ss = String(seconds % 60).padStart(2, '0');
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, '0')}:${ss}` : `${minutes}:${ss}`;
}

/** How long the review took: from the first stage's start to the last stage's end. */
export function reviewTime(stages: readonly ReviewStageRecord[]): number {
  const ran = stages.filter((stage) => stage.startedAt !== undefined);
  if (ran.length === 0) return 0;
  const start = Math.min(...ran.map((stage) => Date.parse(stage.startedAt!)));
  const end = Math.max(...ran.map((stage) => Date.parse(stage.startedAt!) + (stage.durationMs ?? 0)));
  return end - start;
}

/** The agent, model and effort a stage runs on, the account label kept from the settings; the settings' own for a stage with no agent, such as the plain pass. */
function stageSettings(stage: ReviewStageRecord, settings: AgentSettings): AgentSettings {
  const { agent } = stage;
  if (agent === undefined || !isAgentName(agent.agent)) return settings;
  return { agent: agent.agent, model: agent.model ?? '', effort: agent.effort ?? '', account: settings.account };
}

/** The status bar's words while a stage runs: `7/9 Second Look: Claude Code · claude-sonnet-5-5 · effort high`. */
export function reviewStatusText(stage: ReviewStageRecord, settings: AgentSettings): string {
  return `${stage.position}/${stage.total} ${agentStatusBarText(stageSettings(stage, settings))}`;
}

/** The status bar's tooltip line while a stage runs: what it does, and its place. */
export function reviewStatusTooltip(stage: ReviewStageRecord): string {
  return `Reviewing: ${STAGE_DOING[stage.id].toLowerCase()}, stage ${stage.position} of ${stage.total}`;
}

/** A stage's name inside a sentence. */
function inSentence(id: ReviewStageId): string {
  const name = STAGE_NAMES[id];
  return name.startsWith('The ') ? `the ${name.slice(4)}` : name.toLowerCase();
}

/** Each stage that fell back or failed, with why, as one line each. */
function endNotes(stages: readonly ReviewStageRecord[]): { state: 'fell back' | 'failed'; line: string }[] {
  return stages
    .filter((stage): stage is ReviewStageRecord & { state: 'fell back' | 'failed' } => stage.state === 'fell back' || stage.state === 'failed')
    .map((stage) => ({ state: stage.state, line: `${STAGE_NAMES[stage.id]} ${stage.state}${stage.detail === undefined ? '' : `: ${stage.detail}`}` }));
}

/** The stages the reviewer's stop kept from finishing. */
function stoppedStages(stages: readonly ReviewStageRecord[]): ReviewStageId[] {
  return stages.filter((stage) => stage.state === 'stopped').map((stage) => stage.id);
}

/** A list in words: `a`, `a and b`, `a, b and c`. */
function listed(items: readonly string[]): string {
  return items.length < 2 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)!}`;
}

/**
 * The notification at the end of a review, only when a stage fell back or
 * failed: how long it took and each such stage with why. A clean finish
 * only changes the strip and the status bar, so it has none.
 */
export function endNotice(result: ReviewResult): string | undefined {
  const stages = result.stages ?? [];
  const notes = endNotes(stages);
  if (notes.length === 0) return undefined;
  const verb = stoppedStages(stages).length > 0 ? 'stopped reviewing' : 'finished reviewing';
  return `Second Look ${verb} #${result.pullRequest.number} in ${formatDuration(reviewTime(stages))}. ${notes.map((note) => `${note.line}.`).join(' ')}`;
}

/** A count tile: its number, or a spinner while the stage producing it runs, or a dash before it lands. */
function tile(label: string, count: number | undefined, producing: boolean, of?: number): string {
  const big = producing
    ? '<span class="spin" aria-hidden="true">↻</span><span class="sr-only">being produced</span>'
    : count === undefined
      ? '–'
      : `${count}${of === undefined ? '' : `<small>/${of}</small>`}`;
  const words = producing && count !== undefined ? `${label} · ${count}` : label;
  return `<li class="tile"><span class="big">${big}</span><span class="lb">${escapeHtml(words)}</span></li>`;
}

/** True while one of these stages runs. */
function producing(progress: ReviewProgress | undefined, ...ids: ReviewStageId[]): boolean {
  return progress?.state === 'running' && ids.includes(progress.stage.id);
}

/** The count tiles of the review shown: the parts left, the claims, the criteria and the comments. */
function tiles(state: SideBarState, result: ReviewResult): string {
  const { progress } = state;
  return (
    '<ul class="tiles" aria-label="Review counts">' +
    tile('parts left', partsLeft(result.parts, state.marks), false, result.parts.length) +
    tile('claims', result.claims?.claims.length, producing(progress, 'claims', 'verdicts')) +
    tile('criteria', result.criteria?.criteria.length, producing(progress, 'criteria')) +
    tile('comments', pendingComments(state.sections), false) +
    '</ul>'
  );
}

/** The strip while a stage runs: what it does, the agent, model and effort, the time so far, which the page ticks, and its place. */
function runningStrip(stage: ReviewStageRecord, settings: AgentSettings, now: number): string {
  const started = stage.startedAt === undefined ? undefined : Date.parse(stage.startedAt);
  const elapsed = started === undefined ? '' : ` · <span class="elapsed" data-started="${started}">${formatDuration(now - started)}</span>`;
  return (
    '<p class="strip running"><span class="icon spin" aria-hidden="true">↻</span> ' +
    `<b>${escapeHtml(STAGE_DOING[stage.id])}</b> · ${escapeHtml(setupLine(stageSettings(stage, settings)))}${elapsed} · ${escapeHtml(`stage ${stage.position} of ${stage.total}`)}</p>`
  );
}

/** The strip once the review ended: complete or stopped, in how long, then each stage that fell back, failed or was stopped, with why. */
function finishedStrip(stages: readonly ReviewStageRecord[]): string {
  const stopped = stoppedStages(stages);
  const time = formatDuration(reviewTime(stages));
  const head =
    stopped.length > 0
      ? `<p class="strip stopped"><span class="icon" aria-hidden="true">■</span> <b>Review stopped</b> after ${time}</p>`
      : `<p class="strip complete"><span class="icon" aria-hidden="true">✓</span> <b>Review complete</b> in ${time}</p>`;
  const notes = endNotes(stages).map(
    (note) => `<li class="${note.state.replace(' ', '-')}"><span class="icon" aria-hidden="true">${note.state === 'failed' ? '✕' : '⊘'}</span> ${escapeHtml(note.line)}</li>`,
  );
  const stops = stopped.length === 0 ? [] : [`<li class="stopped"><span class="icon" aria-hidden="true">■</span> ${escapeHtml(`Stopped: ${listed(stopped.map(inSentence))}`)}</li>`];
  const lines = [...notes, ...stops];
  return head + (lines.length === 0 ? '' : `<ul class="stage-notes">${lines.join('')}</ul>`);
}

/**
 * Above the steps: the count tiles of the review shown, then the progress
 * strip — the stage running with the agent, model and effort, its time so
 * far and its place, or once the review ended, complete or stopped in how
 * long, with each stage that fell back, failed or was stopped and why.
 * Every piece of text escaped; empty before any review.
 */
export function progressBody(state: SideBarState, now: number = Date.now()): string {
  const { progress, result } = state;
  const counts = result === undefined ? '' : tiles(state, result);
  const strip =
    progress === undefined
      ? ''
      : progress.state === 'running'
        ? runningStrip(progress.stage, state.settings, now)
        : progress.state === 'finished'
          ? finishedStrip(progress.stages)
          : '<p class="strip stopped"><span class="icon" aria-hidden="true">■</span> <b>Review stopped</b> before its first result landed, so nothing was kept</p>';
  if (counts === '' && strip === '') return '';
  return `<section class="progress" aria-label="Review progress">${counts}${strip}</section>`;
}
