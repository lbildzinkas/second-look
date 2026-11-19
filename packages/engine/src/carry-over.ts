import { changePieces } from './last-look.js';
import { fileSlice, filesOfPart, groupParts } from './parts.js';
import {
  CLAIM_SOURCE_ORDER,
  IMPORTANCE_ORDER,
  type CarriedOver,
  type Claim,
  type ClaimVerdict,
  type Criteria,
  type Part,
  type ReviewResult,
  type Story,
  type UnexplainedChanges,
} from './protocol.js';
import { rankParts, sinksPart } from './rank.js';
import type { SavedStamp } from './saved-review.js';
import { CITED_SPAN, copyReader } from './verdicts.js';

/** The saved review of an earlier commit a review carries results over from, with who produced it. */
export interface EarlierReview {
  result: ReviewResult;
  stamp: SavedStamp;
}

/** The label of a review that carried results over from the earlier one: its commit, and when and by whom it was produced. */
export function carriedOverLabel(earlier: EarlierReview): CarriedOver {
  return { commit: earlier.result.pullRequest.headSha, ...earlier.stamp };
}

/** A part's key: its pieces as the comparison with an earlier change reads them, the same for a carried part and the earlier part it came from. */
function partKey(part: Part): string {
  return changePieces(part).join('\n');
}

/** The parts of the change now, and the files of the hunks no earlier part holds. */
export interface CarriedParts {
  /** The earlier parts the change now still holds, rebuilt on its hunks and marked carried, then the plain parts of every other hunk. */
  parts: Part[];
  /** The files of the hunks no earlier part holds, each with just those hunks, for the grouping agent. */
  leftover: Part[];
}

/**
 * Carries the earlier review's parts over to the change now: an earlier
 * part whose every piece — each hunk's changed lines, or a file without
 * hunks — the change now still holds keeps its name, origin and rank,
 * rebuilt on the change's own hunks so its line numbers are today's, and
 * is marked carried. Every other hunk is grouped plainly.
 */
export function carryParts(earlier: readonly Part[], files: readonly Part[]): CarriedParts {
  // Every piece of the change now, by its hash: its file, and its hunk, or -1 for a file without hunks.
  const spots = new Map<string, { file: number; hunk: number }[]>();
  files.forEach((file, index) =>
    changePieces(file).forEach((piece, hunk) => spots.set(piece, [...(spots.get(piece) ?? []), { file: index, hunk: file.hunks.length === 0 ? -1 : hunk }])),
  );
  const used = files.map(() => new Set<number>());
  const carried = earlier.flatMap((part): Part[] => {
    const taken: { file: number; hunk: number }[] = [];
    for (const piece of changePieces(part)) {
      const spot = spots.get(piece)?.find((each) => !used[each.file]!.has(each.hunk) && !taken.includes(each));
      if (spot === undefined) return [];
      taken.push(spot);
    }
    for (const spot of taken) used[spot.file]!.add(spot.hunk);
    let at = 0;
    const [first, ...others] = filesOfPart(part).map((slice) => {
      const mine = taken.slice(at, (at += Math.max(slice.hunks.length, 1)));
      const file = files[mine[0]!.file]!;
      return fileSlice(file, slice.hunks.length === 0 ? [] : mine.map((spot) => file.hunks[spot.hunk]!));
    });
    const { name, origin, rank } = part;
    return [{ ...first!, ...(others.length > 0 ? { otherFiles: others } : {}), ...(name ? { name } : {}), ...(origin ? { origin } : {}), ...(rank ? { rank } : {}), carried: true }];
  });
  const leftover = files.flatMap((file, index): Part[] => {
    const mine = used[index]!;
    if (file.hunks.length === 0) return mine.has(-1) ? [] : [file];
    const hunks = file.hunks.filter((_, hunk) => !mine.has(hunk));
    return hunks.length === 0 ? [] : [fileSlice(file, hunks)];
  });
  return { parts: [...carried, ...groupParts(leftover)], leftover };
}

