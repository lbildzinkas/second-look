import { randomBytes } from 'node:crypto';
import {
  DEFAULT_AGENT_SETTINGS,
  runAgentTasks,
  type AgentAdapter,
  type AgentSettings,
} from './agent.js';
import type { JsonSchema } from './json-schema.js';
import { sinks } from './noise.js';
import { fileSlice, groupParts } from './parts.js';
import type { AgentGrouping, Hunk, Part, FileSlice } from './protocol.js';
import { UNTRUSTED_INPUT_RULE, untrustedBlock } from './untrusted.js';

/**
 * The agent grouping pass: the agent proposes parts — groups of related
 * hunks across files, such as a function, its caller and its test — and
 * the engine checks them before showing any. The grouping prompt is
 * versioned like code and lands with its evaluation cases (ADR 0006); bump
 * {@link GROUPING_PROMPT_VERSION}, and its entry in the evaluation's
 * `prompts.json`, whenever the instructions, the prompt or the schema
 * change.
 */

/** The grouping prompt's id in the evaluation's prompt registry. */
export const GROUPING_PROMPT_ID = 'grouping';

/** The grouping prompt's version. */
export const GROUPING_PROMPT_VERSION = '2';

/** The name and origin of the part that holds the hunks the agent left out. */
export const NOT_GROUPED_BY_AGENT = 'not grouped by the agent';

/** How many lines of a hunk the prompt shows; the agent can read the rest. */
const SHOWN_LINES = 40;

/** The longest part name the companion shows. */
const MAX_NAME_LENGTH = 120;

/** The length the prompt asks names to stay under, leaving room below the limit. */
const SHORT_NAME_LENGTH = 80;

/** The answer the grouping prompt asks for. */
export const GROUPING_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['parts'],
  properties: {
    parts: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'hunks'],
        properties: {
          name: { type: 'string' },
          hunks: { type: 'array', items: { type: 'string' } },
        },
      },
    },
  },
};

/** An answer that met {@link GROUPING_SCHEMA}. */
export interface GroupingAnswer {
  parts: { name: string; hunks: string[] }[];
}

/** The grouping prompt's system prompt: the agent's setting, the rules and the answer's schema. */
export const GROUPING_INSTRUCTIONS = [
  'You are the agent of Second Look, a companion that helps a human review a pull request.',
  "Your current folder is a read-only copy of the pull request's head version. You can only use",
  'file-reading tools on it: you have no shell and no network.',
  UNTRUSTED_INPUT_RULE,
  'Your task is to group the hunks of the change into parts. A part is a named group of related',
  'edits that a reviewer should read together, even when they are in different files.',
  'Rules:',
  '- Put hunks in one part when they change one behaviour together: a function or type, the code',
  '  that calls or uses it, and the tests that check it; or one name renamed everywhere it is used.',
  '- Keep unrelated edits in separate parts, even within one file. Never put the whole change in',
  '  one part unless every hunk serves one behaviour.',
  '- Every hunk id you are given belongs to exactly one part. Never repeat an id, never invent one.',
  '- Name each part after the entities it touches, using their names from the code, most',
  '  important first, such as "Cart.total and its caller checkout, with their test". Keep a name',
  `  short: under ${SHORT_NAME_LENGTH} characters, and never over ${MAX_NAME_LENGTH}.`,
  '- Read a file with your tools only when the hunks do not show how they relate.',
  'Answer with only one JSON value and no other text, matching this JSON schema:',
  JSON.stringify(GROUPING_SCHEMA),
].join('\n');

/** One change the agent may place in a part: a hunk, or a whole file that has none. */
export interface GroupingItem {
  /** The id the prompt gives it, such as `h3`. */
  id: string;
  /** The file it belongs to, with all of that file's hunks. */
  file: FileSlice;
  /** The hunk; absent for a file without hunks, such as a binary or a pure rename. */
  hunk?: Hunk;
}

/**
 * The changes the agent is asked to group, in diff order: every hunk of
 * every file that does not sink as noise, and each such file without
 * hunks as one change. Sinking noise, such as a lockfile, keeps its plain
 * parts and never reaches the agent.
 */
