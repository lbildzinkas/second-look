import { randomBytes } from 'node:crypto';
import { DEFAULT_AGENT_SETTINGS, runAgentTasks, type AgentAdapter, type AgentSettings, type AgentStamp } from './agent.js';
import type { JsonSchema } from './json-schema.js';
import { fetchLibrary, findLibraryPin, type LibraryFetchOptions } from './library-fetch.js';
import type { CheckedVerdictKind, Claim, EvidenceSource, FetchedLibrary, Part } from './protocol.js';
import { UNTRUSTED_INPUT_RULE, untrustedBlock } from './untrusted.js';
import { claimPlace, claimText, copyReader, diffLines, recheckCitation, settleVerdict } from './verdicts.js';

/**
 * The library verdicts pass: once the reviewer pressed a claim's library
 * fetch, the agent judges the claim again in the fetched library's
 * read-only source, citing the library's lines, which the engine re-reads
 * there before keeping the verdict. The prompt is versioned like code and
 * lands with its evaluation cases (ADR 0006); bump
 * {@link LIBRARY_VERDICTS_PROMPT_VERSION}, and its entry in the
 * evaluation's `prompts.json`, whenever the instructions, the prompt or
 * the schema change.
 */

/** The library verdicts prompt's id in the evaluation's prompt registry. */
export const LIBRARY_VERDICTS_PROMPT_ID = 'library-verdicts';

/** The library verdicts prompt's version. */
export const LIBRARY_VERDICTS_PROMPT_VERSION = '2';

const LIBRARY_SOURCE: EvidenceSource = 'library source at the pinned version';

/** The answer the library verdicts prompt asks for: one verdict on the one claim. */
export const LIBRARY_VERDICT_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['verdict', 'source', 'reason', 'evidence'],
  properties: {
    verdict: { type: 'string', enum: ['verified', 'refuted', 'unverifiable'] },
    source: { type: 'string', enum: [LIBRARY_SOURCE, "the model's memory"] },
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
  },
};

/** An answer that met {@link LIBRARY_VERDICT_SCHEMA}. */
export interface LibraryVerdictAnswer {
  verdict: CheckedVerdictKind;
  source: EvidenceSource;
  reason: string;
  evidence: { file: string; line: number; quote: string }[];
}

const FINAL_ANSWER_RULE =
  'When you have read enough, give your final message as the JSON value alone: start it with { and end it ' +
  'with }, with no summary of what you read before or after it.';

/** The library verdicts prompt's system prompt: the agent's setting, the rules and the answer's schema. */
export const LIBRARY_VERDICTS_INSTRUCTIONS = [
  'You are the agent of Second Look, a companion that helps a human review a pull request.',
  "Your current folder is a read-only copy of one library's source, at the version the project pins.",
  'You can only use file-reading tools on it: you have no shell and no network.',
  UNTRUSTED_INPUT_RULE,
  'A claim the change makes turns on how this library behaves. Your task is to judge the claim against',
  "the library's source in your folder, reading the change's lines shown below for how the change uses it.",
  'Give the claim one verdict:',
  '- verified: the library, used as the change uses it, does what the claim says.',
  '- refuted: the library, used as the change uses it, does not do what the claim says.',
  "- unverifiable: the library's source cannot settle the claim.",
  'Rules:',
  "- Read the library's code the claim turns on before judging it; read every file you need.",
  '- Give a verified or refuted claim its evidence: the lines of the library that settle it, each as the',
  '  file, by its path in your folder, the line the quote starts on, and a quote of that line copied',
  '  exactly as the file has it. Every citation is checked against the file, and one that does not match',
  '  turns the verdict into unverifiable.',
  `- Set source to "${LIBRARY_SOURCE}" when the evidence is in the library's source, and to`,
  '  "the model\'s memory" when it is only what you remember. A verdict from memory is never verified:',
  '  use memory only to refute a claim or to leave it unverifiable, and cite no line.',
  '- The reason is one plain sentence a reviewer reads beside the verdict.',
  'Answer with only one JSON value and no other text, no words before or after it, matching this',
  'JSON schema:',
  JSON.stringify(LIBRARY_VERDICT_SCHEMA),
  FINAL_ANSWER_RULE,
].join('\n');

