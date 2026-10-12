import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentRunRequest } from '../src/agent.js';
import { removeCopy } from '../src/cache.js';
import { carryClaims, carryParts, rankCarried, type EarlierReview } from '../src/carry-over.js';
import { CLAIMS_INSTRUCTIONS } from '../src/claims.js';
import { parseDiff } from '../src/diff.js';
import { fileSlice } from '../src/parts.js';
import type { Claim, Part, PartSignals, ReviewResult } from '../src/protocol.js';
import { fetchChange, reviewChange, type ReviewInput } from '../src/review.js';
import { STORY_INSTRUCTIONS } from '../src/story.js';
import { VERDICTS_INSTRUCTIONS } from '../src/verdicts.js';
import { PR_7_URL, answeringAgent, fixtureFetch, pull7, temporaryCacheDir } from './helpers.js';

/** A diff of one file with two hunks, the first adding `added` lines more than it removes, so the second sits that much lower. */
function twoHunks(first: string, added = 0): string {
  const extra = Array.from({ length: added }, (_, index) => `+extra ${index}`);
  return [
    'diff --git a/app/f.py b/app/f.py',
    'index 1111111..2222222 100644',
    '--- a/app/f.py',
    '+++ b/app/f.py',
    `@@ -1,3 +1,${3 + added} @@`,
    ' a',
    '-b',
    `+${first}`,
    ...extra,
    ' c',
    `@@ -20,3 +${20 + added},3 @@`,
    ' t',
    '-u',
    '+U',
    ' v',
    '',
  ].join('\n');
}

/** A diff of one file whose two hunks change the same lines, as the same block added in two entities. */
function identicalHunks(): string {
  return [
    'diff --git a/app/f.py b/app/f.py',
    'index 1111111..2222222 100644',
    '--- a/app/f.py',
    '+++ b/app/f.py',
    '@@ -1,3 +1,3 @@',
    ' a',
    '-b',
    '+X',
    ' c',
    '@@ -20,3 +20,3 @@',
    ' t',
    '-b',
    '+X',
    ' v',
    '',
  ].join('\n');
}

describe('carryParts', () => {
  // An earlier review that split the file's two hunks into two parts, as the grouping agent may.
  const [earlierFile] = parseDiff(twoHunks('B')).files;
  const earlier: Part[] = earlierFile!.hunks.map((hunk, index) => ({
    ...fileSlice(earlierFile!, [hunk]),
    name: index === 0 ? 'the first edit' : 'the second edit',
    origin: 'agent',
    rank: { importance: 'must review', reason: 'agent says so', signals: [] },
  }));

  // Two earlier parts of identical pieces, as the grouping agent splits the same block added in two entities.
  const [sameFile] = parseDiff(identicalHunks()).files;
  const samePieces: Part[] = sameFile!.hunks.map((hunk, index) => ({
    ...fileSlice(sameFile!, [hunk]),
    name: index === 0 ? 'the first edit' : 'the second edit',
    origin: 'agent',
    rank: index === 0 ? { importance: 'must review', reason: 'agent says so', signals: [] } : { importance: 'context', reason: 'agent says otherwise', signals: [] },
  }));

  it('carries a part whose code did not change, on the hunks of the change now, and groups the rest plainly', () => {
    const files = parseDiff(twoHunks('B again', 3)).files;
    const { parts, leftover } = carryParts(earlier, files);

    expect(parts).toHaveLength(2);
    const [carried, fresh] = parts;
    expect(carried).toMatchObject({ name: 'the second edit', origin: 'agent', rank: { importance: 'must review' }, carried: true });
    // Its line numbers are today's: three lines lower.
    expect(carried!.hunks.map((hunk) => hunk.newStart)).toEqual([23]);
    expect(fresh).toMatchObject({ origin: 'plain' });
    expect(fresh).not.toHaveProperty('carried');
    expect(fresh!.hunks[0]!.lines.map((line) => line.text)).toContain('B again');
    expect(leftover.map((file) => file.hunks.length)).toEqual([1]);
  });

  it('carries every part of a change whose code is as the earlier review read it, leaving nothing over', () => {
    const { parts, leftover } = carryParts(earlier, parseDiff(twoHunks('B')).files);
    expect(parts.map((part) => [part.name, part.carried])).toEqual([
      ['the first edit', true],
      ['the second edit', true],
    ]);
    expect(leftover).toEqual([]);
  });

  it('keeps each of two carried parts of identical pieces the rank the earlier review gave it', () => {
    const { parts } = carryParts(samePieces, parseDiff(identicalHunks()).files);
    const signals: PartSignals = { novelty: 'changed', role: 'code', changedLines: 2, publicSurface: [], references: { basis: 'name-based', names: [], files: 0 } };
    expect(rankCarried(parts.map((part) => ({ ...part, signals }))).map((part) => [part.name, part.rank!.importance])).toEqual([
      ['the first edit', 'must review'],
      ['the second edit', 'context'],
    ]);
  });

  it('carries each of two earlier parts of identical pieces its own claims, each to its own part', () => {
    const { parts } = carryParts(samePieces, parseDiff(identicalHunks()).files);
    const claim = (part: number): Claim => ({
      quote: `the ${part === 0 ? 'first' : 'second'} edit is sound`,
      source: 'agent',
      location: { kind: 'story', sentence: 0 },
      part,
      verdict: { kind: 'not checked' },
    });
    const result = { parts: samePieces, claims: { claims: [claim(0), claim(1)] } } as unknown as ReviewResult;

    expect(carryClaims(result, parts, () => true)).toEqual([
      { ...claim(0), part: 0, carried: true },
      { ...claim(1), part: 1, carried: true },
    ]);
  });

  it('moves a carried claim in a file with the hunk that holds it, and drops the claims of a part that changed', () => {
    const { parts } = carryParts(earlier, parseDiff(twoHunks('B again', 3)).files);
    const claim = (part: number, line: number): Claim => ({
      quote: 'U is upper case',
      source: 'comment',
      location: { kind: 'file', path: 'app/f.py', line, endLine: line },
      part,
      verdict: { kind: 'verified', source: 'the change itself', reason: 'It is.', evidence: [] },
    });
    const result = { parts: earlier, claims: { claims: [claim(0, 2), claim(1, 21)] } } as unknown as ReviewResult;

    expect(carryClaims(result, parts, () => true)).toEqual([{ ...claim(0, 24), carried: true }]);
  });
});

