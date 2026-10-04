import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import {
  DEFAULT_AGENT_SETTINGS,
  runAgentTasks,
  type AgentAdapter,
  type AgentSettings,
} from './agent.js';
import { pathInCopy } from './archive.js';
import { ciLogItems, type CiLogItem } from './ci.js';
import type { JsonSchema } from './json-schema.js';
import { filesOfPart } from './parts.js';
import type {
  CheckedVerdictKind,
  CiResults,
  Citation,
  Claim,
  ClaimJudging,
  ClaimVerdict,
  Claims,
  EvidenceSource,
  Part,
} from './protocol.js';
import { sinksPart } from './rank.js';
import { UNTRUSTED_INPUT_RULE, untrustedBlock } from './untrusted.js';

/**
 * The verdicts pass: the agent judges each listed claim against the
 * change, the read-only head copy and the failed checks' trimmed CI logs
 * — verified, refuted or unverifiable, with its evidence source, its
 * reason, and the lines it cites as evidence, each a file, a line and a
 * quote — and the engine re-checks every citation before keeping the
 * verdict. A citation whose file, line or quote does not match drops the
 * verdict to unverifiable, and the model's memory never yields verified.
 * The verdicts prompt is versioned
 * like code and lands with its evaluation cases (ADR 0006); bump
 * {@link VERDICTS_PROMPT_VERSION}, and its entry in the evaluation's
 * `prompts.json`, whenever the instructions, the prompt or the schema
 * change.
 */

/** The verdicts prompt's id in the evaluation's prompt registry. */
export const VERDICTS_PROMPT_ID = 'verdicts';

/** The verdicts prompt's version. */
export const VERDICTS_PROMPT_VERSION = '2';

/** The evidence sources the agent can cite: the change, or its own memory, and a CI log when one is shown. */
function answerSources(withLogs: boolean): readonly EvidenceSource[] {
  return withLogs ? ['the change itself', 'a CI log', "the model's memory"] : ['the change itself', "the model's memory"];
}

/** The most citations one verdict keeps. */
const MAX_CITATIONS = 5;

/** The longest quote a citation may hold. */
const MAX_CITED_QUOTE = 300;

/** The shortest quote a citation may hold, unless it is the whole line. */
const MIN_CITED_QUOTE = 8;

/** How many lines from the cited one a citation's quote may run over. */
const CITED_SPAN = 10;

/** How many diff lines of a part the prompt shows; the agent can read the rest. */
const SHOWN_LINES = 80;

/** The answer the verdicts prompt asks for; a CI log is an evidence source only when the prompt shows one. */
export function verdictsSchema(withLogs: boolean): JsonSchema {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['verdicts'],
    properties: {
      verdicts: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['id', 'verdict', 'source', 'reason', 'evidence', 'library'],
          properties: {
            id: { type: 'string' },
            verdict: { type: 'string', enum: ['verified', 'refuted', 'unverifiable'] },
            source: { type: 'string', enum: answerSources(withLogs) },
            reason: { type: 'string' },
            evidence: {
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
            library: { type: ['string', 'null'] },
          },
        },
      },
    },
  };
}

/** The answer the verdicts prompt asks for when no CI log is shown. */
export const VERDICTS_SCHEMA: JsonSchema = verdictsSchema(false);

/** One verdict as the agent answers it, before the engine re-checks it. */
export interface AnsweredVerdict {
  /** The claim's id, such as `c2`. */
  id: string;
  verdict: CheckedVerdictKind;
  source: EvidenceSource;
  reason: string;
  evidence: { file: string; line: number; quote: string }[];
  /** The library whose source the claim needs, or null when the change settles it. */
  library: string | null;
}

/** An answer that met {@link VERDICTS_SCHEMA}. */
export interface VerdictsAnswer {
  verdicts: AnsweredVerdict[];
}

/**
 * The last words of the task, where an agent that has read many files
 * still sees them: its final message is the JSON value alone.
 */
const FINAL_ANSWER_RULE =
  'When you have read enough, give your final message as the JSON value alone: start it with { and end it ' +
  'with }, with no summary of what you read before or after it.';

/** The rule for citing a CI log, given only when the prompt shows one. */
const CI_LOG_RULE = [
  '- Set source to "a CI log" when the evidence is lines of a failed check\'s CI log shown below, which',
  '  ran on the merge commit: cite each line as the log\'s id for the file, such as log1, the line\'s',
  '  number in that log, and a quote of it. One verdict cites lines of one source only.',
];