/** The library verdicts task: the library, the claim and the diff of its part, the claim and the diff marked as untrusted. */
export function libraryVerdictPrompt(claim: Claim, part: Part, library: { library: string; pinnedVersion: string; pinnedBy: string }, blockId?: string): string {
  const id = blockId ?? randomBytes(8).toString('hex');
  return [
    `Judge this claim against the source of ${library.library} ${library.pinnedVersion}, as ${library.pinnedBy} pins it.`,
    `It is made in ${claimPlace(claim)}; its quote follows as untrusted text.`,
    '',
    untrustedBlock('claim', claimText(claim), id),
    '',
    'The part of the change the claim is about. Each diff line is marked + when the change adds it, - when it',
    'removes it, and blank when it stays; an added or kept line follows its head-side line number.',
    '',
    untrustedBlock('part', [`name: ${part.name ?? part.path}`, ...diffLines(part)].join('\n'), id),
    '',
    FINAL_ANSWER_RULE,
  ].join('\n');
}

/** What came of pressing a library fetch: the claim judged again, or why it kept its verdict. */
export type LibraryJudging =
  | { outcome: 'judged'; claim: Claim; stamp: AgentStamp }
  | { outcome: 'fell back'; claim: Claim; detail: string; stamp: AgentStamp };

export interface PressLibraryFetchOptions extends LibraryFetchOptions {
  adapter: AgentAdapter;
  settings?: AgentSettings;
  /** The read-only head copy, whose lock files pin the library. */
  headRoot: string;
}

/**
 * Presses one claim's library fetch, as the reviewer does: reads the pin
 * again from the head copy's lock files, fetches the library (see
 * {@link fetchLibrary}), and asks the agent to judge the claim again in
 * the library's source, re-reading every citation there. The new verdict
 * keeps the offer that was pressed and carries the library it was judged
 * against; a rejected answer is retried once and then reported, and the
 * claim keeps its verdict and its offer. Throws when the claim offers no
 * fetch, or when the fetch fails, such as on a hash mismatch.
 */
export async function pressLibraryFetch(parts: readonly Part[], claim: Claim, options: PressLibraryFetchOptions): Promise<LibraryJudging> {
  const { verdict } = claim;
  const offer = verdict.kind === 'not checked' ? undefined : verdict.libraryFetch;
  const part = parts[claim.part];
  if (verdict.kind === 'not checked' || offer === undefined || part === undefined) throw new Error('this claim offers no library fetch');
  const pin = await findLibraryPin(options.headRoot, offer.library);
  if (pin === undefined || pin.version !== offer.pinnedVersion) {
    throw new Error(`the head copy no longer pins ${offer.library} ${offer.pinnedVersion} with a hash; review the pull request again`);
  }
  const fetched = await fetchLibrary(pin, options);
  const { results } = await runAgentTasks(
    options.adapter,
    [
      {
        root: fetched.path,
        instructions: LIBRARY_VERDICTS_INSTRUCTIONS,
        prompt: libraryVerdictPrompt(claim, part, offer),
        schema: LIBRARY_VERDICT_SCHEMA,
      },
    ],
    options.settings ?? DEFAULT_AGENT_SETTINGS,
  );
  const result = results[0]!;
  if (!result.ok) {
    const detail = `the agent gave no usable answer (${result.reason}: ${result.message})`;
    return { outcome: 'fell back', claim, detail, stamp: result.stamp };
  }
  const answer = result.answer as LibraryVerdictAnswer;
  const where = `the source of ${pin.name} ${pin.version}`;
  const read = copyReader(fetched.path);
  const cited = answer.source === "the model's memory" ? [] : answer.evidence;
  const rechecked = await Promise.all(cited.map((each) => recheckCitation(read, each, where)));
  const settled = settleVerdict({ id: '', ...answer, library: null }, rechecked, where);
  if (settled.kind === 'not checked') return { outcome: 'fell back', claim, detail: 'the verdict could not be settled', stamp: result.stamp };
  const { file, sha256, archive, path, note } = fetched;
  const library: FetchedLibrary = {
    library: pin.name,
    pinnedVersion: pin.version,
    pinnedBy: pin.pinnedBy,
    file,
    sha256,
    archive,
    path,
    ...(note ? { note } : {}),
    promptVersion: LIBRARY_VERDICTS_PROMPT_VERSION,
    stamp: result.stamp,
  };
  return { outcome: 'judged', claim: { ...claim, verdict: { ...settled, libraryFetch: offer, library } }, stamp: result.stamp };
}
