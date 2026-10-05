import { randomBytes } from 'node:crypto';
import { DEFAULT_AGENT_SETTINGS, runAgentTasks, type AgentAdapter, type AgentSettings, type AgentStamp } from './agent.js';
import type { JsonSchema } from './json-schema.js';
import { fetchLibrary, findLibraryPin, type LibraryFetchOptions } from './library-fetch.js';
import type { CheckedVerdictKind, Claim, ClaimVerdict, EvidenceSource, FetchedLibrary, LibraryFetchOffer, Part } from './protocol.js';
import { fetchNamedRepository } from './repository-fetch.js';
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
export const LIBRARY_VERDICTS_PROMPT_VERSION = '3';

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

/**
 * The library verdicts prompt's system prompt: the agent's setting, the
 * rules and the answer's schema; for a named repository, the folder is
 * said to hold the tag named rather than the version the project pins.
 */
export function libraryVerdictsInstructions(named = false): string {
  return [
    'You are the agent of Second Look, a companion that helps a human review a pull request.',
    named
      ? "Your current folder is a read-only copy of one library's repository, at a tag named for the version the project uses."
      : "Your current folder is a read-only copy of one library's source, at the version the project pins.",
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
}

/** The library verdicts prompt's system prompt for a library the project pins. */
export const LIBRARY_VERDICTS_INSTRUCTIONS = libraryVerdictsInstructions();

/** The library verdicts task: the library, the claim and the diff of its part, the claim and the diff marked as untrusted. */
export function libraryVerdictPrompt(claim: Claim, part: Part, library: Pick<LibraryFetchOffer, 'library' | 'pinnedVersion' | 'pinnedBy' | 'namedRepository'>, blockId?: string): string {
  const id = blockId ?? randomBytes(8).toString('hex');
  const named = library.namedRepository;
  return [
    named === undefined
      ? `Judge this claim against the source of ${library.library} ${library.pinnedVersion}, as ${library.pinnedBy} pins it.`
      : `Judge this claim against the source of ${library.library} in ${named.url} at tag ${named.tag}; nothing pins it, and the tag may not hold the version the project uses.`,
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

/**
 * A cited path as the copy's reader resolves it: empty and `.` segments
 * dropped, `..` resolved, and Unicode normalization and case folded, as
 * the copy's filesystem compares names.
 */
function resolvedPathKey(path: string): string {
  const segments: string[] = [];
  for (const segment of path.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') segments.pop();
    else segments.push(segment.normalize('NFC').toLowerCase());
  }
  return segments.join('/');
}

/**
 * Whether a cited path names one of a fetched library's unproven files,
 * however the citation spells the path: the reader resolves empty, `.`
 * and `..` segments and case when it reads the file, so `src/./Events.cs`
 * names `src/Events.cs`.
 */
export function isUnprovenSource(path: string, unproven: readonly string[] | undefined): boolean {
  if (unproven === undefined) return false;
  const resolved = resolvedPathKey(path);
  return unproven.some((each) => resolvedPathKey(each) === resolved);
}

/**
 * Holds a verdict judged in a fetched library's source to its unproven
 * files: a verified verdict that cites any file not proven to be what the
 * library was built from, however it spells its path, drops to
 * unverifiable, naming those files.
 */
export function holdToExactSource(verdict: ClaimVerdict, unproven: readonly string[]): ClaimVerdict {
  if (verdict.kind !== 'verified') return verdict;
  const cited = [...new Set(verdict.evidence.map((each) => each.path).filter((path) => isUnprovenSource(path, unproven)))];
  if (cited.length === 0) return verdict;
  const files = cited.length === 1 ? `${cited[0]}, which is unproven` : `${cited.join(', ')}, which are unproven`;
  return { ...verdict, kind: 'unverifiable', recheck: `the verdict cites ${files}: no hash its PDB records matches, so it may not be the source the library was built from` };
}

/** What came of pressing a library fetch: the claim judged again, or why it kept its verdict. */
export type LibraryJudging =
  | { outcome: 'judged'; claim: Claim; stamp: AgentStamp }
  | { outcome: 'fell back'; claim: Claim; detail: string; stamp: AgentStamp };

export interface PressLibraryFetchOptions extends LibraryFetchOptions {
  adapter: AgentAdapter;
  settings?: AgentSettings;
  /** The read-only head copy, read again for the library's pin. */
  headRoot: string;
}

/**
 * Presses one claim's library fetch, as the reviewer does: reads the pin
 * again from the head copy, fetches the library (see
 * {@link fetchLibrary}), and asks the agent to judge the claim again in
 * the library's source, re-reading every citation there. The new verdict
 * keeps the offer that was pressed and carries the library it was judged
 * against, and a verified verdict citing an unproven file drops to
 * unverifiable (see {@link holdToExactSource}). An offer of a named
 * repository fetches the tag the agent named instead (see
 * {@link fetchNamedRepository}), and its verdict's evidence source is a
 * named repository, weaker than pinned source; a rejected answer is
 * retried once and then reported, and the
 * claim keeps its verdict and its offer. Throws when the claim offers no
 * fetch, or when the fetch fails, such as on a hash mismatch.
 */
export async function pressLibraryFetch(parts: readonly Part[], claim: Claim, options: PressLibraryFetchOptions): Promise<LibraryJudging> {
  const { verdict } = claim;
  const offer = verdict.kind === 'not checked' ? undefined : verdict.libraryFetch;
  const part = parts[claim.part];
  if (verdict.kind === 'not checked' || offer === undefined || part === undefined) throw new Error('this claim offers no library fetch');
  const named = offer.namedRepository;
  const pin = await findLibraryPin(options.headRoot, offer.library);
  if (named === undefined && (pin === undefined || pin.version !== offer.pinnedVersion)) {
    throw new Error(`the head copy no longer pins ${offer.library} ${offer.pinnedVersion} with a hash; review the pull request again`);
  }
  if (named !== undefined && pin !== undefined) throw new Error(`the head copy now pins ${offer.library}; review the pull request again`);
  const fetched = pin === undefined ? await fetchNamedRepository(offer.library, named!, options) : await fetchLibrary(pin, options);
  const { results } = await runAgentTasks(
    options.adapter,
    [
      {
        root: fetched.path,
        instructions: libraryVerdictsInstructions(named !== undefined),
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
  const where = `the source of ${offer.library} ${offer.pinnedVersion}`;
  const read = copyReader(fetched.path);
  const cited = answer.source === "the model's memory" ? [] : answer.evidence;
  const rechecked = await Promise.all(cited.map((each) => recheckCitation(read, each, where)));
  // A named repository's evidence is labelled as such, never as pinned source.
  const source = named !== undefined && answer.source === LIBRARY_SOURCE ? 'a named repository' : answer.source;
  const settled = holdToExactSource(settleVerdict({ id: '', ...answer, source, library: null }, rechecked, where), fetched.unproven ?? []);
  if (settled.kind === 'not checked') return { outcome: 'fell back', claim, detail: 'the verdict could not be settled', stamp: result.stamp };
  const { file, sha256, archive, path, note, unproven } = fetched;
  const library: FetchedLibrary = {
    library: pin?.name ?? offer.library,
    pinnedVersion: pin?.version ?? offer.pinnedVersion,
    pinnedBy: pin?.pinnedBy ?? offer.pinnedBy,
    file,
    sha256,
    archive,
    path,
    ...(note ? { note } : {}),
    ...(unproven ? { unproven } : {}),
    promptVersion: LIBRARY_VERDICTS_PROMPT_VERSION,
    stamp: result.stamp,
  };
  return { outcome: 'judged', claim: { ...claim, verdict: { ...settled, libraryFetch: offer, library } }, stamp: result.stamp };
}