/** The verdicts prompt's system prompt: the agent's setting, the rules and the answer's schema; the CI log rule only when a log is shown. */
export function verdictsInstructions(withLogs: boolean): string {
  return [
    'You are the agent of Second Look, a companion that helps a human review a pull request.',
    "Your current folder is a read-only copy of the pull request's head version. You can only use",
    'file-reading tools on it: you have no shell and no network.',
    UNTRUSTED_INPUT_RULE,
    'Your task is to judge each claim the change makes against the change itself: the lines shown',
    'below and the files of the head copy. Give every claim one verdict:',
    '- verified: the code in the head copy does what the claim says.',
    '- refuted: the code in the head copy does not do what the claim says.',
    '- unverifiable: neither the change nor the head copy can settle the claim.',
    'Rules:',
    '- Read the code the claim is about before judging it; read every file you need.',
    '- Give a verified or refuted claim its evidence: the lines of the head copy that settle it, each',
    '  as the file, the line the quote starts on, and a quote of that line copied exactly as the file',
    '  has it. Every citation is checked against the file, and one that does not match turns the',
    '  verdict into unverifiable.',
    '- Set source to "the change itself" when the evidence is in the change or the head copy, and to',
    '  "the model\'s memory" when it is only what you remember. A verdict from memory is never',
    '  verified: use memory only to refute a claim or to leave it unverifiable, and cite no line.',
    "- Ordinary knowledge of the language and its standard library may be used to read cited code. A",
    "  claim that turns on how a third-party library behaves needs that library's source, which you",
    '  do not have: answer unverifiable and set library to the package name the project uses, even',
    '  when you remember how the library behaves; say what you remember in the reason. Otherwise set',
    '  library to null.',
    ...(withLogs ? CI_LOG_RULE : []),
    '- Tests the change adds show what its author expects, not that the code does it: judge the code.',
    '- The reason is one plain sentence a reviewer reads beside the verdict.',
    '- Answer every claim exactly once. Set id to the claim\'s id exactly as given, such as c1, and nothing',
    '  else: never its quote or a description of it.',
    'Answer with only one JSON value and no other text, no words before or after it, matching this',
    'JSON schema:',
    JSON.stringify(verdictsSchema(withLogs)),
    FINAL_ANSWER_RULE,
  ].join('\n');
}

/** The verdicts prompt's system prompt when no CI log is shown. */
export const VERDICTS_INSTRUCTIONS = verdictsInstructions(false);

/** One claim the prompt offers, with the id it gives it. */
export interface VerdictItem {
  /** The id the prompt gives it, such as `c3`. */
  id: string;
  /** The claim's index in the claims judged. */
  index: number;
  claim: Claim;
}

/** The claims to judge, numbered in the order they are listed. */
export function verdictItems(claims: readonly Claim[]): VerdictItem[] {
  return claims.map((claim, index) => ({ id: `c${index + 1}`, index, claim }));
}

/** Where a claim is made, in words: its source and its place there. */
export function claimPlace(claim: Claim): string {
  const { location } = claim;
  if (location.kind === 'description') return `the pull request's description, line ${location.line}`;
  if (location.kind === 'story') return `the story the companion's agent wrote, sentence ${location.sentence + 1}`;
  if (location.kind === 'pipeline') {
    const at = location.path === undefined ? '' : ` about ${JSON.stringify(location.path)}${location.line === undefined ? '' : `, line ${location.line}`}`;
    return `a finding of the ${location.step} step of the pipeline report in the description${at}`;
  }
  const lines = location.endLine > location.line ? `lines ${location.line}-${location.endLine}` : `line ${location.line}`;
  return `a ${claim.source} the change adds to ${JSON.stringify(location.path)}, ${lines}`;
}