/** The parts in ranking's order: by importance, keeping their order within it, the sinking noise last. */
export function byImportance(parts: readonly Part[]): Part[] {
  const level = (part: Part): number => (sinksPart(part) || part.rank === undefined ? IMPORTANCE_ORDER.length : IMPORTANCE_ORDER.indexOf(part.rank.importance));
  return [...parts].sort((a, b) => level(a) - level(b));
}

/**
 * Ranks parts whose signals are set plainly, a carried part keeping the
 * rank the earlier review gave it — two of identical pieces each their
 * own — in ranking's order.
 */
export function rankCarried(parts: readonly Part[]): Part[] {
  const keeps = (part: Part): boolean => part.carried === true && part.rank !== undefined;
  return byImportance([...parts.filter(keeps), ...rankParts(parts.filter((part) => !keeps(part)))]);
}

/** Whether the change now holds every earlier part carried over, and nothing else: its code is as the earlier review read it. */
export function sameChange(parts: readonly Part[], earlier: readonly Part[]): boolean {
  return parts.length === earlier.length && parts.every((part) => part.carried);
}

/** Each carried part's index now, by its index in the earlier review's parts, two of identical pieces pairing by their order. */
export function nowIndexes(parts: readonly Part[], earlier: readonly Part[]): Map<number, number> {
  // Each key's carried indexes now, in their order: the nth of a key pairs with the nth earlier part of that key.
  const now = new Map<string, number[]>();
  parts.forEach((part, index) => {
    if (part.carried !== true) return;
    const key = partKey(part);
    now.set(key, [...(now.get(key) ?? []), index]);
  });
  const seen = new Map<string, number>();
  return new Map(
    earlier.flatMap((part, index): [number, number][] => {
      const key = partKey(part);
      const nth = seen.get(key) ?? 0;
      seen.set(key, nth + 1);
      const at = now.get(key)?.[nth];
      return at === undefined ? [] : [[index, at]];
    }),
  );
}

/** The story with each part it links at its index now; for a change whose every part carried over. */
export function movedStory(story: Story, now: Map<number, number>): Story {
  const sentences = story.sentences.map(({ segments }) => ({ segments: segments.map((segment) => (segment.part === undefined ? segment : { ...segment, part: now.get(segment.part)! })) }));
  return { ...story, sentences };
}

/** The unexplained changes with each part at its index now, in the parts' order; for a change whose every part carried over. */
export function movedUnexplained(unexplained: UnexplainedChanges, now: Map<number, number>): UnexplainedChanges {
  return { ...unexplained, parts: unexplained.parts.map((each) => ({ ...each, part: now.get(each.part)! })).sort((a, b) => a.part - b.part) };
}

/** A head-side line of a carried part, moved as the hunk holding it moved since the earlier review; undefined when no hunk of the earlier part holds it. */
function movedLine(was: Part, now: Part, path: string, line: number): number | undefined {
  const files = filesOfPart(now);
  for (const [index, file] of filesOfPart(was).entries()) {
    if (file.path !== path) continue;
    const at = file.hunks.findIndex((hunk) => line >= hunk.newStart && line < hunk.newStart + Math.max(hunk.newLines, 1));
    if (at >= 0) return line + files[index]!.hunks[at]!.newStart - file.hunks[at]!.newStart;
  }
  return undefined;
}

/**
 * The earlier review's claims that carry over: each claim `keep` accepts
 * that is attached to a part carried now, re-attached to it, a claim in
 * a file moved as its hunk moved, and marked carried with its verdict as
 * it stood; never a pipeline report's, which the review reads again.
 */
export function carryClaims(earlier: ReviewResult, parts: readonly Part[], keep: (claim: Claim) => boolean): Claim[] {
  const now = nowIndexes(parts, earlier.parts);
  return (earlier.claims?.claims ?? []).flatMap((claim): Claim[] => {
    const part = now.get(claim.part);
    if (part === undefined || claim.source === 'pipeline' || !keep(claim)) return [];
    const { location } = claim;
    if (location.kind !== 'file') return [{ ...claim, part, carried: true }];
    const line = movedLine(earlier.parts[claim.part]!, parts[part]!, location.path, location.line);
    if (line === undefined) return [];
    return [{ ...claim, part, location: { ...location, line, endLine: location.endLine + line - location.line }, carried: true }];
  });
}

