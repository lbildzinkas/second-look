import type { AgentAdapter, AgentSettings, AgentStamp } from './agent.js';
import { normalizeQuote } from './claims.js';
import { offerLibraryFetches } from './library-fetch.js';
import { filesOfPart } from './parts.js';
import type { AskedClaim, AskSection, CiResults, Claim, Part, PartCitation, ReviewResult, ReviewerSelection } from './protocol.js';
import { claimPlace, copyReader, judgeClaims, VERDICTS_PROMPT_VERSION, type ReadLines } from './verdicts.js';
import type { AskReply } from './asks.js';

/**
 * Verify this claim, an ask: the reviewer picks one of a part's claims,
 * or selects text in the part's diff, and the judging pass runs on it
 * alone — the verdicts prompt, its citations re-read in the head copy,
 * and the library fetch offer when the claim needs a library's source,
 * which downloads nothing until the reviewer presses it (ADR 0003). The
 * judged claim joins the review's claims, marked as judged by this ask
 * so its verdict stands even when the claims pass's judging fell back,
 * and its verdict shows on the diff like any other, with its fetch
 * pressed from there.
 */

/** The longest selection the companion verifies as a claim, as on one line. */
export const MAX_SELECTION = 500;

/** The most lines one selection spans. */
const MAX_SELECTED_LINES = 20;

/** Whether a value read from a request names the claim a verify ask checks. */
export function isAskedClaim(value: unknown): value is AskedClaim {
  if (typeof value !== 'object' || value === null) return false;
  const { index, selection } = value as Record<string, unknown>;
  if (index !== undefined) return Number.isInteger(index) && (index as number) >= 0;
  if (typeof selection !== 'object' || selection === null) return false;
  const { path, line, endLine, text } = selection as Record<string, unknown>;
  return typeof path === 'string' && Number.isInteger(line) && Number.isInteger(endLine) && typeof text === 'string';
}

/** Whether the part shows a line on its head side: added or kept, in one of its files. */
function showsHeadLine(part: Part, path: string, line: number): boolean {
  const file = filesOfPart(part).find((each) => each.path === path);
  return (file?.hunks ?? []).some((hunk) => hunk.lines.some((each) => each.kind !== 'deletion' && each.newLineNumber === line));
}

/**
 * The reviewer's selection as a claim about the part, not checked yet,
 * or what is wrong with it: it must sit on head-side lines the part's
 * diff shows, span at most {@link MAX_SELECTED_LINES} lines, and be on
 * those lines of the head copy as selected, each line's comment marker
 * dropped as a claim's quote drops it.
 */
export async function selectedClaim(parts: readonly Part[], part: number, selection: ReviewerSelection, read: ReadLines): Promise<Claim | string> {
  const { path, line, endLine } = selection;
  const quote = normalizeQuote(selection.text);
  if (quote === '') return 'the selection holds no text to verify';
  if (quote.length > MAX_SELECTION) return `the selection is over ${MAX_SELECTION} characters; select one claim`;
  if (line < 1 || endLine < line || endLine - line >= MAX_SELECTED_LINES) return `select at most ${MAX_SELECTED_LINES} lines`;
  const shown = parts[part];
  if (shown === undefined || !showsHeadLine(shown, path, line) || !showsHeadLine(shown, path, endLine)) {
    return "the selection is not on the head side of this part's diff";
  }
  const lines = await read(path);
  const selected = lines === undefined ? '' : normalizeQuote(lines.slice(line - 1, endLine).join('\n'));
  if (!selected.includes(quote)) return `the selection is not on lines ${line}-${endLine} of ${path} in the head copy`;
  return { quote, source: 'reviewer', location: { kind: 'file', path, line, endLine }, part, verdict: { kind: 'not checked' } };
}

/**
 * The claim to verify and the index it takes in the review's claims: a
 * picked claim keeps its own; a selection takes the index of the same
 * selection verified before, or comes after every claim. Says what is
 * wrong instead when the claim is none of the part's, or was already
 * judged in a fetched library's source, which judging again would lose.
 */
async function claimToVerify(result: ReviewResult, part: number, asked: AskedClaim): Promise<{ index: number; claim: Claim } | string> {
  const claims = result.claims?.claims;
  if (claims === undefined) return 'the review has no claims pass to verify against; review the pull request again';
  if ('index' in asked) {
    const claim = claims[asked.index];
    if (claim === undefined || claim.part !== part) return `claim ${asked.index} is not one of this part's claims`;
    if (claim.verdict.kind !== 'not checked' && claim.verdict.library !== undefined) {
      return "this claim was judged in its library's source; its finding shows that verdict";
    }
    return { index: asked.index, claim };
  }
  const claim = await selectedClaim(result.parts, part, asked.selection, copyReader(result.copies.head.path));
  if (typeof claim === 'string') return claim;
  const same = claims.findIndex((each) => each.source === 'reviewer' && each.quote === claim.quote && JSON.stringify(each.location) === JSON.stringify(claim.location));
  return { index: same < 0 ? claims.length : same, claim };
}

