import { parsePullRequestUrl, partsLeft, reviewedState, type AgentName, type Part, type ReviewedMarks, type ReviewResult } from '@second-look/engine';
import type { AgentSettings } from '../agent-settings.js';
import { partsInReadingOrder, type TreeSection } from '../tree.js';

/** Where one step of the review path stands. */
export type StepState = 'done' | 'current' | 'running' | 'to come';

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

/** The setup line: the agent, the model and the effort every agent pass runs on. */
export function setupLine(settings: AgentSettings): string {
  const model = settings.model === '' ? 'default model' : settings.model;
  const effort = settings.effort === '' ? 'default effort' : `effort ${settings.effort}`;
  return `${AGENT_NAMES[settings.agent]} · ${model} · ${effort}`;
}

/**
 * The eight steps of the review path (ADR 0008), each with its state: done
 * where it can be measured — the settings always choose an agent, a review
 * is open, the story was read, every part is reviewed — running while its
 * results are still arriving, and otherwise current or still to come. The
 * current step is the first one not done; its card is open and the others
 * fold. Steps 5 to 8 are never done yet: their cards point to the overview,
 * the diff's threads and the Send review page.
 */
export function sideBarSteps(state: SideBarState): Step[] {
  const { result, reviewing } = state;
  const open = result !== undefined;
  const left = open ? partsLeft(result.parts, state.marks) : 0;
  const comments = state.sections.flatMap((section) => section.parts).filter((node) => node.kind === 'comment').length;
  const done = [true, open, open && state.storyRead, open && left === 0, false, false, false, false];
  const running = [
    false,
    reviewing && !open,
    reviewing && open && result.story === undefined,
    false,
    reviewing && open && result.claims?.judging === undefined,
    reviewing && open && result.criteria === undefined,
    false,
    false,
  ];
  const summaries = [
    setupLine(state.settings),
    open ? pullRequestLine(result) : running[1] ? 'reading the pull request…' : '',
    !open ? '' : state.storyRead ? 'read' : result.story === undefined ? (running[2] ? 'being written…' : 'in the overview') : 'ready',
    !open ? '' : left === 0 ? 'every part reviewed' : `${left} of ${result.parts.length} left`,
    !open || result.claims === undefined ? '' : `${result.claims.claims.length} listed`,
    !open || result.criteria === undefined ? '' : `${result.criteria.criteria.length} criteria`,
    comments === 0 ? '' : `${comments} pending`,
    '',
  ];
  const current = done.indexOf(false);
  return TITLES.map((title, index) => ({
    number: index + 1,
    title,
    state: done[index] ? 'done' : running[index] ? 'running' : index === current ? 'current' : 'to come',
    open: index === current,
    summary: summaries[index]!,
  }));
}

/** The pull request shown, as `owner/repo #number`. */
export function pullRequestLine(result: ReviewResult): string {
  const ref = parsePullRequestUrl(result.pullRequest.url);
  return ref === null ? `#${result.pullRequest.number}` : `${ref.owner}/${ref.repo} #${result.pullRequest.number}`;
}

/** The part Open next part opens: the first in reading order the reviewer has not marked reviewed. */
export function nextPartToReview(result: ReviewResult, marks: ReviewedMarks): Part | undefined {
  return partsInReadingOrder(result).find((part) => reviewedState(part, marks) !== 'reviewed');
}
