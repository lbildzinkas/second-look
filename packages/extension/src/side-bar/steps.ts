import { isFinding, parsePullRequestUrl, partsLeft, reviewedState, CRITERION_VERDICT_KINDS, type AgentName, type Part, type ReviewedMarks, type ReviewResult, type ReviewStageId, type SubmitKind } from '@second-look/engine';
import type { AgentSettings } from '../agent-settings.js';
import type { ListedComment } from '../comments.js';
import { partsInReadingOrder, type TreeSection } from '../tree.js';
import type { ReviewProgress } from './progress.js';
import { listedCount, type PullRequestPickerView } from './pull-requests.js';
import type { SetupView } from './setup.js';
import type { StepTicks } from './step-ticks.js';

/** Where one step of the review path stands: **waiting** while the stage that produces it has yet to start. */
export type StepState = 'done' | 'current' | 'running' | 'waiting' | 'to come';

/** What the side bar draws its eight steps from: the review session as it stands. */
export interface SideBarState {
  /** The agent settings the setup line shows. */
  settings: AgentSettings;
  /** The review shown; absent before the first. */
  result?: ReviewResult;
  /** The reviewed marks of the pull request shown. */
  marks: ReviewedMarks;
  /** The tree's sections: the pending review first when it holds a comment, then the ranked parts. */
  sections: readonly TreeSection[];
  /** The line above the parts: what changed since the last look, and the stage still running. */
  message?: string;
  /** True while a review's engine request is still out. */
  reviewing: boolean;
  /** True once the reviewer opened the story, or moved on to the parts. */
  storyRead: boolean;
  /** Step 1's setup form; while it is open, step 1 is the current step. */
  setup?: SetupView;
  /** Step 2's list of the reviewer's open pull requests. */
  pullRequests?: PullRequestPickerView;
  /** How the review stands: the stage running, or how it ended; absent before any review and for one that ran no stage. */
  progress?: ReviewProgress;
  /** The steps' “I’ve checked these” ticks, as they stand for the review shown. */
  ticks?: StepTicks;
  /** Step 7's list: the pending review's comments, then the drafts not yet added nor discarded. */
  comments?: readonly ListedComment[];
  /** True while step 4 shows only the parts changed since the reviewer's last look. */
  onlyChanged?: boolean;
  /** The review sent from the review shown, once Submit sent it. */
  sent?: SentSummary;
  /** Why the last send failed, every comment kept; cleared by the next send. */
  sendFailure?: string;
}

/** A review that reached GitHub, as step 8 shows it. */
export interface SentSummary {
  submit: SubmitKind;
  /** How many comments it carried. */
  comments: number;
  /** The head commit it is pinned to. */
  commit: string;
  /** The review on GitHub. */
  url: string;
}

/** One step's card, as its header shows it. */
export interface Step {
  /** The step's place on the path, 1 to 8. */
  number: number;
  title: string;
  state: StepState;
  /** True for the current step, the first one not done, whose card is open; the others fold. */
  open: boolean;
  /** The short line beside the title; empty when there is nothing to say. */
  summary: string;
}

const TITLES = [
  'Set up the agent',
  'Pick a pull request',
  'Read the story',
  'Review the parts',
  'Claims and verdicts',
  'Criteria and unexplained',
  'Comments',
  'Send the review',
] as const;

const AGENT_NAMES: Record<AgentName, string> = { pi: 'Pi', 'claude-code': 'Claude Code' };

/** The review stages that produce each step's results, by the step's place on the path. */
const STEP_STAGES: readonly (readonly ReviewStageId[])[] = [[], ['plain'], ['story'], ['grouping', 'ranking'], ['claims', 'verdicts'], ['unexplained', 'criteria'], [], []];

/** How many comments the pending review holds. */
export function pendingComments(sections: readonly TreeSection[]): number {
  return sections.flatMap((section) => section.parts).filter((node) => node.kind === 'comment').length;
}

/** The setup line: the agent, the model and the effort every agent pass runs on. */
export function setupLine(settings: AgentSettings): string {
  const model = settings.model === '' ? 'default model' : settings.model;
  const effort = settings.effort === '' ? 'default effort' : `effort ${settings.effort}`;
  return `${AGENT_NAMES[settings.agent]} · ${model} · ${effort}`;
}

/**
 * The eight steps of the review path (ADR 0008), each with its state: done
 * where it can be measured — the settings always choose an agent, unless
 * the setup form is open, a review is open, the story was read, every part is reviewed, the reviewer ticked
 * the step’s “I’ve checked these” box, no draft is left undecided once a
 * comment is written or the review sent, the review was sent with nothing
 * new written since — running while its
 * results are still arriving, waiting while the review stage producing
 * them has yet to start, and otherwise current or still to come. The
 * current step is the first one not done; its card is open and the others
 * fold.
 */
