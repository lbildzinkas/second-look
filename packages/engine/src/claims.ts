import { randomBytes } from 'node:crypto';
import {
  DEFAULT_AGENT_SETTINGS,
  runAgentTasks,
  type AgentAdapter,
  type AgentSettings,
} from './agent.js';
import type { JsonSchema } from './json-schema.js';
import { filesOfPart } from './parts.js';
import {
  CLAIM_SOURCE_ORDER,
  type Claim,
  type ClaimLocation,
  type ClaimSource,
  type FileSlice,
  type Claims,
  type Part,
  type Story,
} from './protocol.js';
import { sinksPart } from './rank.js';
import { UNTRUSTED_INPUT_RULE, cleanUntrustedText, untrustedBlock } from './untrusted.js';

/**
 * The claims pass: the agent lists the claims a change makes about how
 * code or a library behaves — from the pull request's description, the
 * docstrings and comments the change adds, and the story the companion's
 * own agent wrote — and the engine checks every quote against its source
 * before listing any. The engine, not the agent, sets each claim's
 * location and, for a docstring or comment, its part. The claims prompt
 * is versioned like code and lands with its evaluation cases (ADR 0006);
 * bump {@link CLAIMS_PROMPT_VERSION}, and its entry in the evaluation's
 * `prompts.json`, whenever the instructions, the prompt or the schema
 * change.
 */

/** The claims prompt's id in the evaluation's prompt registry. */
export const CLAIMS_PROMPT_ID = 'claims';

/** The claims prompt's version. */
export const CLAIMS_PROMPT_VERSION = '1';

/** The most claims one answer may list. */
const MAX_CLAIMS = 40;

/** The longest quote the companion lists. */
const MAX_QUOTE_LENGTH = 500;

/** How many added lines of a part the prompt shows; the agent can read the rest. */
const SHOWN_LINES = 80;

/** The answer the claims prompt asks for. */
export const CLAIMS_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['claims'],
  properties: {
    claims: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['source', 'quote', 'file', 'line', 'part'],
        properties: {
          source: { type: 'string', enum: CLAIM_SOURCE_ORDER },
          quote: { type: 'string' },
          file: { type: ['string', 'null'] },
          line: { type: ['integer', 'null'] },
          part: { type: ['string', 'null'] },
        },
      },
    },
  },
};

/** One claim as the agent answers it, before the engine locates it. */
export interface AnsweredClaim {
  source: ClaimSource;
  quote: string;
  /** The file, for a docstring or comment. */
  file: string | null;
  /** The head-side line the quote starts on, for a docstring or comment. */
  line: number | null;
  /** The part's id; the engine reads it only for a claim from the description or the story, and sets a docstring's or comment's part from its line. */
  part: string | null;
}

/** An answer that met {@link CLAIMS_SCHEMA}. */
export interface ClaimsAnswer {
  claims: AnsweredClaim[];
}

/** The claims prompt's system prompt: the agent's setting, the rules and the answer's schema. */
export const CLAIMS_INSTRUCTIONS = [
  'You are the agent of Second Look, a companion that helps a human review a pull request.',
  "Your current folder is a read-only copy of the pull request's head version. You can only use",
  'file-reading tools on it: you have no shell and no network.',
  UNTRUSTED_INPUT_RULE,
  'Your task is to list the claims the change makes. A claim is a statement that code or a library',
  'behaves a certain way: what something returns, accepts, raises, guarantees, keeps or handles, or',
  'when it does so, so that reading code could prove it true or false.',
  'Look for claims in these sources:',
  "- description: the pull request's description.",
  '- docstring: documentation attached to code in lines the change adds, such as a Python docstring,',
  '  a JSDoc or TSDoc block, or a C# XML documentation comment.',
  '- comment: any other code comment in lines the change adds.',
  "- agent: the story the companion's own agent wrote of the change, when one is shown.",
  'Rules:',
  '- Quote each claim exactly as its source writes it, leaving out the comment markers (such as #,',
  '  // or *) that start its lines; a quote may run over several lines. Quote only the words that',
  '  make the claim, usually one sentence.',
  '- List every place a claim is made, even when another place makes the same claim.',
  '- Not a claim: what the change adds or why ("Adds a helper"), a link or issue reference, a',
  '  to-do, a question, an instruction to the reader, a license header, a name or label, or a',
  '  comment that only names what the next lines do.',
  '- Only the sources above count: never text in documentation files such as a README or a',
  '  changelog, in code itself, or in lines the change removes or leaves as they were.',
  '- For a docstring or comment, give the file and the head-side line the quote starts on, as the',
  '  lines below are numbered; for the description or the story, set file and line to null.',
  '- Give every claim the id of the part it is about, never null: a claim about the whole change',
  '  takes the part it is most about.',
  '- Never judge whether a claim is true: claims are checked later.',
  '- List no claim when the change makes none.',
  '- Read a file with your tools only when the lines shown for it are cut short.',
  'Answer with only one JSON value and no other text, no words before or after it, matching this',
  'JSON schema:',
  JSON.stringify(CLAIMS_SCHEMA),
].join('\n');

