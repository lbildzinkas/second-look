import { randomBytes } from 'node:crypto';
import {
  DEFAULT_AGENT_SETTINGS,
  runAgentTasks,
  type AgentAdapter,
  type AgentSettings,
  type AgentStamp,
} from './agent.js';
import { locateManualCheck } from './criteria-mapping.js';
import { sidedLines } from './explain.js';
import type { JsonSchema } from './json-schema.js';
import type { Citation, ManualCheck, Part } from './protocol.js';
import { UNTRUSTED_INPUT_RULE, untrustedBlock } from './untrusted.js';
import { copyReader, recheckCitation, type ReadLines } from './verdicts.js';

/**
 * The cover prompt, the "what covers this?" ask: on the reviewer's
 * request, the agent lists the automated tests, in the change or
 * anywhere in the head copy, that exercise one part, and the manual
 * checks the pull request's description reports for it — or says none
 * were found, a valid answer. The engine re-reads every cited test line
 * in the head copy and finds every manual check in the description
 * before showing the answer. The prompt is versioned like code and lands
 * with its evaluation cases (ADR 0006); bump {@link COVER_PROMPT_VERSION},
 * and its entry in the evaluation's `prompts.json`, whenever the
 * instructions, the prompt or the schema change.
 */

/** The cover prompt's id in the evaluation's prompt registry. */
export const COVER_PROMPT_ID = 'cover';

/** The cover prompt's version. */
export const COVER_PROMPT_VERSION = '1';

/** The longest summary the companion shows. */
export const MAX_COVER_SUMMARY = 400;

/** The most test lines, and the most manual checks, one answer gives. */
const MAX_COVERING = 5;

/** The answer the cover prompt asks for. */
export const COVER_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['tests', 'manual', 'summary'],
  properties: {
    tests: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['file', 'line', 'quote'],
        properties: {
          file: { type: 'string' },
          line: { type: 'integer' },
          quote: { type: 'string' },
        },
      },
    },
    manual: { type: 'array', items: { type: 'string' } },
    summary: { type: 'string' },
  },
};

/** An answer that met {@link COVER_SCHEMA}. */
export interface CoverAnswer {
  /** The test lines that exercise the part, each a file, a line and a quote, as the agent gives them. */
  tests: { file: string; line: number; quote: string }[];
  /** The manual checks the description reports for the part, each quoted from it. */
  manual: string[];
  /** What covers the part, or that nothing was found. */
  summary: string;
}

const FINAL_ANSWER_RULE =
  'When you have read enough, give your final message as the JSON value alone: start it with { and end it ' +
  'with }, with no summary of what you read before or after it.';

/** The cover prompt's system prompt: the agent's setting, the rules and the answer's schema. */
export const COVER_INSTRUCTIONS = [
  'You are the agent of Second Look, a companion that helps a human review a pull request.',
  "Your current folder is a read-only copy of the pull request's head version. You can only use",
  'file-reading tools on it: you have no shell and no network.',
  UNTRUSTED_INPUT_RULE,
  'Your task is to tell the reviewer, who asked for it, what covers one part of the change: the',
  'automated tests that exercise it and the manual checks the pull request reports for it.',
  'Rules:',
  "- tests: lines of automated tests, in the change or anywhere in the head copy, that run the part's",
  '  code: a test that calls what the part adds or changes, or runs the path the part changes. Cite',
  "  each test by the line that names it or that calls the part's code: the file, the line the quote",
  '  starts on, taken from the file as you read it, and a quote of that line copied exactly as the',
  `  file has it; at most ${MAX_COVERING}, the most direct first. Every citation is checked against the file.`,
  "  Search the test files for the part's names before deciding; a test that only names the code in",
  '  a string or a comment, or exercises other code nearby, does not cover it.',
  '- manual: the manual checks the description reports that try what the part does, such as steps a',
  `  person followed, what they saw or a measurement they took, at most ${MAX_COVERING}. Quote each exactly as`,
  '  the description writes it, leaving out the > markers that start quoted lines, usually one',
  '  sentence; quote only what a person did or saw, never a plan or a promise. Every quote is checked',
  '  against the description.',
  '- None found is a valid answer: when no test exercises the part and the description reports no',
  '  manual check of it, give both lists empty. Never cite a test or a check that does not cover the',
  '  part to have something to show.',
  `- summary: one or two plain sentences under ${MAX_COVER_SUMMARY} characters: what covers the part, or that`,
  '  nothing was found and where you looked. Write every file or code name in backticks.',
  'Answer with only one JSON value and no other text, no words before or after it, matching this',
  'JSON schema:',
  JSON.stringify(COVER_SCHEMA),
  FINAL_ANSWER_RULE,
].join('\n');

/**
 * The task: the pull request's own text, where its manual checks are
 * reported, the part asked about with its numbered lines, then the
 * change's other parts by name, all marked as untrusted.
 */
