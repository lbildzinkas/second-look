import { randomBytes } from 'node:crypto';
import {
  DEFAULT_AGENT_SETTINGS,
  runAgentTasks,
  type AgentAdapter,
  type AgentSettings,
} from './agent.js';
import { claimItems, quotedLine, type ClaimItem } from './claims.js';
import type { JsonSchema } from './json-schema.js';
import { filesOfPart } from './parts.js';
import type { DescribedChange, LinkedIssue, Part, UnexplainedChanges, UnexplainedPart } from './protocol.js';
import { sinksPart } from './rank.js';
import { UNTRUSTED_INPUT_RULE, untrustedBlock } from './untrusted.js';

/**
 * The unexplained-changes pass: the agent compares the pull request's
 * description and linked issues with the change in both directions —
 * the parts neither explains, each with a one-line reason, and the
 * statements describing changes the diff does not contain, each quoted
 * from where it is made — and the engine checks every part id and quote
 * before showing any. The prompt is versioned like code and lands with
 * its evaluation cases (ADR 0006); bump
 * {@link UNEXPLAINED_PROMPT_VERSION}, and its entry in the evaluation's
 * `prompts.json`, whenever the instructions, the prompt or the schema
 * change.
 */

/** The unexplained-changes prompt's id in the evaluation's prompt registry. */
export const UNEXPLAINED_PROMPT_ID = 'unexplained';

/** The unexplained-changes prompt's version. */
export const UNEXPLAINED_PROMPT_VERSION = '1';

/** The longest reason the companion shows. */
const MAX_REASON_LENGTH = 200;

/** The longest quote of a described change the companion shows. */
const MAX_QUOTE_LENGTH = 500;

/** The most described changes one answer may list. */
const MAX_DESCRIBED = 20;

/** How many changed lines of a part the prompt shows; the agent can read the rest. */
const SHOWN_LINES = 60;

/** The answer the unexplained-changes prompt asks for. */
export const UNEXPLAINED_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['unexplained', 'described'],
  properties: {
    unexplained: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['part', 'reason'],
        properties: { part: { type: 'string' }, reason: { type: 'string' } },
      },
    },
    described: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['source', 'quote', 'reason'],
        properties: { source: { type: 'string' }, quote: { type: 'string' }, reason: { type: 'string' } },
      },
    },
  },
};

/** An answer that met {@link UNEXPLAINED_SCHEMA}. */
export interface UnexplainedAnswer {
  /** The parts neither source explains, each by its id. */
  unexplained: { part: string; reason: string }[];
  /** The described changes, each by its source: `description`, or a linked issue's id such as `i1`. */
  described: { source: string; quote: string; reason: string }[];
}

/** The unexplained-changes prompt's system prompt: the agent's setting, the rules and the answer's schema. */
export const UNEXPLAINED_INSTRUCTIONS = [
  'You are the agent of Second Look, a companion that helps a human review a pull request.',
  "Your current folder is a read-only copy of the pull request's head version. You can only use",
  'file-reading tools on it: you have no shell and no network.',
  UNTRUSTED_INPUT_RULE,
  "Your task is to compare what the pull request's description and its linked issues say the change",
  'does with what the change does, in both directions.',
  '1. unexplained: the parts that neither the description nor a linked issue explains. A part is',
  '   explained when they say the change does it, or when it plainly serves what they describe: a',
  '   test or a documentation or changelog entry for it, or a caller, type or rename that the',
  '   described change needs. A part is unexplained when nothing they say covers it, such as an',
  '   unrelated refactor, rename or reformatting, or a fix, feature, dependency or setting they never',
  '   mention. Give each one a reason, one line under 200 characters, saying what the part changes that',
  '   nothing explains. Never list a noise part.',
  '2. described: the statements in the description or a linked issue that describe a change the diff',
  '   does not contain, such as a promised test, document or behaviour that no part makes. Quote',
  '   each exactly as its source writes it, leaving out the > markers that start quoted lines; quote',
  '   only the words that describe the change, usually one sentence. Give its source, description or',
  "   the issue's id, and a reason, one line under 200 characters, saying what the diff lacks.",
  '   Not a described change: the motivation, background, steps to reproduce, a question, a link,',
  '   or a statement the change does fulfil.',
  'Rules:',
  '- Judge only whether the change is there, never whether its code is right.',
  '- List nothing in a direction when nothing is unexplained in it.',
  '- Read a file with your tools only when the lines shown for a part are cut short.',
  'Answer with only one JSON value and no other text, no words before or after it, matching this',
  'JSON schema:',
  JSON.stringify(UNEXPLAINED_SCHEMA),
].join('\n');

/** A linked issue as the prompt offers it: its id, such as `i1`, and its index in the criteria's issues. */
export interface IssueItem {
  id: string;
  index: number;
  issue: LinkedIssue;
}

/** The linked issues as the prompt offers them, numbered in the criteria's order. */
export function issueItems(issues: readonly LinkedIssue[]): IssueItem[] {
  return issues.map((issue, index) => ({ id: `i${index + 1}`, index, issue }));
}