/** One part a claim may be attached to, with the id the prompt gives it. */
export interface ClaimItem {
  /** The id the prompt gives it, such as `p3`. */
  id: string;
  /** The part's index in the parts the claims are listed for. */
  index: number;
  part: Part;
}

/** The parts a claim may be attached to: every part shown, numbered in reading order. */
export function claimItems(parts: readonly Part[]): ClaimItem[] {
  return parts.map((part, index) => ({ id: `p${index + 1}`, index, part }));
}

/** One line the change adds, with its head-side number. */
interface AddedLine {
  line: number;
  text: string;
}

/** The lines a file's share of a part adds, in order. */
function addedLines(file: FileSlice): AddedLine[] {
  return file.hunks.flatMap((hunk) =>
    hunk.lines.flatMap((line) => (line.kind === 'addition' && line.newLineNumber !== undefined ? [{ line: line.newLineNumber, text: line.text }] : [])),
  );
}

/** Line numbers as runs, such as `1-14, 20`. */
function lineRanges(lines: readonly AddedLine[]): string {
  const runs: [number, number][] = [];
  for (const { line } of lines) {
    const last = runs[runs.length - 1];
    if (last && line === last[1] + 1) last[1] = line;
    else runs.push([line, line]);
  }
  return runs.map(([from, to]) => (from === to ? `${from}` : `${from}-${to}`)).join(', ');
}

/** A part's added lines, numbered, up to {@link SHOWN_LINES} across its files. */
function partLines(part: Part): string[] {
  const shown: string[] = [];
  let count = 0;
  for (const file of filesOfPart(part)) {
    const lines = addedLines(file);
    shown.push(`${JSON.stringify(file.path)} adds lines ${lines.length > 0 ? lineRanges(lines) : 'none'}`);
    for (const { line, text } of lines) {
      if (count++ < SHOWN_LINES) shown.push(`${line}: ${text}`);
    }
  }
  if (count > SHOWN_LINES) shown.push(`… ${count - SHOWN_LINES} more added lines; read the files for the rest`);
  return shown;
}

/** One part as the prompt shows it: its id outside the untrusted block; its name and added lines inside it. */
function describeItem(item: ClaimItem, blockId: string): string {
  const name = `name: ${item.part.name ?? item.part.path}`;
  if (sinksPart(item.part)) return [`[${item.id}] noise`, untrustedBlock(`part ${item.id}`, `${name}\n(its lines are not shown)`, blockId)].join('\n');
  return [`[${item.id}]`, untrustedBlock(`part ${item.id}`, [name, ...partLines(item.part)].join('\n'), blockId)].join('\n');
}

/** A story sentence as the reader sees it: its runs' text joined. */
function sentenceText(story: Story, index: number): string {
  return story.sentences[index]!.segments.map((segment) => segment.text).join('');
}

/** The written story's sentences, or none when there is no story to read. */
function storySentences(story: Story | undefined): string[] {
  if (story === undefined || story.outcome !== 'written') return [];
  return story.sentences.map((_sentence, index) => sentenceText(story, index));
}