/** A part's diff lines, each marked and numbered, up to {@link SHOWN_LINES} across its files. */
export function diffLines(part: Part): string[] {
  const shown: string[] = [];
  let count = 0;
  for (const file of filesOfPart(part)) {
    shown.push(`file ${JSON.stringify(file.path)}`);
    for (const hunk of file.hunks) {
      for (const line of hunk.lines) {
        if (count++ >= SHOWN_LINES) continue;
        if (line.kind === 'deletion') shown.push(`-    ${line.text}`);
        else shown.push(`${line.kind === 'addition' ? '+' : ' '}${line.newLineNumber}: ${line.text}`);
      }
    }
  }
  if (count > SHOWN_LINES) shown.push(`… ${count - SHOWN_LINES} more diff lines; read the files for the rest`);
  return shown;
}

/** The failed checks' trimmed logs, each with its id outside the untrusted block and its numbered lines inside it. */
function logLines(logs: readonly CiLogItem[], id: string): string[] {
  if (logs.length === 0) return [];
  return [
    'The logs of the checks that failed, run on the merge commit, each trimmed to its failing step. Each',
    'line follows its number in the log.',
    '',
    ...logs.flatMap((item) => [
      `[${item.id}] check ${JSON.stringify(item.check.name)}${item.log.step ? `, failing step ${JSON.stringify(item.log.step)}` : ''}`,
      untrustedBlock(`log ${item.id}`, item.log.lines.map((line, at) => `${at + 1}: ${line}`).join('\n'), id),
    ]),
    '',
  ];
}

/**
 * The verdicts task: each claim with where it is made and its quote, then
 * the diff of every part a claim is about, then the failed checks' trimmed
 * logs when there are any, all marked as untrusted.
 */
export function verdictsPrompt(items: readonly VerdictItem[], parts: readonly Part[], blockId?: string, logs: readonly CiLogItem[] = []): string {
  const id = blockId ?? randomBytes(8).toString('hex');
  const about = [...new Set(items.map((item) => item.claim.part))].sort((a, b) => a - b);
  const claimLines = items.flatMap((item) => [
    `[${item.id}] made in ${claimPlace(item.claim)}; about part p${item.claim.part + 1}`,
    untrustedBlock(`claim ${item.id}`, item.claim.quote, id),
  ]);
  const partLines = about.flatMap((index) => {
    const part = parts[index]!;
    const name = `name: ${part.name ?? part.path}`;
    const body = sinksPart(part) ? `${name}\n(noise: its lines are not shown; read the files if a claim needs them)` : [name, ...diffLines(part)].join('\n');
    return [`[p${index + 1}]`, untrustedBlock(`part p${index + 1}`, body, id)];
  });
  return [
    `Judge these ${items.length} claims. Each has its id and where it is made; its quote follows as`,
    'untrusted text.',
    '',
    ...claimLines,
    '',
    'The parts the claims are about. Each diff line is marked + when the change adds it, - when it',
    'removes it, and blank when it stays; an added or kept line follows its head-side line number.',
    '',
    ...partLines,
    '',
    ...logLines(logs, id),
    FINAL_ANSWER_RULE,
  ].join('\n');
}

/** The schema-level problems with an answer: every claim answered exactly once, by an offered id. */
export function verdictProblems(items: readonly VerdictItem[], answer: VerdictsAnswer): string[] {
  const offered = new Set(items.map((item) => item.id));
  const seen = new Set<string>();
  const problems: string[] = [];
  for (const verdict of answer.verdicts) {
    if (!offered.has(verdict.id)) problems.push(`${JSON.stringify(verdict.id)} is not a claim id`);
    else if (seen.has(verdict.id)) problems.push(`${verdict.id} is answered twice`);
    seen.add(verdict.id);
  }
  const missing = items.filter((item) => !seen.has(item.id)).map((item) => item.id);
  if (missing.length > 0) problems.push(`no verdict for ${missing.join(', ')}`);
  return problems;
}

/** Text on one line: runs of white space as one space. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** Reads a file of the head copy as lines, or undefined when the copy has no such file. */
export type ReadLines = (path: string) => Promise<string[] | undefined>;

/** Reads the head copy's files as lines, each file once, refusing a path that leaves the copy. */
export function copyReader(root: string): ReadLines {
  const read = new Map<string, Promise<string[] | undefined>>();
  return (path) => {
    let lines = read.get(path);
    if (lines === undefined) {
      const absolute = path.startsWith('/') || path.includes('\\') ? undefined : pathInCopy(root, path);
      lines = absolute === undefined ? Promise.resolve(undefined) : readFile(absolute, 'utf8').then((text) => text.split(/\r?\n/), () => undefined);
      read.set(path, lines);
    }
    return lines;
  };
}

