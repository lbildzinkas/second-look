import { randomBytes } from 'node:crypto';
import {
  DEFAULT_AGENT_SETTINGS,
  runAgentTasks,
  type AgentAdapter,
  type AgentSettings,
} from './agent.js';
import { normalizeQuote, quotedLine, QUOTE_MARKER } from './claims.js';
import type { JsonSchema } from './json-schema.js';
import type {
  AcceptanceCriterion,
  Citation,
  Criteria,
  CriteriaMapping,
  CriterionVerdict,
  CriterionVerdictKind,
  LinkedIssue,
  ManualCheck,
  Part,
} from './protocol.js';
import { sinksPart } from './rank.js';
import { UNTRUSTED_INPUT_RULE, untrustedBlock } from './untrusted.js';
import { copyReader, diffLines, recheckCitation, type ReadLines } from './verdicts.js';

/**
 * The criteria-mapping pass: the agent judges each acceptance criterion
 * read from the linked issues against the change, the read-only head
 * copy and the description — met, partly met, not met, can't tell or
 * needs manual check, with its reason — and shows where: the lines of
 * code that implement it, the lines of the automated tests that cover
 * it, each a file, a line and a quote, and the manual checks the
 * description reports, each quoted from it. The engine re-reads every
 * citation in the head copy and finds every manual check in the
 * description before keeping the verdict; one that does not match drops
 * the verdict to can't tell. The prompt is versioned like code and lands
 * with its evaluation cases (ADR 0006); bump
 * {@link CRITERIA_MAPPING_PROMPT_VERSION}, and its entry in the
 * evaluation's `prompts.json`, whenever the instructions, the prompt or
 * the schema change.
 */

/** The criteria-mapping prompt's id in the evaluation's prompt registry. */
export const CRITERIA_MAPPING_PROMPT_ID = 'criteria-mapping';

/** The criteria-mapping prompt's version. */
export const CRITERIA_MAPPING_PROMPT_VERSION = '1';

/** The verdicts the agent can give a criterion, in the order the instructions explain them. */
const ANSWER_VERDICTS: readonly CriterionVerdictKind[] = ['met', 'partly met', 'not met', "can't tell", 'needs manual check'];

/** The most citations of code, and of tests, one verdict keeps, and the most manual checks. */
const MAX_EVIDENCE = 5;

/** The longest manual check quote the companion shows. */
const MAX_MANUAL_QUOTE = 500;

/** One cited line, as the answer gives it. */
const CITED_LINE: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['file', 'line', 'quote'],
  properties: {
    file: { type: 'string' },
    line: { type: 'integer' },
    quote: { type: 'string' },
  },
};

/** The answer the criteria-mapping prompt asks for. */
export const CRITERIA_MAPPING_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['criteria'],
  properties: {
    criteria: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'verdict', 'reason', 'code', 'tests', 'manual'],
        properties: {
          id: { type: 'string' },
          verdict: { type: 'string', enum: ANSWER_VERDICTS },
          reason: { type: 'string' },
          code: { type: 'array', items: CITED_LINE },
          tests: { type: 'array', items: CITED_LINE },
          manual: { type: 'array', items: { type: 'string' } },
        },
      },
    },
  },
};

/** One criterion's verdict as the agent answers it, before the engine re-checks it. */
export interface AnsweredCriterion {
  /** The criterion's id, such as `a2`. */
  id: string;
  verdict: CriterionVerdictKind;
  reason: string;
  code: { file: string; line: number; quote: string }[];
  tests: { file: string; line: number; quote: string }[];
  /** The manual checks the description reports for it, each quoted from the description. */
  manual: string[];
}

/** An answer that met {@link CRITERIA_MAPPING_SCHEMA}. */
export interface CriteriaMappingAnswer {
  criteria: AnsweredCriterion[];
}

/**
 * The last words of the task, where an agent that has read many files
 * still sees them: its final message is the JSON value alone.
 */
const FINAL_ANSWER_RULE =
  'When you have read enough, give your final message as the JSON value alone: start it with { and end it ' +
  'with }, with no summary of what you read before or after it.';