/** The claims task: the description, the story and the parts' added lines, all marked as untrusted. */
export function claimsPrompt(
  items: readonly ClaimItem[],
  pullRequest: { title: string; description: string },
  story?: Story,
  blockId?: string,
): string {
  const id = blockId ?? randomBytes(8).toString('hex');
  const sentences = storySentences(story);
  const storyLines =
    sentences.length > 0
      ? [
          "The story the companion's agent wrote, one sentence per line:",
          untrustedBlock('story', sentences.map((sentence, index) => `[s${index + 1}] ${sentence}`).join('\n'), id),
        ]
      : ['No story was written, so there is no agent source.'];
  return [
    'The pull request under review:',
    untrustedBlock('pull request title', pullRequest.title, id),
    untrustedBlock('pull request description', pullRequest.description, id),
    '',
    ...storyLines,
    '',
    `List the claims of these ${items.length} parts. Each has its id; its name and the lines it adds,`,
    'each after its head-side line number, follow as untrusted text.',
    '',
    ...items.map((item) => describeItem(item, id)),
  ].join('\n');
}

/** A comment marker at the start of a line: `#`, `//`, `///`, `/*`, `*`, `--`, `;` or `%`. */
const COMMENT_MARKER = /^\s*(?:\/{2,}!?|\/\*+|\*+|#+|-{2,}|;+|%+)?/;

/** A quote marker at the start of a description line. */
const QUOTE_MARKER = /^\s*(?:>\s*)*/;

/** Text on one line: runs of white space as one space. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * Lines flattened to one line, as a quote is matched: each line cleaned
 * as the agent read it, its leading marker dropped, and the lines joined
 * by one space; `lineOf` gives the line each character came from.
 */
interface Flattened {
  text: string;
  lineOf: number[];
}

function flatten(lines: readonly AddedLine[], marker: RegExp): Flattened {
  let text = '';
  const lineOf: number[] = [];
  for (const { line, text: raw } of lines) {
    const words = oneLine(cleanUntrustedText(raw).replace(marker, ''));
    if (words === '') continue;
    const joined = text === '' ? words : ` ${words}`;
    text += joined;
    for (let i = 0; i < joined.length; i++) lineOf.push(line);
  }
  return { text, lineOf };
}

/** A quote as it is matched: each of its lines' leading marker dropped, on one line. */
export function normalizeQuote(quote: string, marker: RegExp = COMMENT_MARKER): string {
  return oneLine(
    quote
      .split('\n')
      .map((line) => line.replace(marker, ''))
      .join(' '),
  );
}

const WORD = /\w/;

/**
 * Every place a quote sits in flattened text, as the first and last line
 * it spans; a match must not start or end inside a word.
 */
function matches(flat: Flattened, quote: string): { line: number; endLine: number }[] {
  const found: { line: number; endLine: number }[] = [];
  if (quote === '') return found;
  for (let at = flat.text.indexOf(quote); at >= 0; at = flat.text.indexOf(quote, at + 1)) {
    const end = at + quote.length;
    if (WORD.test(quote[0]!) && at > 0 && WORD.test(flat.text[at - 1]!)) continue;
    if (WORD.test(quote[quote.length - 1]!) && end < flat.text.length && WORD.test(flat.text[end]!)) continue;
    found.push({ line: flat.lineOf[at]!, endLine: flat.lineOf[end - 1]! });
  }
  return found;
}

/** Splits added lines into runs of consecutive lines, so a quote never spans a gap. */
function consecutiveRuns(lines: readonly AddedLine[]): AddedLine[][] {
  const runs: AddedLine[][] = [];
  for (const each of lines) {
    const run = runs[runs.length - 1];
    if (run && each.line === run[run.length - 1]!.line + 1) run.push(each);
    else runs.push([each]);
  }
  return runs;
}

/** What the claims are checked against: the parts with their added lines, the description and the story. */
export interface ClaimContext {
  items: ClaimItem[];
  description: string;
  story?: Story;
}

/** Where a file's added lines sit: each part index and the lines it adds, by path. */
function fileLines(items: readonly ClaimItem[]): Map<string, { part: number; lines: AddedLine[] }[]> {
  const byPath = new Map<string, { part: number; lines: AddedLine[] }[]>();
  for (const item of items) {
    for (const file of filesOfPart(item.part)) {
      const shares = byPath.get(file.path) ?? [];
      shares.push({ part: item.index, lines: addedLines(file) });
      byPath.set(file.path, shares);
    }
  }
  return byPath;
}

/**
 * Locates a docstring's or comment's quote in the lines the change adds
 * to the file: the match that spans the given line, else the only match
 * in the file. The part is the one holding the line the quote starts on.
 */
function locateInFile(
  shares: readonly { part: number; lines: AddedLine[] }[],
  path: string,
  line: number,
  quote: string,
): { location: ClaimLocation; part: number } | undefined {
  const lines = shares.flatMap((share) => share.lines).sort((a, b) => a.line - b.line);
  const found = consecutiveRuns(lines).flatMap((run) => matches(flatten(run, COMMENT_MARKER), quote));
  const spanning = found.filter((match) => match.line <= line && line <= match.endLine);
  const chosen = spanning[0] ?? (found.length === 1 ? found[0] : undefined);
  if (chosen === undefined) return undefined;
  const part = shares.find((share) => share.lines.some((each) => each.line === chosen.line))!.part;
  return { location: { kind: 'file', path, line: chosen.line, endLine: chosen.endLine }, part };
}

/** A quote marker for a story sentence: none, only leading white space. */
const NO_MARKER = /^\s*/;

/** The marker each source's lines may start with, which a quote leaves out. */
function markerOf(source: ClaimSource): RegExp {
  if (source === 'description') return QUOTE_MARKER;
  return source === 'agent' ? NO_MARKER : COMMENT_MARKER;
}

/** What a claim is checked against, prepared once for every claim of an answer. */
interface Sources {
  byId: Map<string, number>;
  files: Map<string, { part: number; lines: AddedLine[] }[]>;
  description: Flattened;
  sentences: Flattened[];
}

/**
 * Checks one answered claim against its source and locates it, or says
 * what is wrong with it, naming it by its place in the answer.
 */
function locateClaim(sources: Sources, answered: AnsweredClaim, name: string): Claim | string {
  const quote = normalizeQuote(answered.quote, markerOf(answered.source));
  if (quote === '') return `${name} has an empty quote`;
  if (quote.length > MAX_QUOTE_LENGTH) return `${name}'s quote is over ${MAX_QUOTE_LENGTH} characters`;
  const claim = (place: { location: ClaimLocation; part: number }): Claim => ({
    quote,
    source: answered.source,
    ...place,
    verdict: { kind: 'not checked' },
  });
  if (answered.source === 'docstring' || answered.source === 'comment') {
    const shares = answered.file === null ? undefined : sources.files.get(answered.file);
    if (shares === undefined) return `${name} names ${JSON.stringify(answered.file)}, which is not a file the change has`;
    if (answered.line === null) return `${name} gives no line`;
    const place = locateInFile(shares, answered.file!, answered.line, quote);
    if (place === undefined) return `${name}'s quote is not in the lines the change adds to ${answered.file} at line ${answered.line}`;
    return claim(place);
  }
  const part = answered.part === null ? undefined : sources.byId.get(answered.part);
  if (part === undefined) return `${name} names ${JSON.stringify(answered.part)}, which is not a part id`;
  if (answered.source === 'description') {
    const [found] = matches(sources.description, quote);
    if (found === undefined) return `${name}'s quote is not in the description`;
    return claim({ location: { kind: 'description', line: found.line }, part });
  }
  const sentence = sources.sentences.findIndex((text) => matches(text, quote).length > 0);
  if (sentence < 0) return `${name}'s quote is not in the story`;
  return claim({ location: { kind: 'story', sentence }, part });
}

/**
 * Checks each answered claim against its source and locates it: a quote
 * must sit in its source as written — the description, the lines the
 * change adds to the named file, or a sentence of the story — and a claim
 * from the description or the story must name an offered part. The
 * engine sets the location, and a docstring's or comment's part, from
 * where the quote sits; the agent's line only picks between repeats.
 * Returns the claims in priority order, each once, or the problems and
 * no claim.
 */
export function locateClaims(context: ClaimContext, answer: ClaimsAnswer): { claims: Claim[]; problems: string[] } {
  const problems: string[] = [];
  if (answer.claims.length > MAX_CLAIMS) problems.push(`the answer lists ${answer.claims.length} claims; at most ${MAX_CLAIMS} are allowed`);
  const sources: Sources = {
    byId: new Map(context.items.map((item) => [item.id, item.index])),
    files: fileLines(context.items),
    description: flatten(
      context.description.split('\n').map((text, index) => ({ line: index + 1, text })),
      QUOTE_MARKER,
    ),
    sentences: storySentences(context.story).map((text) => flatten([{ line: 0, text }], NO_MARKER)),
  };
  const located = new Map<string, Claim>();
  answer.claims.forEach((answered, index) => {
    const outcome = locateClaim(sources, answered, `claim ${index + 1}`);
    if (typeof outcome === 'string') problems.push(outcome);
    else located.set(JSON.stringify([outcome.source, outcome.location, outcome.quote]), outcome);
  });
  return { claims: problems.length > 0 ? [] : [...located.values()].sort(byPriority), problems };
}

/** A location's line or sentence, for ordering claims within one part. */
function positionOf(location: ClaimLocation): number {
  return location.kind === 'story' ? location.sentence : location.line;
}

/** Orders claims by their source's priority, then by part, file and position. */
function byPriority(a: Claim, b: Claim): number {
  const path = (claim: Claim): string => (claim.location.kind === 'file' ? claim.location.path : '');
  return (
    CLAIM_SOURCE_ORDER.indexOf(a.source) - CLAIM_SOURCE_ORDER.indexOf(b.source) ||
    a.part - b.part ||
    path(a).localeCompare(path(b)) ||
    positionOf(a.location) - positionOf(b.location)
  );
}

/** How many claims each part has, by the part's index. */
export function claimCounts(claims: Claims | undefined, partCount: number): number[] {
  const counts = new Array<number>(partCount).fill(0);
  for (const claim of claims?.claims ?? []) {
    if (claim.part >= 0 && claim.part < partCount) counts[claim.part]!++;
  }
  return counts;
}

export interface ClaimsOptions {
  adapter: AgentAdapter;
  settings?: AgentSettings;
  /** The read-only head copy the agent works in. */
  root: string;
  pullRequest: { title: string; description: string };
  /** The story the agent wrote, whose sentences are the agent's own claims; none when absent. */
  story?: Story;
}

/**
 * Asks the agent to list the claims of the parts shown, and checks every
 * quote against its source. A rejected answer is retried once and then
 * reported, and no claim is listed.
 */
export async function findClaims(parts: readonly Part[], options: ClaimsOptions): Promise<Claims> {
  const items = claimItems(parts);
  const context: ClaimContext = {
    items,
    description: options.pullRequest.description,
    ...(options.story ? { story: options.story } : {}),
  };
  const { results } = await runAgentTasks(
    options.adapter,
    [
      {
        root: options.root,
        instructions: CLAIMS_INSTRUCTIONS,
        prompt: claimsPrompt(items, options.pullRequest, options.story),
        schema: CLAIMS_SCHEMA,
        check: (value) => locateClaims(context, value as ClaimsAnswer).problems,
      },
    ],
    options.settings ?? DEFAULT_AGENT_SETTINGS,
  );
  const result = results[0]!;
  const base = { promptVersion: CLAIMS_PROMPT_VERSION, stamp: result.stamp };
  if (!result.ok) {
    const detail = `the agent gave no usable answer (${result.reason}: ${result.message})`;
    return { ...base, outcome: 'fell back', detail, claims: [] };
  }
  const { claims } = locateClaims(context, result.answer as ClaimsAnswer);
  const detail = 'every quote was found in its source, which locates the claim and, for a docstring or comment, its part';
  return { ...base, outcome: 'listed', detail, claims };
}