/**
 * Re-checks one citation against the head copy, or another read-only
 * copy such as a fetched library's source, named by `copy`: the file must
 * exist, the line must be one of its lines, and the quote must start on
 * that line, as written there, running over at most {@link CITED_SPAN}
 * lines; a quote shorter than {@link MIN_CITED_QUOTE} characters must be
 * the whole line, so a stray bracket proves nothing. Returns the citation
 * as kept, or what is wrong with it.
 */
export async function recheckCitation(
  read: ReadLines,
  cited: { file: string; line: number; quote: string },
  copy = 'the head copy',
): Promise<Citation | string> {
  const where = `${cited.file}:${cited.line}`;
  const quote = oneLine(cited.quote);
  if (quote === '') return `the citation ${where} quotes nothing`;
  if (quote.length > MAX_CITED_QUOTE) return `the citation ${where} quotes over ${MAX_CITED_QUOTE} characters`;
  const lines = await read(cited.file);
  if (lines === undefined) return `the citation ${where} names a file ${copy} does not have`;
  if (cited.line < 1 || cited.line > lines.length) return `the citation ${where} names a line ${cited.file} does not have`;
  const first = oneLine(lines[cited.line - 1]!);
  if (first === '') return `the citation ${where} names a blank line`;
  const text = lines
    .slice(cited.line - 1, cited.line - 1 + CITED_SPAN)
    .map(oneLine)
    .filter((line) => line !== '')
    .join(' ');
  if (quote.length < MIN_CITED_QUOTE && quote !== first) return `the citation ${where} quotes too little of its line to check`;
  // The first match is the earliest, so a match that starts past the cited line means none starts on it.
  const at = text.indexOf(quote);
  if (at < 0 || at >= first.length) return `the quote of the citation ${where} is not on that line`;
  return { path: cited.file, line: cited.line, quote };
}

/**
 * Settles one answered verdict from its re-checked citations: the rules
 * the engine holds every verdict to, whatever the agent said.
 *
 * - The model's memory never yields verified, and cites no line.
 * - A verdict from the change itself keeps only citations that matched;
 *   one whose citation failed, or a verified or refuted one citing
 *   nothing, drops to unverifiable.
 * - A claim that needs library source the companion does not have is
 *   never verified.
 */
export function settleVerdict(answered: AnsweredVerdict, rechecked: readonly (Citation | string)[], evidenceIn = 'the change'): ClaimVerdict {
  const library = answered.library === null ? undefined : oneLine(answered.library);
  const base = {
    source: answered.source,
    reason: oneLine(answered.reason),
    ...(library ? { needsLibrary: library } : {}),
  };
  const drop = (recheck: string, evidence: Citation[]): ClaimVerdict => ({ kind: 'unverifiable', ...base, evidence, recheck });
  if (answered.source === "the model's memory") {
    if (answered.verdict === 'verified') return drop("the model's memory never yields verified", []);
    return { kind: answered.verdict, ...base, evidence: [] };
  }
  const kept = rechecked.filter((each): each is Citation => typeof each !== 'string').slice(0, MAX_CITATIONS);
  const failed = rechecked.filter((each): each is string => typeof each === 'string');
  if (answered.verdict === 'unverifiable') return { kind: 'unverifiable', ...base, evidence: kept };
  if (failed.length > 0) return drop(failed.join('; '), kept);
  if (kept.length === 0) return drop(`the verdict cites no line of ${evidenceIn}`, kept);
  if (answered.verdict === 'verified' && library) return drop(`the claim needs the source of ${library}, which the companion does not have`, kept);
  return { kind: answered.verdict, ...base, evidence: kept };
}

/** Reads the failed checks' trimmed logs as lines, by the id the prompt gives each. */
export function logReader(logs: readonly CiLogItem[]): ReadLines {
  const byId = new Map(logs.map((item) => [item.id, item.log.lines]));
  return async (id) => byId.get(id);
}

/**
 * Re-checks every citation of one answered verdict and settles it: a
 * verdict from a CI log against the logs shown, its citations then named
 * by their check run, and any other against the head copy.
 */