describe('reviewChange carrying results over from the saved review of an earlier commit', () => {
  const FLAG = 'moves the flag out of the discount block';
  const GREETER = 'restyles Greeter';
  const CART = 'taxes the cart total';
  const NEW_HEAD = '8888888888888888888888888888888888888888';
  const STAMP = { reviewedAt: '2026-10-01T00:00:00.000Z', agent: { agent: 'fake', model: null, effort: null } };

  let cacheDir: string;
  let headDir: string;

  beforeEach(() => {
    cacheDir = temporaryCacheDir();
    headDir = mkdtempSync(join(tmpdir(), 'second-look-head-'));
  });

  afterEach(async () => {
    await removeCopy(cacheDir);
    rmSync(headDir, { recursive: true, force: true });
  });

  /** A part's id in a claims prompt, by a path its name holds. */
  function partId(prompt: string, path: string): string {
    const item = [...prompt.matchAll(/^\[(p\d+)\]\n<untrusted-input [^\n]*\nname: ([^\n]*)$/gm)].find((match) => match[2]!.includes(path));
    return item![1]!;
  }

  /**
   * Lists the description's three claims, each about its part, and
   * verifies every claim it is asked to judge: the flag's from the
   * dedent, every other from the cart; `story` answers the story prompt,
   * and without it the story falls back.
   */
  function claimingAgent(story?: (prompt: string) => unknown) {
    return answeringAgent((run: AgentRunRequest) => {
      if (run.instructions === STORY_INSTRUCTIONS) return story?.(run.prompt) ?? {};
      if (run.instructions === CLAIMS_INSTRUCTIONS) {
        const claim = (quote: string, path: string) => ({ source: 'description', quote, file: null, line: null, part: partId(run.prompt, path) });
        return { claims: [claim(FLAG, 'app/dedent.py'), claim(GREETER, 'src/Greeter.cs'), claim(CART, 'web/cart.ts')] };
      }
      if (run.instructions === VERDICTS_INSTRUCTIONS) {
        const asked = [...run.prompt.matchAll(/^\[(c\d+)\] made in [^\n]*\n<untrusted-input [^\n]*>\n([^\n]*)$/gm)];
        const verdicts = asked.map(([, id, quote]) => ({
          id,
          verdict: 'verified',
          source: 'the change itself',
          reason: 'The line shows it.',
          evidence: [quote === FLAG ? { file: 'app/dedent.py', line: 4, quote: 'order.flag = True' } : { file: 'web/cart.ts', line: 1, quote: 'export class Cart {' }],
          library: null,
        }));
        return { verdicts };
      }
      return {};
    });
  }

  /** The judged claims' quotes in a run's verdicts prompt. */
  const judgedQuotes = (runs: AgentRunRequest[]) =>
    runs.filter((run) => run.instructions === VERDICTS_INSTRUCTIONS).flatMap((run) => [...run.prompt.matchAll(/^\[c\d+\] made in [^\n]*\n<untrusted-input [^\n]*>\n([^\n]*)$/gm)].map((match) => match[1]));

  /** Pull request 7 reviewed with the agent, then the same pull request at a new head commit whose diff and head copy of `path` `edit` changes. */
  async function reviewTwice(edit: (text: string) => string, path = 'web/cart.ts', agent = claimingAgent()) {
    const input = await fetchChange(PR_7_URL, { token: 'test-token', fetch: fixtureFetch(pull7()).fetch, cacheDir });
    const first = claimingAgent();
    const earlier = await reviewChange(input, { adapter: first });
    cpSync(fileURLToPath(new URL('./fixtures/pull-7/head', import.meta.url)), headDir, { recursive: true });
    const edited = join(headDir, path);
    writeFileSync(edited, edit(readFileSync(edited, 'utf8')));
    const later: ReviewInput = {
      ...input,
      pullRequest: { ...input.pullRequest, headSha: NEW_HEAD },
      diff: edit(input.diff),
      copies: { base: input.copies.base, head: { commit: NEW_HEAD, path: headDir, reused: false } },
      earlier: { result: earlier, stamp: STAMP } satisfies EarlierReview,
    };
    const result = await reviewChange(later, { adapter: agent });
    return { earlier, result, runs: agent.requests };
  }

  const states = (result: ReviewResult) => Object.fromEntries(result.stages!.map((stage) => [stage.id, stage.state]));
  const claimOf = (result: ReviewResult, quote: string) => result.claims!.claims.find((claim) => claim.quote === quote)!;

  it('runs the agent again only for the changed part and the passes it affects, carrying the rest over, labelled', async () => {
    const { earlier, result, runs } = await reviewTwice((text) => text.replace('* 1.2;', '* 1.25;'));

    expect(result.carriedOver).toEqual({ commit: earlier.pullRequest.headSha, ...STAMP });
    const changed = result.parts.filter((part) => !part.carried).map((part) => part.path);
    expect(changed).toEqual(['web/cart.ts']);
    expect(result.parts.filter((part) => part.carried)).toHaveLength(earlier.parts.length - 1);
    expect(states(result)).toMatchObject({
      plain: 'done',
      grouping: 'carried over',
      ranking: 'carried over',
      story: 'fell back',
      claims: 'done',
      verdicts: 'done',
    });
    expect(result.stages!.find((stage) => stage.id === 'grouping')!.detail).toBe(
      `its input did not change since the review of ${earlier.pullRequest.headSha.slice(0, 7)}, whose result of it was kept`,
    );

    // The flag's verdict cites a file no new commit touched, so it is carried over as it stood.
    expect(claimOf(result, FLAG)).toMatchObject({ carried: true, verdict: { kind: 'verified', evidence: [{ path: 'app/dedent.py', line: 4 }] } });
    // The cart's part changed, so its claim is listed and judged afresh;
    // Greeter's part did not, but its verdict cites the cart, so it is judged again.
    expect(claimOf(result, CART)).not.toHaveProperty('carried');
    expect(claimOf(result, GREETER)).not.toHaveProperty('carried');
    expect(judgedQuotes(runs).sort()).toEqual([CART, GREETER].sort());
    expect(claimOf(result, GREETER).verdict.kind).toBe('verified');
  });

  it('carries the claims and their verdicts over whole when the new commits change no line of the change and none a verdict cites', async () => {
    // As a rebase onto a base that changed another file only.
    const { earlier, result, runs } = await reviewTwice((text) => `${text}// rebased\n`, 'web/checkout.ts');

    expect(result.parts.every((part) => part.carried)).toBe(true);
    expect(states(result)).toMatchObject({ grouping: 'carried over', ranking: 'carried over', claims: 'carried over', verdicts: 'carried over' });
    expect(result.claims!.claims.map((claim) => [claim.quote, claim.carried])).toEqual(earlier.claims!.claims.map((claim) => [claim.quote, true]));
    expect(result.claims!.judging).toEqual(earlier.claims!.judging);
    expect(runs.some((run) => run.instructions === CLAIMS_INSTRUCTIONS || run.instructions === VERDICTS_INSTRUCTIONS)).toBe(false);
  });

  it('lists the claims again when a story is written again, never carrying the earlier claims over whole', async () => {
    // As a rebase onto a base that changed another file only; the first review's story fell back, so the second writes one afresh.
    const story = (prompt: string) => ({
      sentences: [`The change reads as follows: ${[...prompt.matchAll(/^\[(p\d+)\] /gm)].map((match, at) => `[part ${at + 1}](${match[1]})`).join(', ')}.`],
    });
    const { result, runs } = await reviewTwice((text) => `${text}// rebased\n`, 'web/checkout.ts', claimingAgent(story));

    expect(states(result)).toMatchObject({ story: 'done', claims: 'done' });
    expect(runs.some((run) => run.instructions === CLAIMS_INSTRUCTIONS)).toBe(true);
  });

  it('re-checks a carried verdict that cites a line the new commits changed, never showing it as current', async () => {
    const { result, runs } = await reviewTwice((text) => text.replace('export class Cart {', 'export class Basket {'));

    // The cited line changed, so the quote no longer holds: judged again, the re-check drops it from verified.
    expect(claimOf(result, GREETER)).not.toHaveProperty('carried');
    expect(claimOf(result, GREETER).verdict.kind).toBe('unverifiable');
    expect(judgedQuotes(runs)).toContain(GREETER);
    expect(claimOf(result, FLAG)).toMatchObject({ carried: true, verdict: { kind: 'verified' } });
  });
});
