import { randomBytes } from 'node:crypto';
import {
  DEFAULT_AGENT_SETTINGS,
  runAgentTasks,
  type AgentAdapter,
  type AgentSettings,
} from './agent.js';
import type { JsonSchema } from './json-schema.js';
import { filesOfPart } from './parts.js';
import { IMPORTANCE_ORDER, type AgentRanking, type Importance, type Part } from './protocol.js';
import { mustReviewPlaces, signalFacts, sinksPart, type SignalFact } from './rank.js';
import { UNTRUSTED_INPUT_RULE, untrustedBlock } from './untrusted.js';

/**
 * The agent ranking pass: the agent gives each part its importance with a
 * one-line reason citing the plain signals it used, and the engine checks
 * the answer before showing any. The ranking prompt is versioned like
 * code and lands with its evaluation cases (ADR 0006); bump
 * {@link RANKING_PROMPT_VERSION}, and its entry in the evaluation's
 * `prompts.json`, whenever the instructions, the prompt or the schema
 * change.
 */

/** The ranking prompt's id in the evaluation's prompt registry. */
export const RANKING_PROMPT_ID = 'ranking';

/** The ranking prompt's version. */
export const RANKING_PROMPT_VERSION = '1';

/** An agent and model whose ranking the evaluation scored at or above the plain ranking. */
export interface TestedRanking {
  agent: string;
  /** `provider/model`, as the agent's stamp reports it. */
  model: string;
}

/**
 * Where the agent ranking is the default: the agents and models whose
 * ranking prompt matched or beat the plain ranking's rank position of the
 * known important parts over the prompt's evaluation cases. Elsewhere the
 * plain ranking stays. The evaluation's README records each run behind
 * this list.
 */
export const TESTED_RANKINGS: readonly TestedRanking[] = [
  // Ranking prompt v1 with Pi 0.86.1 at its default effort: rank median 1
  // and top-3 share 0.9 over seven cases, against 2 and 0.8 plain.
  { agent: 'pi', model: 'zai-coding-cn/glm-5.3' },
];

/** How many lines of a part the prompt shows; the agent can read the rest. */
const SHOWN_LINES = 30;

/** The longest reason the companion shows. */
const MAX_REASON_LENGTH = 160;

/** The length the prompt asks reasons to stay under, leaving room below the limit. */
const SHORT_REASON_LENGTH = 100;

/** The answer the ranking prompt asks for. */
export const RANKING_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['parts'],
  properties: {
    parts: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['part', 'importance', 'reason', 'signals'],
        properties: {
          part: { type: 'string' },
          importance: { type: 'string', enum: IMPORTANCE_ORDER },
          reason: { type: 'string' },
          signals: { type: 'array', items: { type: 'string' } },
        },
      },
    },
  },
};

/** An answer that met {@link RANKING_SCHEMA}. */
export interface RankingAnswer {
  parts: { part: string; importance: Importance; reason: string; signals: string[] }[];
}

/** The ranking prompt's system prompt: the agent's setting, the rules and the answer's schema. */
export const RANKING_INSTRUCTIONS = [
  'You are the agent of Second Look, a companion that helps a human review a pull request.',
  "Your current folder is a read-only copy of the pull request's head version. You can only use",
  'file-reading tools on it: you have no shell and no network.',
  UNTRUSTED_INPUT_RULE,
  'Your task is to rank the parts of the change for review. A part is a named group of related',
  'edits. Give each part one importance:',
  '- "must review": the reviewer must read it closely, because a mistake there would change',
  '  behaviour that other code or users rely on.',
  '- "worth reviewing": worth a careful read, but less likely to hide a serious mistake.',
  '- "context": background to the change, such as wording, docs, formatting, or a test that',
  '  only follows a change made elsewhere.',
  'Rules:',
  '- Rank every part id you are given exactly once. Never repeat an id, never invent one.',
  '- List the parts in the order the reviewer should read them, most important first.',
  '- Keep "must review" for the few parts that matter most; the task says how many at most.',
  '- A change to logic in code, such as a condition, a comparison, a calculation or a returned',
  '  value, matters more than its size: a one-line change of logic can be "must review" while a',
  '  long change of wording is "context".',
  `- Give each part a one-line reason saying why it has its importance, under ${SHORT_REASON_LENGTH}`,
  `  characters and never over ${MAX_REASON_LENGTH}.`,
  '- Each part lists its plain signals by key, such as "size" or "role". In "signals", cite the',
  '  keys of the signals your reason uses: at least one, and only keys listed for that part.',
  '- Read a file with your tools only when the lines shown do not tell you what a part does.',
  'Answer with only one JSON value and no other text, matching this JSON schema:',
  JSON.stringify(RANKING_SCHEMA),
].join('\n');