export async function judgeVerdict(read: ReadLines, answered: AnsweredVerdict, logs: readonly CiLogItem[] = []): Promise<ClaimVerdict> {
  const cited = answered.source === "the model's memory" ? [] : answered.evidence;
  if (answered.source !== 'a CI log') return settleVerdict(answered, await Promise.all(cited.map((each) => recheckCitation(read, each))));
  const names = new Map(logs.map((item) => [item.id, item.check.name]));
  const rechecked = await Promise.all(cited.map((each) => recheckCitation(logReader(logs), each, 'the CI logs')));
  const named = rechecked.map((each): Citation | string => (typeof each === 'string' ? each : { ...each, path: names.get(each.path)!, ciLog: true }));
  return settleVerdict(answered, named, 'a CI log');
}

/** Whether a claim is a finding: refuted or unverifiable, which the reviewer is shown on the diff. */
export function isFinding(claim: Claim): boolean {
  return claim.verdict.kind === 'refuted' || claim.verdict.kind === 'unverifiable';
}

/** How many findings each part has, by the part's index. */
export function findingCounts(claims: Claims | undefined, partCount: number): number[] {
  const counts = new Array<number>(partCount).fill(0);
  for (const claim of claims?.claims ?? []) {
    if (isFinding(claim) && claim.part >= 0 && claim.part < partCount) counts[claim.part]!++;
  }
  return counts;
}

/**
 * Where a finding's thread sits on the diff: the head-side line a claim
 * from a docstring or comment starts on, or a pipeline finding names,
 * else the first line of the head copy its verdict cites; none for a
 * claim that cites nothing there, such as one judged against a library's
 * source or a CI log, whose thread sits on its part.
 */
export function findingAnchor(claim: Claim): { path: string; line: number } | undefined {
  const { location, verdict } = claim;
  if (location.kind === 'file') return { path: location.path, line: location.line };
  if (location.kind === 'pipeline' && location.path !== undefined && location.line !== undefined) return { path: location.path, line: location.line };
  const [first] = verdict.kind === 'not checked' || verdict.library !== undefined || verdict.source === 'a CI log' ? [] : verdict.evidence;
  return first === undefined ? undefined : { path: first.path, line: first.line };
}

export interface VerdictsOptions {
  adapter: AgentAdapter;
  settings?: AgentSettings;
  /** The read-only head copy the agent works in, and the citations are re-checked against. */
  root: string;
  /** The CI the review read, whose failed checks' trimmed logs the agent may cite. */
  ci?: CiResults;
}

/**
 * Asks the agent to judge every listed claim, re-checks each citation
 * against the head copy or the CI log it names, and returns the claims with their verdicts, in
 * the same order, and the judging's outcome. A rejected answer is retried
 * once and then reported, and every claim stays not checked.
 */
export async function judgeClaims(
  parts: readonly Part[],
  claims: readonly Claim[],
  options: VerdictsOptions,
): Promise<{ claims: Claim[]; judging: ClaimJudging }> {
  const items = verdictItems(claims);
  const logs = ciLogItems(options.ci);
  const { results } = await runAgentTasks(
    options.adapter,
    [
      {
        root: options.root,
        instructions: verdictsInstructions(logs.length > 0),
        prompt: verdictsPrompt(items, parts, undefined, logs),
        schema: verdictsSchema(logs.length > 0),
        check: (value) => verdictProblems(items, value as VerdictsAnswer),
      },
    ],
    options.settings ?? DEFAULT_AGENT_SETTINGS,
  );
  const result = results[0]!;
  const base = { promptVersion: VERDICTS_PROMPT_VERSION, stamp: result.stamp };
  if (!result.ok) {
    const detail = `the agent gave no usable answer (${result.reason}: ${result.message})`;
    return { claims: [...claims], judging: { ...base, outcome: 'fell back', detail } };
  }
  const read = copyReader(options.root);
  const byId = new Map((result.answer as VerdictsAnswer).verdicts.map((verdict) => [verdict.id, verdict]));
  const judged = await Promise.all(
    items.map(async (item) => ({ ...item.claim, verdict: await judgeVerdict(read, byId.get(item.id)!, logs) })),
  );
  const where = logs.length > 0 ? 'the head copy or the CI log it names' : 'the head copy';
  const detail = `every citation was re-read in ${where}; one that did not match, or the model's memory alone, kept a claim from verified`;
  return { claims: judged, judging: { ...base, outcome: 'judged', detail } };
}