/** The criteria-mapping prompt's system prompt: the agent's setting, the verdicts, the rules and the answer's schema. */
export const CRITERIA_MAPPING_INSTRUCTIONS = [
  'You are the agent of Second Look, a companion that helps a human review a pull request.',
  "Your current folder is a read-only copy of the pull request's head version. You can only use",
  'file-reading tools on it: you have no shell and no network.',
  UNTRUSTED_INPUT_RULE,
  'Your task is to judge, for each acceptance criterion of the issues the pull request links, whether',
  'the change meets it, and to show where: the code that implements it, the automated tests that',
  "cover it, and the manual checks the pull request's description reports for it. Give every",
  'criterion one verdict:',
  '- met: the change does all the criterion asks, shown by its code, its tests or a manual check.',
  '- partly met: the change does some of what the criterion asks but not all; the reason says what',
  '  is missing.',
  '- not met: the change does not do what the criterion asks, or does something else.',
  "- can't tell: nothing you can read settles it, such as a criterion about speed or about another",
  '  system with no measurement or check reported.',
  '- needs manual check: only a person trying the change can settle it, such as how something looks,',
  '  reads or behaves on screen or on a device, and the description reports no manual check that',
  '  does. When the description reports one that settles it, judge the criterion with it instead.',
  'Rules:',
  '- Read the code a criterion is about before judging it; read every file you need.',
  '- code: the lines of the head copy that implement the criterion; tests: the lines of the automated',
  '  tests that exercise what it asks for. Give each as the file, the line the quote starts on, and',
  '  a quote of that line copied exactly as the file has it; at most five of each, the ones that',
  '  matter most. Take each line number from the file as you read it, never by counting: every',
  '  citation is checked against the file, and one that does not match, even one line off, turns the',
  "  verdict into can't tell, so cite fewer lines rather than guess. Cite code a criterion needs that",
  '  is wrong or missing in the reason, not as evidence.',
  '- A test is evidence only when it exercises the behaviour the criterion asks for. Tests show what',
  '  their author expects, not that the code does it: judge the code.',
  '- manual: the manual checks the description reports for the criterion, such as the steps a person',
  '  followed, what they saw, a screenshot or a measurement they took. Quote each exactly as the',
  '  description writes it, leaving out the > markers that start quoted lines, usually one sentence.',
  '  Quote only what a person did or saw, never a plan or a promise. Every quote is checked against',
  '  the description.',
  '- A met or partly met criterion cites at least one line of code, a test or a manual check.',
  '- The reason is one plain sentence a reviewer reads beside the verdict. Every reason goes inside the',
  '  JSON value: write no list of your verdicts before it.',
  "- Answer every criterion exactly once. Set id to the criterion's id exactly as given, such as a1, and",
  '  nothing else: never its quote.',
  'Answer with only one JSON value and no other text, no words before or after it, matching this',
  'JSON schema:',
  JSON.stringify(CRITERIA_MAPPING_SCHEMA),
  FINAL_ANSWER_RULE,
].join('\n');

/** One criterion the prompt offers, with the id it gives it. */
export interface CriterionItem {
  /** The id the prompt gives it, such as `a3`. */
  id: string;
  /** The criterion's index in the criteria mapped. */
  index: number;
  criterion: AcceptanceCriterion;
}

/** The criteria to map, numbered in the order they are listed. */
export function criterionItems(criteria: readonly AcceptanceCriterion[]): CriterionItem[] {
  return criteria.map((criterion, index) => ({ id: `a${index + 1}`, index, criterion }));
}

/** A linked issue as the prompt names it, by its index in the criteria's issues: `i1`, `i2`… */
function issueId(index: number): string {
  return `i${index + 1}`;
}

/** One linked issue as the prompt shows it: its id and link outside the untrusted block; its title and body inside it. */
function describeIssue(issue: LinkedIssue, index: number, blockId: string): string[] {
  const id = issueId(index);
  return [
    `[${id}] #${issue.number} in ${issue.repository}, which the pull request ${issue.link === 'closes' ? 'closes' : 'references'}`,
    untrustedBlock(`issue ${id} title`, issue.title, blockId),
    untrustedBlock(`issue ${id} body`, issue.body, blockId),
  ];
}

/** One part as the prompt shows it: its id outside the untrusted block; its name and diff lines inside it. */
function describePart(part: Part, index: number, blockId: string): string[] {
  const name = `name: ${part.name ?? part.path}`;
  const body = sinksPart(part) ? `${name}\n(noise: its lines are not shown; read the files if a criterion needs them)` : [name, ...diffLines(part)].join('\n');
  return [`[p${index + 1}]`, untrustedBlock(`part p${index + 1}`, body, blockId)];
}

