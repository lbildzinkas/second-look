import { claimItems, locateClaims } from '@second-look/engine';
import type { Claim, Part, ReviewResult } from '@second-look/engine';
import type { EvidenceSource, ExpectedClaim, Verdict } from './case.js';

/**
 * The claims a review reports and the fetches it offers, as the reviewer
 * sees them — the reviewer-facing half of the claim checks. The agent
 * lists claims and judges them, but the plain pass lists none and no
 * library fetch is offered yet, so the checks of a verdict fail exactly
 * as the baseline records; these types and readers are the seam the
 * checks flow through, unchanged.
 */

/**
 * A library fetch the companion offered while checking one claim: the
 * download of one library's source at the version the project pins,
 * offered with its reason only when the claim cannot be checked without
 * it (ADR 0003).
 */
export interface LibraryFetchOffer {
  /** The library the fetch would download, as the project pins it. */
  library: string;
  /** The version the project pins, which the fetch downloads. */
  pinnedVersion: string;
  /** The companion's one-line reason for needing the library's source. */
  reason: string;
}

/** One claim a review reports about how the code or a library behaves. */
export interface ReportedClaim {
  /** The claim's text, exactly as the change states it. */
  text: string;
  /** The claim's verdict, with the evidence that proves it; absent until checked. */
  verdict?: {
    kind: Verdict;
    evidence?: { file: string; line: number; source: EvidenceSource };
  };
  /** The library fetch the companion offered to check this claim. */
  fetchOffer?: LibraryFetchOffer;
}

/** One claim as the reviewer ends up seeing it, after any fetch press. */
export interface PressedClaim extends ReportedClaim {
  /** The fetch offer the reviewer pressed for this claim; none when there was nothing to press. */
  pressedFetch?: LibraryFetchOffer;
}

/**
 * The claims a review result reports, each by its quote, with its verdict
 * and its first citation as the evidence. A result without the agent's
 * claims, such as the plain pass's, reports none; a claim not checked yet
 * reports no verdict, since a verdict to compare is one a check gave.
 */
export function reportedClaims(result: ReviewResult): ReportedClaim[] {
  return (result.claims?.claims ?? []).map((claim) => {
    const { verdict } = claim;
    if (verdict.kind === 'not checked') return { text: claim.quote };
    const [first] = verdict.evidence;
    const evidence = first === undefined ? {} : { evidence: { file: first.path, line: first.line, source: verdict.source } };
    return { text: claim.quote, verdict: { kind: verdict.kind, ...evidence } };
  });
}

/**
 * The hand-labelled claims a case gives a verdict, each located in the
 * change as the claims pass would list it — a file's quote by its line, a
 * description's on the first part — so the verdicts prompt is judged on
 * the claims a reviewer listed, not on what the claims prompt found.
 * Throws when a hand-listed quote is not where the case says.
 */
export function labelledClaims(
  parts: readonly Part[],
  description: string,
  expected: readonly ExpectedClaim[],
): { wanted: ExpectedClaim; claim: Claim }[] {
  const context = { items: claimItems(parts), description };
  return expected.flatMap((wanted) => {
    if (wanted.verdict === undefined) return [];
    const inFile = 'file' in wanted.origin ? wanted.origin : undefined;
    const answered = {
      source: inFile ? ('docstring' as const) : ('description' as const),
      quote: wanted.text,
      file: inFile?.file ?? null,
      line: inFile?.line ?? null,
      part: inFile ? null : 'p1',
    };
    const { claims, problems } = locateClaims(context, { claims: [answered] });
    if (problems.length > 0) throw new Error(`a hand-labelled claim is not where its case says: ${problems.join('; ')}`);
    return [{ wanted, claim: claims[0]! }];
  });
}

/**
 * Simulates the reviewer pressing every library fetch the review offered.
 * A fetch is a download the reviewer starts, never the companion (ADR
 * 0003), so the evaluation, standing in for the reviewer, presses each
 * offer the review brought back; only what a press unlocked counts as
 * evidence in the tally. Nothing is offered yet, so there is nothing to
 * press and the checks of a fetch stay failing until there is.
 */
export function pressFetches(claims: readonly ReportedClaim[]): PressedClaim[] {
  return claims.map((claim) => ({
    ...claim,
    pressedFetch: claim.fetchOffer ? { ...claim.fetchOffer } : undefined,
  }));
}