export function groupingItems(files: readonly FileSlice[]): GroupingItem[] {
  const items: GroupingItem[] = [];
  for (const file of files) {
    if (sinks(file.noise)) continue;
    if (file.hunks.length === 0) items.push({ id: `h${items.length + 1}`, file });
    for (const hunk of file.hunks) items.push({ id: `h${items.length + 1}`, file, hunk });
  }
  return items;
}

/** How a file changed, in the prompt's words. */
function describeFile(file: FileSlice): string {
  const kind =
    file.changeKind === 'rename' || file.changeKind === 'copy'
      ? `${file.changeKind === 'rename' ? 'renamed' : 'copied'} from ${JSON.stringify(file.previousPath ?? '')}`
      : { addition: 'added', deletion: 'deleted', modification: 'modified' }[file.changeKind];
  return `${JSON.stringify(file.path)} (${kind}${file.isBinary ? ', binary' : ''})`;
}

/** One change as the prompt shows it: its id and range outside the untrusted block; its file, the entities it touches and its lines inside it. */
function describeItem(item: GroupingItem, blockId: string): string {
  const { hunk } = item;
  if (!hunk) {
    return [
      `[${item.id}]`,
      untrustedBlock(
        `hunk ${item.id}`,
        `${describeFile(item.file)}: the whole file, with no lines to show`,
        blockId,
      ),
    ].join('\n');
  }
  const entities = hunk.entities.map((entity) => `${entity.kind} ${entity.name} (${entity.change})`);
  const described = [
    describeFile(item.file),
    entities.length > 0 ? `touches ${entities.join(', ')}` : 'touches no named entity',
  ].join(' ');
  const prefix = { context: ' ', addition: '+', deletion: '-' } as const;
  const lines = hunk.lines.slice(0, SHOWN_LINES).map((line) => `${prefix[line.kind]}${line.text}`);
  const hidden = hunk.lines.length - SHOWN_LINES;
  if (hidden > 0) lines.push(`… ${hidden} more lines; read the file for the rest`);
  const range = `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`;
  return [
    `[${item.id}] ${range}`,
    untrustedBlock(`hunk ${item.id}`, [described, ...lines].join('\n'), blockId),
  ].join('\n');
}

/** The grouping task: the pull request's own text and the hunks, all marked as untrusted. */
export function groupingPrompt(
  items: readonly GroupingItem[],
  pullRequest: { title: string; description: string },
  blockId?: string,
): string {
  const id = blockId ?? randomBytes(8).toString('hex');
  return [
    'The pull request under review:',
    untrustedBlock('pull request title', pullRequest.title, id),
    untrustedBlock('pull request description', pullRequest.description, id),
    '',
    `Group these ${items.length} hunks. Each has its id and its range; its file, the entities it`,
    'touches and its lines follow as untrusted text.',
    '',
    ...items.map((item) => describeItem(item, id)),
  ].join('\n');
}

/**
 * Checks an answer against the offered changes: every part needs a name
 * and at least one hunk, and every id must be one that was offered, named
 * once. Returns the problems; an empty list means the answer is usable.
 * Ids the answer leaves out are not a problem here: the coverage rule
 * collects them.
 */
export function groupingProblems(items: readonly GroupingItem[], answer: GroupingAnswer): string[] {
  const offered = new Set(items.map((item) => item.id));
  const placed = new Set<string>();
  const problems: string[] = [];
  answer.parts.forEach((part, index) => {
    const name = part.name.replace(/\s+/g, ' ').trim();
    if (name === '') problems.push(`part ${index + 1} has no name`);
    if (name.length > MAX_NAME_LENGTH) problems.push(`part ${index + 1}'s name is over ${MAX_NAME_LENGTH} characters`);
    if (part.hunks.length === 0) problems.push(`part ${index + 1} has no hunks`);
    for (const id of part.hunks) {
      if (!offered.has(id)) problems.push(`part ${index + 1} names ${JSON.stringify(id)}, which was not offered`);
      else if (placed.has(id)) problems.push(`hunk ${id} is in more than one part`);
      placed.add(id);
    }
  });
  return problems;
}

/** One part made of offered changes, its files in diff order, each holding just its changes. */
function partOfItems(name: string, items: readonly GroupingItem[], origin: Part['origin']): Part {
  const byFile = new Map<FileSlice, Hunk[]>();
  for (const item of items) {
    const hunks = byFile.get(item.file) ?? [];
    if (item.hunk) hunks.push(item.hunk);
    byFile.set(item.file, hunks);
  }
  const [first, ...rest] = [...byFile].map(([file, hunks]) => fileSlice(file, hunks));
  return { ...first!, name, origin, ...(rest.length > 0 ? { otherFiles: rest } : {}) };
}