/** One part the agent is asked to rank, with the plain signals it may cite. */
export interface RankingItem {
  /** The id the prompt gives it, such as `p3`. */
  id: string;
  part: Part;
  facts: SignalFact[];
}

/**
 * The parts the agent is asked to rank, in the plain ranking's order:
 * every part but the sinking noise, which keeps its plain rank and never
 * reaches the agent.
 */
export function rankingItems(parts: readonly Part[]): RankingItem[] {
  return parts
    .filter((part) => !sinksPart(part))
    .map((part, index) => ({ id: `p${index + 1}`, part, facts: signalFacts(part) }));
}

/** A part's first lines, hunk by hunk across its files, up to {@link SHOWN_LINES}. */
function shownLines(part: Part): string[] {
  const prefix = { context: ' ', addition: '+', deletion: '-' } as const;
  const shown: string[] = [];
  let hidden = 0;
  for (const file of filesOfPart(part)) {
    shown.push(`${JSON.stringify(file.path)} (${file.changeKind}${file.isBinary ? ', binary' : ''})`);
    for (const hunk of file.hunks) {
      const room = SHOWN_LINES - shown.length;
      if (room <= 1) {
        hidden += hunk.lines.length;
        continue;
      }
      shown.push(`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`);
      const lines = hunk.lines.map((line) => `${prefix[line.kind]}${line.text}`);
      shown.push(...lines.slice(0, room - 1));
      hidden += Math.max(0, lines.length - (room - 1));
    }
  }
  if (hidden > 0) shown.push(`… ${hidden} more lines; read the files for the rest`);
  return shown;
}

/** One part as the prompt shows it: its id and signal keys outside the untrusted block; its name, signals and lines inside it. */
function describeItem(item: RankingItem, blockId: string): string {
  const facts = item.facts.map((fact) => `${fact.key}: ${fact.phrase}`);
  return [
    `[${item.id}] signals: ${item.facts.map((fact) => fact.key).join(', ')}`,
    untrustedBlock(`part ${item.id}`, [`name: ${item.part.name ?? item.part.path}`, ...facts, ...shownLines(item.part)].join('\n'), blockId),
  ].join('\n');
}

/** The ranking task: the pull request's own text and the parts, all marked as untrusted. */
export function rankingPrompt(
  items: readonly RankingItem[],
  pullRequest: { title: string; description: string },
  blockId?: string,
): string {
  const id = blockId ?? randomBytes(8).toString('hex');
  return [
    'The pull request under review:',
    untrustedBlock('pull request title', pullRequest.title, id),
    untrustedBlock('pull request description', pullRequest.description, id),
    '',
    `Rank these ${items.length} parts; at most ${mustReviewPlaces(items.length)} may be "must review".`,
    'Each has its id and its signal keys; its name, its signals and its first lines follow as',
    'untrusted text.',
    '',
    ...items.map((item) => describeItem(item, id)),
  ].join('\n');
}

/** A reason as the companion shows it: on one line, its runs of white space as one space. */
function oneLine(reason: string): string {
  return reason.replace(/\s+/g, ' ').trim();
}

/**
 * The validator: checks an answer against the offered parts. Every
 * offered part is ranked exactly once, each with a reason that cites at
 * least one signal and only that part's own signals, and no more than a
 * third of the parts (rounded up) are must review. Returns the problems;
 * an empty list means the answer is usable.
 */
export function rankingProblems(items: readonly RankingItem[], answer: RankingAnswer): string[] {
  const offered = new Map(items.map((item) => [item.id, item]));
  const ranked = new Set<string>();
  const problems: string[] = [];
  answer.parts.forEach((entry, index) => {
    const item = offered.get(entry.part);
    if (!item) {
      problems.push(`entry ${index + 1} ranks ${JSON.stringify(entry.part)}, which was not offered`);
      return;
    }
    if (ranked.has(entry.part)) problems.push(`part ${entry.part} is ranked more than once`);
    ranked.add(entry.part);
    const reason = oneLine(entry.reason);
    if (reason === '') problems.push(`part ${entry.part} has no reason`);
    if (reason.length > MAX_REASON_LENGTH) problems.push(`part ${entry.part}'s reason is over ${MAX_REASON_LENGTH} characters`);
    if (entry.signals.length === 0) problems.push(`part ${entry.part}'s reason cites no signal`);
    const keys = new Set<string>(item.facts.map((fact) => fact.key));
    for (const signal of entry.signals) {
      if (!keys.has(signal)) problems.push(`part ${entry.part} cites ${JSON.stringify(signal)}, which is not one of its signals`);
    }
  });
  for (const item of items) {
    if (!ranked.has(item.id)) problems.push(`part ${item.id} is not ranked`);
  }
  const mustReview = answer.parts.filter((entry) => entry.importance === 'must review').length;
  const places = mustReviewPlaces(items.length);
  if (mustReview > places) {
    problems.push(`${mustReview} parts are must review; at most ${places} of the ${items.length} parts may be`);
  }
  return problems;
}