/** The verdict's sections: the claim and where it is made, the verdict with its source and reason, and the library fetch it offers or why none. */
function verdictSections(claim: Claim): AskSection[] {
  const { verdict } = claim;
  const sections = [{ heading: 'Claim', text: `"${claim.quote}", made in ${claimPlace(claim)}.` }];
  if (verdict.kind === 'not checked') return sections;
  const recheck = verdict.recheck === undefined ? '' : ` The engine kept it from a firmer verdict: ${verdict.recheck}.`;
  sections.push({ heading: 'Verdict', text: `${verdict.kind}, from ${verdict.source}: ${verdict.reason}${recheck}` });
  if (verdict.libraryFetch !== undefined) {
    sections.push({ heading: 'Library fetch', text: `${verdict.libraryFetch.reason} Press the fetch on the claim's finding to start it.` });
  } else if (verdict.noLibraryFetch !== undefined) {
    sections.push({ heading: 'Library fetch', text: verdict.noLibraryFetch });
  }
  return sections;
}

/** The head copy's lines a verdict cites, as the answer cites them; a CI log's lines stay in the verdict's finding. */
function citedLines(claim: Claim): PartCitation[] {
  if (claim.verdict.kind === 'not checked') return [];
  return claim.verdict.evidence.filter((each) => each.ciLog === undefined).map((each) => ({ path: each.path, side: 'head', line: each.line, quote: each.quote }));
}

/**
 * Runs the judging pass on one claim alone, against the change, the head
 * copy and the failed checks' CI logs, then offers its library fetch when
 * it needs one the head copy pins or the agent named: the claim judged,
 * marked `asked` so its verdict stands even when the claims pass's
 * judging fell back, or why it was not, stamped.
 */
export async function judgeOneClaim(
  parts: readonly Part[],
  claim: Claim,
  options: { adapter: AgentAdapter; settings?: AgentSettings; root: string; ci?: CiResults },
): Promise<{ claim: Claim; stamp: AgentStamp } | { detail: string; stamp: AgentStamp }> {
  const judged = await judgeClaims(parts, [{ ...claim, verdict: { kind: 'not checked' } }], options);
  const { stamp, detail } = judged.judging;
  if (judged.judging.outcome === 'fell back') return { detail, stamp };
  const [offered] = await offerLibraryFetches(judged.claims, options.root);
  return { claim: { ...offered!, asked: true }, stamp };
}

/**
 * Verifies one claim about a part (see {@link judgeOneClaim}). Throws
 * with the plain reason when the claim cannot be verified; a judging that
 * fell back is the ask's fallback.
 */
export async function verifyClaim(context: {
  result: ReviewResult;
  part: number;
  claim: AskedClaim;
  adapter: AgentAdapter;
  settings?: AgentSettings;
}): Promise<AskReply> {
  const { result, part } = context;
  const asked = await claimToVerify(result, part, context.claim);
  if (typeof asked === 'string') throw new Error(asked);
  const judged = await judgeOneClaim(result.parts, asked.claim, {
    adapter: context.adapter,
    ...(context.settings ? { settings: context.settings } : {}),
    root: result.copies.head.path,
    ...(result.ci ? { ci: result.ci } : {}),
  });
  const base = { promptVersion: VERDICTS_PROMPT_VERSION, stamp: judged.stamp };
  if ('detail' in judged) return { ...base, outcome: 'fell back', detail: judged.detail };
  const { claim } = judged;
  return { ...base, outcome: 'answered', sections: verdictSections(claim), cited: citedLines(claim), claim: { index: asked.index, claim } };
}

/**
 * The review with a verified claim in it: in the picked claim's place, or
 * after every claim for a new selection. Undefined when the review's
 * claims changed meanwhile, so the claim's index no longer holds it.
 */
export function withVerifiedClaim(result: ReviewResult, verified: { index: number; claim: Claim }): ReviewResult | undefined {
  const claims = result.claims;
  if (claims === undefined || verified.index > claims.claims.length) return undefined;
  const held = claims.claims[verified.index];
  if (held !== undefined && held.quote !== verified.claim.quote) return undefined;
  const updated = held === undefined ? [...claims.claims, verified.claim] : claims.claims.map((each, at) => (at === verified.index ? verified.claim : each));
  return { ...result, claims: { ...claims, claims: updated } };
}