/**
 * Turns a checked answer into parts, keeping the diff's order: the
 * agent's parts in the order of their first change, then one part marked
 * {@link NOT_GROUPED_BY_AGENT} holding every change the agent left out, so
 * every changed line still belongs to exactly one part.
 */
export function partsFromAnswer(
  items: readonly GroupingItem[],
  answer: GroupingAnswer,
): { parts: Part[]; leftOut: number } {
  const order = new Map(items.map((item, index) => [item.id, index]));
  const byId = new Map(items.map((item) => [item.id, item]));
  const parts = answer.parts
    .map((part) => ({
      name: part.name.replace(/\s+/g, ' ').trim(),
      items: [...part.hunks].sort((a, b) => order.get(a)! - order.get(b)!).map((id) => byId.get(id)!),
    }))
    .sort((a, b) => order.get(a.items[0]!.id)! - order.get(b.items[0]!.id)!)
    .map((part) => partOfItems(part.name, part.items, 'agent'));
  const placed = new Set(answer.parts.flatMap((part) => part.hunks));
  const leftOut = items.filter((item) => !placed.has(item.id));
  if (leftOut.length > 0) parts.push(partOfItems(NOT_GROUPED_BY_AGENT, leftOut, NOT_GROUPED_BY_AGENT));
  return { parts, leftOut: leftOut.length };
}

export interface AgentGroupingOptions {
  adapter: AgentAdapter;
  settings?: AgentSettings;
  /** The read-only head copy the agent works in. */
  root: string;
  pullRequest: { title: string; description: string };
}

/** What the agent grouping pass produced: its parts, or none when the plain grouping stays. */
export interface AgentGroupingResult {
  /** The unranked parts, the sinking noise's plain parts last; absent on a fallback. */
  parts?: Part[];
  grouping: AgentGrouping;
}

/**
 * Asks the agent to group the files' hunks into parts, and checks its
 * answer. An answer that misses the schema or names an id that was not
 * offered, or one id twice, is retried once and then reported, and the
 * plain grouping stays; the hunks a valid answer leaves out go to a part
 * marked {@link NOT_GROUPED_BY_AGENT}. Sinking noise keeps its plain parts.
 */
export async function groupWithAgent(
  files: readonly Part[],
  options: AgentGroupingOptions,
): Promise<AgentGroupingResult> {
  const items = groupingItems(files);
  const { results } = await runAgentTasks(
    options.adapter,
    [
      {
        root: options.root,
        instructions: GROUPING_INSTRUCTIONS,
        prompt: groupingPrompt(items, options.pullRequest),
        schema: GROUPING_SCHEMA,
        check: (answer) => groupingProblems(items, answer as GroupingAnswer),
      },
    ],
    options.settings ?? DEFAULT_AGENT_SETTINGS,
  );
  const result = results[0]!;
  const base = { promptVersion: GROUPING_PROMPT_VERSION, stamp: result.stamp };
  if (!result.ok) {
    const detail = `the agent gave no usable answer (${result.reason}: ${result.message})`;
    return { grouping: { ...base, outcome: 'fell back', detail, leftOut: 0 } };
  }
  const { parts, leftOut } = partsFromAnswer(items, result.answer as GroupingAnswer);
  const noise = groupParts(files.filter((file) => sinks(file.noise)));
  const detail =
    leftOut === 0
      ? 'every hunk was placed by the agent'
      : `${leftOut} ${leftOut === 1 ? 'hunk' : 'hunks'} the agent left out ${leftOut === 1 ? 'is' : 'are'} in a part marked ${NOT_GROUPED_BY_AGENT}`;
  return {
    parts: [...parts, ...noise],
    grouping: { ...base, outcome: 'grouped', detail, leftOut },
  };
}

/**
 * How long the grouping stage may take: the agent's probe, and the run
 * with its one retry, each under the agent's timeout.
 */
export function groupingStageTimeoutMs(settings: AgentSettings): number {
  return 2 * settings.timeoutMs + 60_000;
}