/**
 * Turns a checked answer into ranked parts: must review, worth reviewing,
 * then context, each level in the agent's reading order, every reason on
 * one line with the phrases of the signals it cites; then the sinking
 * noise parts, which keep their plain rank, in their own order.
 */
export function partsFromRanking(
  items: readonly RankingItem[],
  answer: RankingAnswer,
  noise: readonly Part[],
): Part[] {
  const byId = new Map(items.map((item) => [item.id, item]));
  const ranked = answer.parts
    .map((entry, index) => ({ entry, index }))
    .sort(
      (a, b) =>
        IMPORTANCE_ORDER.indexOf(a.entry.importance) - IMPORTANCE_ORDER.indexOf(b.entry.importance) ||
        a.index - b.index,
    )
    .map(({ entry }) => {
      const item = byId.get(entry.part)!;
      const phrases = new Map(item.facts.map((fact) => [fact.key as string, fact.phrase]));
      const signals = [...new Set(entry.signals)].map((key) => phrases.get(key)!);
      return { ...item.part, rank: { importance: entry.importance, reason: oneLine(entry.reason), signals } };
    });
  return [...ranked, ...noise];
}

export interface AgentRankingOptions {
  adapter: AgentAdapter;
  settings?: AgentSettings;
  /** The read-only head copy the agent works in. */
  root: string;
  pullRequest: { title: string; description: string };
}

/** What the agent ranking pass produced: its ranked parts, or none when the plain ranking stays. */
export interface AgentRankingResult {
  /** The parts in the agent's ranking, the sinking noise last; absent on a fallback. */
  parts?: Part[];
  ranking: AgentRanking;
}

/**
 * Asks the agent to rank plainly ranked parts, and checks its answer with
 * {@link rankingProblems}. A rejected answer is retried once and then
 * reported, and the plain ranking stays. The sinking noise keeps its
 * plain rank and stays last.
 */
export async function rankWithAgent(
  parts: readonly Part[],
  options: AgentRankingOptions,
): Promise<AgentRankingResult> {
  const items = rankingItems(parts);
  const { results } = await runAgentTasks(
    options.adapter,
    [
      {
        root: options.root,
        instructions: RANKING_INSTRUCTIONS,
        prompt: rankingPrompt(items, options.pullRequest),
        schema: RANKING_SCHEMA,
        check: (answer) => rankingProblems(items, answer as RankingAnswer),
      },
    ],
    options.settings ?? DEFAULT_AGENT_SETTINGS,
  );
  const result = results[0]!;
  const base = { promptVersion: RANKING_PROMPT_VERSION, stamp: result.stamp };
  if (!result.ok) {
    const detail = `the agent gave no usable answer (${result.reason}: ${result.message})`;
    return { ranking: { ...base, outcome: 'fell back', detail } };
  }
  const noise = parts.filter(sinksPart);
  const detail = `the validator accepted the ranking of ${items.length} parts, each reason citing its signals`;
  return {
    parts: partsFromRanking(items, result.answer as RankingAnswer, noise),
    ranking: { ...base, outcome: 'ranked', detail },
  };
}

/** Whether the agent ranking is the default for this agent and model. */
export function isTestedRanking(tested: readonly TestedRanking[], agent: string, model: string | null): boolean {
  return tested.some((entry) => entry.agent === agent && entry.model === model);
}

/**
 * Whether the agent ranking could be the default before the agent runs:
 * the agent has a tested model, and the model asked for, when one is, is
 * among them. With no model asked for, only the run's stamp tells.
 */
export function mayBeTestedRanking(tested: readonly TestedRanking[], agent: string, model?: string): boolean {
  return tested.some((entry) => entry.agent === agent && (model === undefined || entry.model === model));
}

/** Why the plain ranking stays for an agent and model the evaluation has not tested. */
export function notTestedDetail(agent: string, model: string | null | undefined): string {
  const who = model ? `${agent} with ${model}` : agent;
  return `the agent ranking is the default only where its evaluation matched or beat the plain ranking, and ${who} has none`;
}