/**
 * The task: the description, the linked issues each criterion comes
 * from, each criterion with its issue and its quote, then the diff of
 * every part, all marked as untrusted.
 */
export function criteriaMappingPrompt(
  items: readonly CriterionItem[],
  parts: readonly Part[],
  pullRequest: { title: string; description: string },
  issues: readonly LinkedIssue[],
  blockId?: string,
): string {
  const id = blockId ?? randomBytes(8).toString('hex');
  const from = [...new Set(items.map((item) => item.criterion.issue))].sort((a, b) => a - b);
  const issueLines = from.flatMap((index) => {
    const issue = issues[index];
    return issue === undefined ? [] : describeIssue(issue, index, id);
  });
  const criterionLines = items.flatMap((item) => [
    `[${item.id}] from issue ${issueId(item.criterion.issue)}, line ${item.criterion.line}`,
    untrustedBlock(`criterion ${item.id}`, item.criterion.quote, id),
  ]);
  return [
    'The pull request under review; its description is where any manual check is reported:',
    untrustedBlock('pull request title', pullRequest.title, id),
    untrustedBlock('pull request description', pullRequest.description, id),
    '',
    `The ${from.length === 1 ? 'issue' : 'issues'} the criteria come from, each with its id:`,
    ...issueLines,
    '',
    `Judge these ${items.length} acceptance criteria. Each has its id and where it comes from; its quote`,
    'follows as untrusted text.',
    '',
    ...criterionLines,
    '',
    `The ${parts.length} parts of the change. Each diff line is marked + when the change adds it, - when it`,
    'removes it, and blank when it stays; an added or kept line follows its head-side line number.',
    '',
    ...parts.flatMap((part, index) => describePart(part, index, id)),
    '',
    FINAL_ANSWER_RULE,
  ].join('\n');
}

/** The schema-level problems with an answer: every criterion answered exactly once, by an offered id. */
export function criteriaMappingProblems(items: readonly CriterionItem[], answer: CriteriaMappingAnswer): string[] {
  const offered = new Set(items.map((item) => item.id));
  const seen = new Set<string>();
  const problems: string[] = [];
  for (const answered of answer.criteria) {
    if (!offered.has(answered.id)) problems.push(`${JSON.stringify(answered.id)} is not a criterion id`);
    else if (seen.has(answered.id)) problems.push(`${answered.id} is answered twice`);
    seen.add(answered.id);
  }
  const missing = items.filter((item) => !seen.has(item.id)).map((item) => item.id);
  if (missing.length > 0) problems.push(`no verdict for ${missing.join(', ')}`);
  return problems;
}

/** Text on one line: runs of white space as one space. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** Finds one manual check in the description, or says what is wrong with it. */
export function locateManualCheck(description: string, quoted: string): ManualCheck | string {
  const quote = normalizeQuote(quoted, QUOTE_MARKER);
  if (quote === '') return 'a manual check quotes nothing';
  if (quote.length > MAX_MANUAL_QUOTE) return `a manual check quotes over ${MAX_MANUAL_QUOTE} characters`;
  const line = quotedLine(description, quoted);
  if (line === undefined) return `the manual check ${JSON.stringify(quote)} is not in the description`;
  return { quote, line };
}

/** Each kept item once, by its key, in the answer's order, up to {@link MAX_EVIDENCE}. */
function keptOnce<T>(rechecked: readonly (T | string)[], key: (kept: T) => string): T[] {
  const kept = new Map<string, T>();
  for (const each of rechecked) {
    if (typeof each !== 'string' && !kept.has(key(each))) kept.set(key(each), each);
  }
  return [...kept.values()].slice(0, MAX_EVIDENCE);
}

/**
 * Settles one answered criterion from its re-checked evidence: the rules
 * the engine holds every criterion's verdict to, whatever the agent said.
 *
 * - Only citations that matched the head copy, and manual checks found
 *   in the description, are kept.
 * - A verdict other than can't tell whose citation or manual check did
 *   not match drops to can't tell.
 * - A met or partly met verdict with no code, test or manual check left
 *   drops to can't tell.
 */
