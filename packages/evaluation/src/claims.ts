import { claimItems, locateClaims } from '@second-look/engine';
import type { Claim, Part, ReviewResult } from '@second-look/engine';
import type { EvidenceSource, ExpectedClaim, Verdict } from './case.js';

/**
 * The claims a review reports and the fetches it offers, as the reviewer
 * sees them — the reviewer-facing half of the claim checks. The agent
 * lists claims and judges them, and a verdict that needs a pinned
 * library's source offers its library fetch; the plain pass lists none,
 * so its checks of a verdict fail exactly as the baseline records. These
 * types and readers are the seam the checks flow through.
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
 * claims, such as the plain pass's, reports none; see {@link reportClaims}.
 */
export function reportedClaims(result: ReviewResult): PressedClaim[] {
  return reportClaims(result.claims?.claims ?? []);
}

/**
 * Claims as the reviewer sees them, each by its quote, with its verdict
 * and its first citation as the evidence, the library fetch its verdict
 * offers, and — once the fetch was pressed and the claim judged against
 * the library's source — that pressed offer. A claim not checked yet
 * reports no verdict, since a verdict to compare is one a check gave.
 */
export function reportClaims(claims: readonly Claim[]): PressedClaim[] {
  return claims.map((claim) => {
    const { verdict } = claim;
    if (verdict.kind === 'not checked') return { text: claim.quote };
    const [first] = verdict.evidence;
    const evidence = first === undefined ? {} : { evidence: { file: first.path, line: first.line, source: verdict.source } };
    const offer = verdict.libraryFetch;
    return {
      text: claim.quote,
      verdict: { kind: verdict.kind, ...evidence },
      ...(offer ? { fetchOffer: offer } : {}),
      ...(offer && verdict.library ? { pressedFetch: offer } : {}),
    };
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