export function sideBarSteps(state: SideBarState): Step[] {
  const { result, reviewing } = state;
  const open = result !== undefined;
  const left = open ? partsLeft(result.parts, state.marks) : 0;
  const listed = state.comments ?? [];
  const comments = listed.filter((comment) => comment.kind === 'comment').length;
  const drafts = listed.length - comments;
  const sent = open && state.sent !== undefined;
  const done = [
    state.setup?.open !== true,
    open,
    open && state.storyRead,
    open && left === 0,
    state.ticks?.claims === true,
    state.ticks?.criteria === true,
    open && drafts === 0 && (comments > 0 || sent),
    sent && listed.length === 0,
  ];
  // With the review's stages, a step runs while a stage producing it runs
  // and waits while one has yet to start; without them, while its results are missing.
  const stages = reviewing && open ? result.stages : undefined;
  const stepStages = (index: number) => (stages ?? []).filter((stage) => STEP_STAGES[index]!.includes(stage.id));
  const running =
    stages === undefined
      ? [
          false,
          reviewing && !open,
          reviewing && open && result.story === undefined,
          false,
          reviewing && open && result.claims?.judging === undefined,
          reviewing && open && result.criteria === undefined,
          false,
          false,
        ]
      : TITLES.map((_, index) => stepStages(index).some((stage) => stage.state === 'running'));
  const waiting = TITLES.map((_, index) => !running[index] && stepStages(index).some((stage) => stage.state === 'to come'));
  const summaries = [
    setupLine(state.settings),
    open ? pullRequestLine(result) : running[1] ? 'reading the pull request…' : state.pullRequests?.list.state === 'listed' ? `${listedCount(state.pullRequests)} open` : '',
    !open ? '' : state.storyRead ? 'read' : result.story === undefined ? (running[2] ? 'being written…' : waiting[2] ? 'to be written' : 'in the overview') : 'ready',
    !open ? '' : left === 0 ? 'every part reviewed' : `${left} of ${result.parts.length} left`,
    !open ? '' : claimsSummary(result),
    !open ? '' : criteriaSummary(result),
    [comments === 0 ? '' : `${comments} pending`, drafts === 0 ? '' : `${drafts} draft${drafts === 1 ? '' : 's'}`].filter((part) => part !== '').join(' · '),
    sent && listed.length === 0 ? 'sent' : comments === 0 ? '' : `${comments} comment${comments === 1 ? '' : 's'} ready`,
  ];
  const current = done.indexOf(false);
  return TITLES.map((title, index) => ({
    number: index + 1,
    title,
    state: done[index] ? 'done' : running[index] ? 'running' : waiting[index] ? 'waiting' : index === current ? 'current' : 'to come',
    open: index === current,
    summary: summaries[index]!,
  }));
}

/** The pull request shown, as `owner/repo #number`. */
export function pullRequestLine(result: ReviewResult): string {
  const ref = parsePullRequestUrl(result.pullRequest.url);
  return ref === null ? `#${result.pullRequest.number}` : `${ref.owner}/${ref.repo} #${result.pullRequest.number}`;
}

/**
 * Step 5’s summary: the claims’ verdicts once judged, findings first —
 * an unverifiable claim counted only when it is a finding — then how
 * many the code cannot settle, listed quietly; else how many are listed.
 */
function claimsSummary(result: ReviewResult): string {
  const claims = result.claims?.claims ?? [];
  const judged = claims.filter((claim) => claim.verdict.kind !== 'not checked');
  if (judged.length === 0) return claims.length === 0 ? '' : `${claims.length} listed`;
  const counted = judged.filter((claim) => claim.verdict.kind === 'verified' || isFinding(claim));
  const quiet = judged.length - counted.length;
  const counts: [string, number][] = (['refuted', 'unverifiable', 'verified'] as const).map((kind) => [kind, counted.filter((claim) => claim.verdict.kind === kind).length]);
  counts.push(['the code cannot settle', quiet]);
  return counts
    .filter(([, count]) => count > 0)
    .map(([label, count]) => `${count} ${label}`)
    .join(' · ');
}

/** Step 6’s summary: the criteria’s verdicts once mapped, findings first, with the unexplained changes counted, else how many criteria. */
function criteriaSummary(result: ReviewResult): string {
  const criteria = result.criteria?.criteria ?? [];
  const mapped = criteria.filter((criterion) => criterion.verdict.kind !== 'not checked');
  const unexplained = result.unexplained?.outcome === 'compared' ? result.unexplained.parts.length + result.unexplained.described.length : 0;
  if (mapped.length === 0) {
    if (criteria.length === 0) return unexplained === 0 ? '' : `${unexplained} unexplained`;
    return `${criteria.length} criteria${unexplained > 0 ? ` · ${unexplained} unexplained` : ''}`;
  }
  const parts = CRITERION_VERDICT_KINDS.map((kind) => ({ kind, count: mapped.filter((criterion) => criterion.verdict.kind === kind).length }))
    .filter(({ count }) => count > 0)
    .map(({ kind, count }) => `${count} ${kind}`);
  if (unexplained > 0) parts.push(`${unexplained} unexplained`);
  return parts.join(' · ');
}

/** The part Open next part opens: the first in reading order the reviewer has not marked reviewed. */
export function nextPartToReview(result: ReviewResult, marks: ReviewedMarks): Part | undefined {
  return partsInReadingOrder(result).find((part) => reviewedState(part, marks) !== 'reviewed');
}