/** A part's changed lines, each after its side's line number, up to {@link SHOWN_LINES} across its files. */
function partDiff(part: Part): string[] {
  const shown: string[] = [];
  let count = 0;
  for (const file of filesOfPart(part)) {
    shown.push(`${JSON.stringify(file.path)} (${file.changeKind}, +${file.additions} -${file.deletions})`);
    for (const line of file.hunks.flatMap((hunk) => hunk.lines)) {
      if (line.kind === 'context' || count++ >= SHOWN_LINES) continue;
      shown.push(line.kind === 'addition' ? `+${line.newLineNumber}: ${line.text}` : `-${line.oldLineNumber}: ${line.text}`);
    }
  }
  if (count > SHOWN_LINES) shown.push(`… ${count - SHOWN_LINES} more changed lines; read the files for the rest`);
  return shown;
}

/** One part as the prompt shows it: its id outside the untrusted block; its name and changed lines inside it. */
function describePart(item: ClaimItem, blockId: string): string {
  const name = `name: ${item.part.name ?? item.part.path}`;
  if (sinksPart(item.part)) return [`[${item.id}] noise`, untrustedBlock(`part ${item.id}`, `${name}\n(its lines are not shown)`, blockId)].join('\n');
  return [`[${item.id}]`, untrustedBlock(`part ${item.id}`, [name, ...partDiff(item.part)].join('\n'), blockId)].join('\n');
}

/** One linked issue as the prompt shows it: its id and link outside the untrusted block; its title and body inside it. */
function describeIssue(item: IssueItem, blockId: string): string {
  const { issue } = item;
  return [
    `[${item.id}] #${issue.number} in ${issue.repository}, which the pull request ${issue.link === 'closes' ? 'closes' : 'references'}`,
    untrustedBlock(`issue ${item.id} title`, issue.title, blockId),
    untrustedBlock(`issue ${item.id} body`, issue.body, blockId),
  ].join('\n');
}

/** The task: the description, the linked issues and the parts' changed lines, all marked as untrusted. */
export function unexplainedPrompt(
  items: readonly ClaimItem[],
  pullRequest: { title: string; description: string },
  issues: readonly IssueItem[],
  blockId?: string,
): string {
  const id = blockId ?? randomBytes(8).toString('hex');
  const issueLines =
    issues.length > 0
      ? [`The ${issues.length === 1 ? 'issue' : `${issues.length} issues`} the pull request links, each with its id:`, ...issues.map((issue) => describeIssue(issue, id))]
      : ['The pull request links no issue that was read, so compare the change with the description alone.'];
  return [
    'The pull request under review:',
    untrustedBlock('pull request title', pullRequest.title, id),
    untrustedBlock('pull request description', pullRequest.description, id),
    '',
    ...issueLines,
    '',
    `Compare them with these ${items.length} parts of the change. Each has its id; its name and the lines`,
    'it changes, each after its side’s line number (+ added, - removed), follow as untrusted text.',
    '',
    ...items.map((item) => describePart(item, id)),
  ].join('\n');
}

/** What an answer is checked against: the parts, the description and the linked issues offered. */
export interface UnexplainedContext {
  items: ClaimItem[];
  description: string;
  issues: IssueItem[];
}

/** A reason's problem, naming the entry; undefined for a reason the companion can show. */
function reasonProblem(reason: string, name: string): string | undefined {
  if (reason.trim() === '') return `${name} gives no reason`;
  if (/[\r\n]/.test(reason.trim())) return `${name}'s reason is not one line`;
  return reason.trim().length > MAX_REASON_LENGTH ? `${name}'s reason is over ${MAX_REASON_LENGTH} characters` : undefined;
}

/** Text on one line: runs of white space as one space. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * Checks one described change against its source and locates it, or
 * says what is wrong with it, naming it by its place in the answer.
 */
function locateDescribed(
  description: string,
  issues: ReadonlyMap<string, IssueItem>,
  entry: UnexplainedAnswer['described'][number],
  name: string,
): DescribedChange | string {
  const issue = issues.get(entry.source);
  if (entry.source !== 'description' && issue === undefined) {
    return `${name} names ${JSON.stringify(entry.source)}, which is neither the description nor an issue id`;
  }
  const quote = oneLine(entry.quote);
  if (quote === '') return `${name} has an empty quote`;
  if (quote.length > MAX_QUOTE_LENGTH) return `${name}'s quote is over ${MAX_QUOTE_LENGTH} characters`;
  const line = quotedLine(issue === undefined ? description : issue.issue.body, entry.quote);
  if (line === undefined) return `${name}'s quote is not in ${issue === undefined ? 'the description' : `issue ${issue.id}`}`;
  const problem = reasonProblem(entry.reason, name);
  if (problem !== undefined) return problem;
  const location: DescribedChange['location'] = issue === undefined ? { kind: 'description', line } : { kind: 'issue', issue: issue.index, line };
  return { quote, location, reason: oneLine(entry.reason) };
}

/**
 * Checks an answer against the parts and sources offered: each
 * unexplained part must be an offered part that is not noise, listed
 * once, with a one-line reason; each described change must quote the
 * description or an offered issue as written, with a one-line reason.
 * The engine, not the agent, sets where each quote sits. Returns the
 * unexplained parts in the parts' order and the described changes in
 * the answer's order, each place once, or the problems and neither.
 */
