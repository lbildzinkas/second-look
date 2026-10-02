import type { ReviewResult } from '@second-look/engine';
import type { EvidenceSource, Verdict } from './case.js';

/**
 * The claims a review reports and the fetches it offers, as the reviewer
 * sees them — the reviewer-facing half of the claim checks. The engine
 * does not find or check claims yet, so a review result today reports
 * none and every claim check fails, exactly as the baseline records;
 * when the result grows claims, these types and readers are the seam the
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
 * The claims a review result reports. The engine's result carries no
 * claims yet — the claim steps have not landed — so the field is read
 * without being required and a result today reports none; the reader is
 * what starts handing real claims to the checks once the result grows
 * them.
 */
export function reportedClaims(result: ReviewResult): ReportedClaim[] {
  const reported = (result as { claims?: unknown }).claims;
  if (!Array.isArray(reported)) return [];
  return reported.filter((claim): claim is ReportedClaim => {
    const candidate = claim as Partial<ReportedClaim>;
    return typeof candidate.text === 'string' && candidate.text !== '';
  });
}

/**
 * Simulates the reviewer pressing every library fetch the review offered.
 * A fetch is a download the reviewer starts, never the companion (ADR
 * 0003), so the evaluation, standing in for the reviewer, presses each
 * offer the review brought back; only what a press unlocked counts as
 * evidence in the tally. Nothing is offered yet, so there is nothing to
 * press and the claim checks stay failing until there is.
 */
export function pressFetches(claims: readonly ReportedClaim[]): PressedClaim[] {
  return claims.map((claim) => ({
    ...claim,
    pressedFetch: claim.fetchOffer ? { ...claim.fetchOffer } : undefined,
  }));
}