export function coverPrompt(
  parts: readonly Part[],
  index: number,
  pullRequest: { title: string; description: string },
  blockId?: string,
): string {
  const id = blockId ?? randomBytes(8).toString('hex');
  const part = parts[index]!;
  const others = parts.flatMap((other, at) => (at === index ? [] : [`p${at + 1}: ${other.name ?? other.path}`]));
  return [
    'The pull request under review; its description is where any manual check is reported:',
    untrustedBlock('pull request title', pullRequest.title, id),
    untrustedBlock('pull request description', pullRequest.description, id),
    '',
    `Find what covers part p${index + 1}, one of the change's ${parts.length} parts. Its name and diff follow`,
    'as untrusted text. Each diff line is marked + when the change adds it, - when it removes it, and',
    'blank when it stays, with its side and its line number there.',
    '',
    untrustedBlock(`part p${index + 1}`, [`name: ${part.name ?? part.path}`, ...sidedLines(part)].join('\n'), id),
    '',
    others.length === 0 ? 'The change has no other part.' : "The change's other parts, by name, which may hold its tests:",
    ...(others.length === 0 ? [] : [untrustedBlock('other parts', others.join('\n'), id)]),
    '',
    FINAL_ANSWER_RULE,
  ].join('\n');
}

/** Text on one line: runs of white space as one space. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** The answer's form: a summary within the cap, and at most {@link MAX_COVERING} tests and manual checks. */
export function coverFormProblems(answer: CoverAnswer): string[] {
  const problems: string[] = [];
  const length = oneLine(answer.summary).length;
  if (length === 0) problems.push('summary is empty');
  else if (length > MAX_COVER_SUMMARY) problems.push(`summary is ${length} characters; at most ${MAX_COVER_SUMMARY} are allowed`);
  if (answer.tests.length > MAX_COVERING) problems.push(`the answer cites ${answer.tests.length} test lines; at most ${MAX_COVERING} are allowed`);
  if (answer.manual.length > MAX_COVERING) problems.push(`the answer quotes ${answer.manual.length} manual checks; at most ${MAX_COVERING} are allowed`);
  return problems;
}

/**
 * The plain checks of an answer, the cover prompt's score: the test
 * lines re-read in the head copy and the manual checks found in the
 * description, each kept once, and what is wrong with every other one.
 */
export interface CoverChecks {
  tests: Citation[];
  manualChecks: ManualCheck[];
  refused: string[];
}

/** Re-reads every cited test line in the head copy and finds every manual check in the description. */
export async function coverChecks(read: ReadLines, description: string, answer: CoverAnswer): Promise<CoverChecks> {
  const tests = await Promise.all(answer.tests.map((each) => recheckCitation(read, each)));
  const manual = answer.manual.map((quote) => locateManualCheck(description, quote));
  const kept = <T>(checked: readonly (T | string)[], key: (each: T) => string): T[] => {
    const once = new Map<string, T>();
    for (const each of checked) if (typeof each !== 'string' && !once.has(key(each))) once.set(key(each), each);
    return [...once.values()];
  };
  return {
    tests: kept(tests, (each) => JSON.stringify([each.path, each.line])),
    manualChecks: kept(manual, (each) => JSON.stringify([each.line, each.quote])),
    refused: [...tests, ...manual].filter((each): each is string => typeof each === 'string'),
  };
}

export interface CoverOptions {
  adapter: AgentAdapter;
  settings?: AgentSettings;
  /** The read-only head copy the agent works in, and the test lines are re-read in. */
  root: string;
  /** The pull request's title and its description, where its manual checks are reported. */
  pullRequest: { title: string; description: string };
  /**
   * Whether an answer must pass the plain checks as well as the form, or
   * be retried; true when absent. The evaluation turns it off to score
   * the prompt's own answers on those checks.
   */
  plainChecks?: boolean;
}

/** What the cover prompt produced: what covers the part, none being an answer, or why there is no answer. */
export interface CoverResult {
  /** `covered` when the answer is shown, none found included; `fell back` when the agent's answer was missing or failed the checks. */
  outcome: 'covered' | 'fell back';
  /** One plain line: how the answer was checked, or why there is none. */
  detail: string;
  /** The agent's answer as it wrote it; absent on a fallback. */
  answer?: CoverAnswer;
  /** The answer's checked tests and manual checks; absent on a fallback. */
  checks?: CoverChecks;
  promptVersion: string;
  stamp: AgentStamp;
}

/**
 * Asks the agent what covers one part, by its index in the parts shown,
 * and checks its answer: the form always, and the plain checks unless
 * turned off. A rejected answer is retried once and then reported.
 */
export async function findCoverage(parts: readonly Part[], index: number, options: CoverOptions): Promise<CoverResult> {
  const read = copyReader(options.root);
  const { description } = options.pullRequest;
  const plainChecks = options.plainChecks ?? true;
  const { results } = await runAgentTasks(
    options.adapter,
    [
      {
        root: options.root,
        instructions: COVER_INSTRUCTIONS,
        prompt: coverPrompt(parts, index, options.pullRequest),
        schema: COVER_SCHEMA,
        check: async (value) => {
          const answer = value as CoverAnswer;
          const form = coverFormProblems(answer);
          if (form.length > 0 || !plainChecks) return form;
          return (await coverChecks(read, description, answer)).refused;
        },
      },
    ],
    options.settings ?? DEFAULT_AGENT_SETTINGS,
  );
  const result = results[0]!;
  const base = { promptVersion: COVER_PROMPT_VERSION, stamp: result.stamp };
  if (!result.ok) return { ...base, outcome: 'fell back', detail: `the agent gave no usable answer (${result.reason}: ${result.message})` };
  const answer = result.answer as CoverAnswer;
  const detail = plainChecks
    ? 'the checks accepted the answer: every cited test line was re-read in the head copy, and every manual check found in the description'
    : 'the answer has its form; the plain checks were not applied';
  return { ...base, outcome: 'covered', detail, answer, checks: await coverChecks(read, description, answer) };
}