export function settleCriterion(
  answered: AnsweredCriterion,
  rechecked: { code: readonly (Citation | string)[]; tests: readonly (Citation | string)[]; manual: readonly (ManualCheck | string)[] },
): CriterionVerdict {
  const cited = (citation: Citation): string => JSON.stringify([citation.path, citation.line]);
  const evidence = {
    reason: oneLine(answered.reason),
    code: keptOnce(rechecked.code, cited),
    tests: keptOnce(rechecked.tests, cited),
    manualChecks: keptOnce(rechecked.manual, (check) => JSON.stringify([check.line, check.quote])),
  };
  const failed = [...rechecked.code, ...rechecked.tests, ...rechecked.manual].filter((each): each is string => typeof each === 'string');
  const drop = (recheck: string): CriterionVerdict => ({ kind: "can't tell", ...evidence, recheck });
  if (answered.verdict === "can't tell") return { kind: "can't tell", ...evidence };
  if (failed.length > 0) return drop(failed.join('; '));
  const shown = evidence.code.length + evidence.tests.length + evidence.manualChecks.length;
  if ((answered.verdict === 'met' || answered.verdict === 'partly met') && shown === 0) return drop('the verdict cites no code, test or manual check');
  return { kind: answered.verdict, ...evidence };
}

/** Re-checks every citation of one answered criterion against the head copy and finds each manual check in the description, then settles it. */
export async function mapCriterion(read: ReadLines, description: string, answered: AnsweredCriterion): Promise<CriterionVerdict> {
  const [code, tests] = await Promise.all([
    Promise.all(answered.code.map((each) => recheckCitation(read, each))),
    Promise.all(answered.tests.map((each) => recheckCitation(read, each))),
  ]);
  return settleCriterion(answered, { code, tests, manual: answered.manual.map((quote) => locateManualCheck(description, quote)) });
}

/** Whether a criterion is a finding: not met or partly met, which the reviewer must see. */
export function isUnmetCriterion(criterion: AcceptanceCriterion): boolean {
  return criterion.verdict.kind === 'not met' || criterion.verdict.kind === 'partly met';
}

export interface CriteriaMappingOptions {
  adapter: AgentAdapter;
  settings?: AgentSettings;
  /** The read-only head copy the agent works in, and the citations are re-checked against. */
  root: string;
  /** The pull request's title and its description, where its manual checks are reported. */
  pullRequest: { title: string; description: string };
}

/**
 * Asks the agent to map every criterion read to the change, re-checks
 * each citation against the head copy and finds each manual check in the
 * description, and returns the criteria with their verdicts, in the same
 * order, and the mapping's outcome. A rejected answer is retried once and
 * then reported, and every criterion stays not checked.
 */
export async function mapCriteria(
  parts: readonly Part[],
  criteria: Criteria,
  options: CriteriaMappingOptions,
): Promise<{ criteria: AcceptanceCriterion[]; mapping: CriteriaMapping }> {
  const items = criterionItems(criteria.criteria);
  const { results } = await runAgentTasks(
    options.adapter,
    [
      {
        root: options.root,
        instructions: CRITERIA_MAPPING_INSTRUCTIONS,
        prompt: criteriaMappingPrompt(items, parts, options.pullRequest, criteria.issues),
        schema: CRITERIA_MAPPING_SCHEMA,
        check: (value) => criteriaMappingProblems(items, value as CriteriaMappingAnswer),
      },
    ],
    options.settings ?? DEFAULT_AGENT_SETTINGS,
  );
  const result = results[0]!;
  const base = { promptVersion: CRITERIA_MAPPING_PROMPT_VERSION, stamp: result.stamp };
  if (!result.ok) {
    const detail = `the agent gave no usable answer (${result.reason}: ${result.message})`;
    return { criteria: [...criteria.criteria], mapping: { ...base, outcome: 'fell back', detail } };
  }
  const read = copyReader(options.root);
  const byId = new Map((result.answer as CriteriaMappingAnswer).criteria.map((answered) => [answered.id, answered]));
  const mapped = await Promise.all(
    items.map(async (item) => ({ ...item.criterion, verdict: await mapCriterion(read, options.pullRequest.description, byId.get(item.id)!) })),
  );
  const detail =
    "every citation was re-read in the head copy and every manual check found in the description; one that did not match made a criterion can't tell";
  return { criteria: mapped, mapping: { ...base, outcome: 'mapped', detail } };
}