/** Claims from several lists in their sources' priority order, keeping each list's order within a source. */
export function mergeClaims(...lists: readonly (readonly Claim[])[]): Claim[] {
  return lists.flat().sort((a, b) => CLAIM_SOURCE_ORDER.indexOf(a.source) - CLAIM_SOURCE_ORDER.indexOf(b.source));
}


/** Tells whether a cited line of a file is as it was, with every line above it, so it still sits where it did. */
export type SameLine = (path: string, line: number) => Promise<boolean>;

/**
 * Tells whether a line of the head copy now, and the lines a citation
 * starting on it may run over, are as they were in the earlier head
 * copy, with every line above them, so a citation of it still points
 * where it did; a file missing from either copy never is.
 */
export function sameLines(earlierRoot: string, nowRoot: string): SameLine {
  const [before, after] = [copyReader(earlierRoot), copyReader(nowRoot)];
  return async (path, line) => {
    const [was, is] = await Promise.all([before(path), after(path)]);
    if (was === undefined || is === undefined) return false;
    const end = line - 1 + CITED_SPAN;
    return was.slice(0, end).join('\n') === is.slice(0, end).join('\n');
  };
}

/**
 * Whether a carried verdict still stands: it is checked, and every line
 * its evidence cites is one the new commits left as it was, see
 * {@link sameLines}, or a line of the library source it was judged
 * against. A CI log's line is of the earlier commit's checks, so a
 * verdict citing one never stands, and nor does one judged again with the
 * passing checks' logs the reviewer pressed to read.
 */
export async function verdictHolds(verdict: ClaimVerdict, same: SameLine): Promise<boolean> {
  if (verdict.kind === 'not checked' || verdict.ciLogs !== undefined) return false;
  if (verdict.library !== undefined) return true;
  return (await Promise.all(verdict.evidence.map((citation) => !citation.ciLog && same(citation.path, citation.line)))).every(Boolean);
}

/**
 * The claims with each carried one whose verdict no longer stands, see
 * {@link verdictHolds}, back to not checked and no longer carried or
 * asked, so it is judged again and never shown as current.
 */
export async function standingClaims(claims: readonly Claim[], same: SameLine): Promise<Claim[]> {
  return Promise.all(
    claims.map(async (claim): Promise<Claim> => {
      if (!claim.carried || (await verdictHolds(claim.verdict, same))) return claim;
      const { carried: _carried, asked: _asked, ...rest } = claim;
      return { ...rest, verdict: { kind: 'not checked' } };
    }),
  );
}

/** Whether every line a mapped criterion's code and tests cite is one the new commits left as it was. */
export async function criteriaHold(criteria: Criteria, same: SameLine): Promise<boolean> {
  const cited = criteria.criteria.flatMap(({ verdict }) => (verdict.kind === 'not checked' ? [] : [...verdict.code, ...verdict.tests]));
  return (await Promise.all(cited.map((citation) => same(citation.path, citation.line)))).every(Boolean);
}

/**
 * The earlier review's documentation links on the result, when the
 * change is as the earlier review read it, the agent's suggestions did
 * not fall back, and every line they use is one the new commits left as
 * it was; undefined otherwise.
 */
export async function carriedDocLinks(shown: ReviewResult, earlier: ReviewResult): Promise<ReviewResult | undefined> {
  const links = earlier.docLinks;
  if (links === undefined || links.suggestions?.outcome === 'fell back' || !sameChange(shown.parts, earlier.parts)) return undefined;
  const same = sameLines(earlier.copies.head.path, shown.copies.head.path);
  const uses = [...links.links, ...links.unlinked].flatMap((api) => api.uses);
  return (await Promise.all(uses.map((use) => same(use.path, use.line)))).every(Boolean) ? { ...shown, docLinks: links } : undefined;
}