export function checkUnexplained(
  context: UnexplainedContext,
  answer: UnexplainedAnswer,
): { parts: UnexplainedPart[]; described: DescribedChange[]; problems: string[] } {
  const problems: string[] = [];
  const byId = new Map(context.items.map((item) => [item.id, item]));
  const parts = new Map<number, UnexplainedPart>();
  answer.unexplained.forEach((entry, index) => {
    const name = `unexplained part ${index + 1}`;
    const item = byId.get(entry.part);
    const problem =
      item === undefined
        ? `${name} names ${JSON.stringify(entry.part)}, which is not a part id`
        : sinksPart(item.part)
          ? `${name} names ${entry.part}, which is noise`
          : parts.has(item.index)
            ? `${name} lists ${entry.part} again`
            : reasonProblem(entry.reason, name);
    if (problem !== undefined) problems.push(problem);
    else parts.set(item!.index, { part: item!.index, reason: oneLine(entry.reason) });
  });
  if (answer.described.length > MAX_DESCRIBED) problems.push(`the answer lists ${answer.described.length} described changes; at most ${MAX_DESCRIBED} are allowed`);
  const issues = new Map(context.issues.map((item) => [item.id, item]));
  const described = new Map<string, DescribedChange>();
  answer.described.forEach((entry, index) => {
    const outcome = locateDescribed(context.description, issues, entry, `described change ${index + 1}`);
    if (typeof outcome === 'string') problems.push(outcome);
    else described.set(JSON.stringify([outcome.location, outcome.quote]), outcome);
  });
  if (problems.length > 0) return { parts: [], described: [], problems };
  return { parts: [...parts.values()].sort((a, b) => a.part - b.part), described: [...described.values()], problems };
}

/** Each part's unexplained reason, by the part's index; undefined for a part the comparison does not flag. */
export function unexplainedReasons(unexplained: UnexplainedChanges | undefined, partCount: number): (string | undefined)[] {
  const reasons = new Array<string | undefined>(partCount).fill(undefined);
  for (const { part, reason } of unexplained?.parts ?? []) {
    if (part >= 0 && part < partCount) reasons[part] = reason;
  }
  return reasons;
}

export interface UnexplainedOptions {
  adapter: AgentAdapter;
  settings?: AgentSettings;
  /** The read-only head copy the agent works in. */
  root: string;
  pullRequest: { title: string; description: string };
  /** The linked issues read; none when the review read none. */
  issues: readonly LinkedIssue[];
  /** Why no linked issue was read, when none could be: the review read none, or GitHub refused. */
  issuesDetail?: string;
}

/** What the change is compared with, in words. */
function comparedWith(description: string, issues: readonly LinkedIssue[]): string {
  const sources = [
    ...(description.trim() === '' ? [] : ['the description']),
    ...(issues.length === 0 ? [] : [`${issues.length} linked issue${issues.length === 1 ? '' : 's'}`]),
  ];
  return sources.join(' and ');
}

/**
 * Asks the agent to compare the description and the linked issues with
 * the parts shown, and checks every part id and quote. With neither a
 * description nor a linked issue there is nothing to compare with, so no
 * agent is asked. A rejected answer is retried once and then reported,
 * and nothing is shown as unexplained.
 */
export async function findUnexplained(parts: readonly Part[], options: UnexplainedOptions): Promise<UnexplainedChanges> {
  const base = { promptVersion: UNEXPLAINED_PROMPT_VERSION, parts: [], described: [] };
  const sources = comparedWith(options.pullRequest.description, options.issues);
  const issuesNote = options.issuesDetail === undefined ? '' : ` (${options.issuesDetail})`;
  if (sources === '') {
    const detail = `the pull request has no description and no linked issue was read${issuesNote}, so there is nothing to compare the change with`;
    return { ...base, outcome: 'not compared', detail };
  }
  const items = claimItems(parts);
  const context: UnexplainedContext = { items, description: options.pullRequest.description, issues: issueItems(options.issues) };
  const { results } = await runAgentTasks(
    options.adapter,
    [
      {
        root: options.root,
        instructions: UNEXPLAINED_INSTRUCTIONS,
        prompt: unexplainedPrompt(items, options.pullRequest, context.issues),
        schema: UNEXPLAINED_SCHEMA,
        check: (value) => checkUnexplained(context, value as UnexplainedAnswer).problems,
      },
    ],
    options.settings ?? DEFAULT_AGENT_SETTINGS,
  );
  const result = results[0]!;
  if (!result.ok) {
    const detail = `the agent gave no usable answer (${result.reason}: ${result.message})`;
    return { ...base, outcome: 'fell back', detail, stamp: result.stamp };
  }
  const checked = checkUnexplained(context, result.answer as UnexplainedAnswer);
  const detail = `compared with ${sources}${issuesNote}; every part id was offered and every quote was found in its source`;
  return { ...base, outcome: 'compared', detail, stamp: result.stamp, parts: checked.parts, described: checked.described };
}
