import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GROUPING_INSTRUCTIONS, GROUPING_PROMPT_VERSION } from '../../engine/src/grouping.js';
import { RANKING_INSTRUCTIONS, RANKING_PROMPT_VERSION } from '../../engine/src/ranking.js';
import { STORY_INSTRUCTIONS, STORY_PROMPT_VERSION } from '../../engine/src/story.js';
import { CLAIMS_INSTRUCTIONS, CLAIMS_PROMPT_VERSION } from '../../engine/src/claims.js';
import { answeringAgent, offeredParts, scriptedAgent } from '../../engine/test/helpers.js';
import type { AgentAdapter } from '@second-look/engine';
import { loadCases } from '../src/case.js';
import { loadRegistry } from '../src/prompts.js';
import { ALL_CASES, NO_AGENT, TRACE_FILE, belowFullCoverage, runEvaluation } from '../src/run.js';
import type { AgentCall, ResultRow } from '../src/run.js';

const PACKAGE = fileURLToPath(new URL('..', import.meta.url));

/** example-7's hunks grouped exactly as its hand labels group them. */
const LABELLED_ANSWER = JSON.stringify({
  parts: [
    { name: 'fresh, with its test', hunks: ['h2', 'h7'] },
    { name: 'load, Store and Greeter restyled', hunks: ['h3', 'h5'] },
    { name: 'apply_discount', hunks: ['h1'] },
    { name: 'Cart.total', hunks: ['h6'] },
    { name: 'deploy', hunks: ['h4'] },
  ],
});

/** example-7's known important parts, as its expected.json names them. */
const IMPORTANT = ['Cart.total in web/cart.ts', 'apply_discount in app/dedent.py'];

/**
 * A ranking of the offered parts: the known important parts first, or
 * last, as must review and context; every reason cites the part's size.
 */
function rankingOf(prompt: string, important: 'first' | 'last'): unknown {
  const offered = offeredParts(prompt);
  const known = offered.filter((part) => IMPORTANT.includes(part.name));
  const others = offered.filter((part) => !IMPORTANT.includes(part.name));
  const entry = (id: string, importance: string) => ({ part: id, importance, reason: 'its size', signals: ['size'] });
  const parts =
    important === 'first'
      ? [...known.map((part) => entry(part.id, 'must review')), ...others.map((part) => entry(part.id, 'context'))]
      : [...others.map((part) => entry(part.id, 'worth reviewing')), ...known.map((part) => entry(part.id, 'context'))];
  return { parts };
}

/** An agent that groups example-7 as its labels do and ranks its plain parts with the important ones first or last. */
function labellingAgent(important: 'first' | 'last' = 'first'): AgentAdapter {
  return answeringAgent((request) =>
    request.instructions === GROUPING_INSTRUCTIONS ? JSON.parse(LABELLED_ANSWER) : rankingOf(request.prompt, important),
  );
}

let runs: string;

beforeEach(() => {
  runs = mkdtempSync(join(tmpdir(), 'second-look-eval-runs-'));
});

afterEach(() => {
  rmSync(runs, { recursive: true, force: true });
});

/** Runs example-7 and example-42, the agent running the given prompts — the grouping and ranking prompts unless named — or every prompt. */
async function run(answers: string[], adapter: AgentAdapter = scriptedAgent(answers), prompts: readonly string[] | 'every' = ['grouping', 'ranking']) {
  const all = await loadCases([join(PACKAGE, 'cases')]);
  const cases = all.filter((each) => each.id === 'example-7' || each.id === 'example-42');
  return runEvaluation({
    cases,
    registry: await loadRegistry(join(PACKAGE, 'prompts.json')),
    companionVersion: '0.1.0',
    runsFolder: runs,
    now: new Date('2026-10-02T00:00:00.000Z'),
    agent: { adapter },
    ...(prompts === 'every' ? {} : { prompts }),
  });
}

function rowsOf(rows: readonly ResultRow[], agent: string, name: string): Record<string, number> {
  return Object.fromEntries(
    rows.filter((row) => row.agent === agent && row.name === name).map((row) => [row.case, row.value]),
  );
}

describe('runEvaluation with an agent', () => {
  it("scores the grouping prompt's cases with the agent too, stamped with who answered, and traces each call", async () => {
    const { folder, results } = await run([], labellingAgent());

    // The plain pass scores every case; the agent only the cases tied to its prompt.
    expect(rowsOf(results.rows, NO_AGENT, 'coverage')).toEqual({ 'example-42': 1, 'example-7': 1, [ALL_CASES]: 1 });
    expect(rowsOf(results.rows, 'fake', 'coverage')).toEqual({ 'example-7': 1, [ALL_CASES]: 1 });
    expect(rowsOf(results.rows, 'fake', 'grouping-agreement')).toEqual({ 'example-7': 1, [ALL_CASES]: 1 });
    expect(rowsOf(results.rows, NO_AGENT, 'grouping-agreement')['example-7']).toBeLessThan(1);
    const agentRows = results.rows.filter((row) => row.agent === 'fake' && row.case !== ALL_CASES);
    expect(agentRows.map((row) => row.name).sort()).toEqual(['coverage', 'grouping-agreement', 'rank-median', 'rank-top-3']);
    for (const row of agentRows) {
      expect(row).toMatchObject({
        agentVersion: '1.2.3',
        model: 'fake/model',
        effort: 'default',
        promptVersions: { grouping: GROUPING_PROMPT_VERSION, ranking: RANKING_PROMPT_VERSION, story: STORY_PROMPT_VERSION },
      });
    }
    expect(results.fallbacks).toEqual([]);

    const trace = readFileSync(join(folder, TRACE_FILE), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as AgentCall);
    expect(trace).toHaveLength(2);
    expect(trace[1]).toMatchObject({ case: 'example-7', prompt: 'ranking', promptVersion: RANKING_PROMPT_VERSION });
    expect(trace[1]!.input.startsWith(RANKING_INSTRUCTIONS)).toBe(true);
    expect(trace[0]).toMatchObject({
      case: 'example-7',
      prompt: 'grouping',
      promptVersion: GROUPING_PROMPT_VERSION,
      agent: 'fake',
      model: 'fake/model',
      output: JSON.stringify(JSON.parse(LABELLED_ANSWER)),
    });
    expect(trace[0]!.input.startsWith(GROUPING_INSTRUCTIONS)).toBe(true);
  });

  it('records a fallback when the answer stays invalid, and scores the plain grouping it kept', async () => {
    const invalid = JSON.stringify({ parts: [{ name: 'all', hunks: ['h99'] }] });
    const { folder, results } = await run([invalid, invalid]);

    const invalidAnswer = expect.stringMatching(/^the agent gave no usable answer \(invalid-answer: /);
    expect(results.fallbacks).toEqual([
      { case: 'example-7', agent: 'fake', prompt: 'grouping', detail: invalidAnswer },
      { case: 'example-7', agent: 'fake', prompt: 'ranking', detail: invalidAnswer },
    ]);
    expect(rowsOf(results.rows, 'fake', 'grouping-agreement')['example-7']).toBe(
      rowsOf(results.rows, NO_AGENT, 'grouping-agreement')['example-7'],
    );
    // A fallback scores the plain ranking the reviewer would see.
    expect(rowsOf(results.rows, 'fake', 'rank-median')['example-7']).toBe(rowsOf(results.rows, NO_AGENT, 'rank-median')['example-7']);
    expect(readFileSync(join(folder, TRACE_FILE), 'utf8').trim().split('\n')).toHaveLength(4);
  });

  it('records a coverage row of 0 when the agent pass throws, so the hard gate cannot pass silently', async () => {
    const crashing: AgentAdapter = {
      agent: 'fake',
      probe: scriptedAgent([]).probe,
      run: async () => {
        throw new Error('agent crashed');
      },
    };
    const { results } = await run([], crashing);

    expect(results.failures).toEqual([
      { case: 'example-7', error: 'agent crashed' },
      { case: 'example-7', error: 'agent crashed' },
    ]);
    const uncovered = belowFullCoverage(results.rows);
    expect(uncovered).toHaveLength(1);
    expect(uncovered[0]).toMatchObject({
      case: 'example-7',
      agent: 'fake',
      name: 'coverage',
      value: 0,
    });
  });
});

describe('runEvaluation with the ranking prompt', () => {
  it("compares the agent's ranking of the plain parts with the plain ranking, and says it matches or beats it", async () => {
    const { results } = await run([], labellingAgent('first'));

    expect(rowsOf(results.rows, 'fake', 'rank-median')).toEqual({ 'example-7': 1.5, [ALL_CASES]: 1.5 });
    expect(rowsOf(results.rows, 'fake', 'rank-top-3')).toEqual({ 'example-7': 1, [ALL_CASES]: 1 });
    expect(results.rankings).toEqual([
      {
        agent: 'fake',
        agentVersion: '1.2.3',
        model: 'fake/model',
        effort: 'default',
        cases: ['example-7'],
        plain: { 'rank-median': rowsOf(results.rows, NO_AGENT, 'rank-median')['example-7'], 'rank-top-3': rowsOf(results.rows, NO_AGENT, 'rank-top-3')['example-7'] },
        ranked: { 'rank-median': 1.5, 'rank-top-3': 1 },
        verdict: 'matches or beats the plain ranking',
      },
    ]);
  });

  it('says an agent ranking that puts the known important parts last falls behind the plain ranking', async () => {
    const { results } = await run([], labellingAgent('last'));

    expect(results.rankings).toMatchObject([{ verdict: 'falls behind the plain ranking', ranked: { 'rank-top-3': 0 } }]);
  });
});

/** The parts a story prompt offers, in its order: each id with its level and the part's name. */
function storyParts(prompt: string): { id: string; level: string; name: string }[] {
  return [...prompt.matchAll(/^\[(p\d+)\] (.*)\n<untrusted-input [^\n]*\nname: (.*)$/gm)].map((match) => ({
    id: match[1]!,
    level: match[2]!,
    name: match[3]!,
  }));
}

/** An agent that writes example-7's story with `sentences`, given the offered parts, and gives no other answer. */
function storyAgent(sentences: (parts: { id: string; level: string; name: string }[]) => string[]): AgentAdapter {
  return answeringAgent((request) =>
    request.instructions === STORY_INSTRUCTIONS ? { sentences: sentences(storyParts(request.prompt)) } : 'not an answer',
  );
}

describe('runEvaluation with the story prompt', () => {
  it("scores the agent's story of the plain parts on its plain checks, stamped with who answered, and traces the call", async () => {
    // example-7's plain ranking: fresh is must review, then the cart total.
    const agent = storyAgent((parts) => [
      `It adds [\`fresh\`](${parts[0]!.id}) and taxes [the cart total](${parts[1]!.id}) in \`web/cart.ts\` and \`app/totals.py\`.`,
    ]);
    const { folder, results } = await run([], agent, ['story']);

    expect(rowsOf(results.rows, 'fake', 'story-must-review')).toEqual({ 'example-7': 1, [ALL_CASES]: 1 });
    expect(rowsOf(results.rows, 'fake', 'story-order')).toEqual({ 'example-7': 1, [ALL_CASES]: 1 });
    // Three names: fresh and web/cart.ts are in the change, app/totals.py is not.
    expect(rowsOf(results.rows, 'fake', 'story-names')).toEqual({ 'example-7': 2 / 3, [ALL_CASES]: 2 / 3 });
    // The agent ran only the story prompt.
    const agentRows = results.rows.filter((row) => row.agent === 'fake');
    expect(new Set(agentRows.map((row) => row.name))).toEqual(new Set(['story-must-review', 'story-order', 'story-names']));
    expect(agentRows[0]).toMatchObject({ agentVersion: '1.2.3', model: 'fake/model', effort: 'default' });
    expect(results.fallbacks).toEqual([]);
    const trace = readFileSync(join(folder, TRACE_FILE), 'utf8').trim().split('\n').map((line) => JSON.parse(line) as AgentCall);
    expect(trace).toHaveLength(1);
    expect(trace[0]).toMatchObject({ case: 'example-7', prompt: 'story', promptVersion: STORY_PROMPT_VERSION });
    expect(trace[0]!.input.startsWith(STORY_INSTRUCTIONS)).toBe(true);
  });

  it('scores a story that leaves out the must-review part and mentions the parts out of order', async () => {
    const agent = storyAgent((parts) => [`Read [the test](${parts[2]!.id}) before [the cart total](${parts[1]!.id}).`]);
    const { results } = await run([], agent, ['story']);

    expect(rowsOf(results.rows, 'fake', 'story-must-review')['example-7']).toBe(0);
    expect(rowsOf(results.rows, 'fake', 'story-order')['example-7']).toBe(0);
  });

  it('records a story that fell back as failing its checks', async () => {
    const { results } = await run([], storyAgent(() => []), ['story']);

    expect(results.fallbacks).toEqual([
      { case: 'example-7', agent: 'fake', prompt: 'story', detail: expect.stringMatching(/^the agent gave no usable answer \(invalid-answer: /) },
    ]);
    expect(rowsOf(results.rows, 'fake', 'story-must-review')['example-7']).toBe(0);
    expect(rowsOf(results.rows, 'fake', 'story-order')['example-7']).toBe(0);
    expect(rowsOf(results.rows, 'fake', 'story-names')['example-7']).toBeUndefined();
  });

  it('runs every prompt a case is tied to when no prompt is named', async () => {
    const { results } = await run([], storyAgent(() => ['x']), 'every');

    const prompts = new Set(results.fallbacks!.map((fallback) => fallback.prompt));
    expect(prompts).toEqual(new Set(['grouping', 'ranking']));
    expect(rowsOf(results.rows, 'fake', 'story-order')['example-7']).toBe(1);
  });
});

/** Runs canary-python alone, the agent running only the claims prompt. */
async function runCanary(adapter: AgentAdapter) {
  const all = await loadCases([join(PACKAGE, 'cases')]);
  return runEvaluation({
    cases: all.filter((each) => each.id === 'canary-python'),
    registry: await loadRegistry(join(PACKAGE, 'prompts.json')),
    companionVersion: '0.1.0',
    runsFolder: runs,
    now: new Date('2026-10-02T00:00:00.000Z'),
    agent: { adapter },
    prompts: ['claims'],
  });
}

/** An agent that lists the given claims of the canary, and gives no other answer. */
function claimsAgent(claims: unknown[]): AgentAdapter {
  return answeringAgent((request) => (request.instructions === CLAIMS_INSTRUCTIONS ? { claims } : 'not an answer'));
}

const docstring = (quote: string, line: number) => ({ source: 'docstring', quote, file: 'app/doc_links.py', line, part: null });

describe('runEvaluation with the claims prompt', () => {
  it("scores the claims the agent lists of the plain parts against the case's hand list, stamped with who answered", async () => {
    const agent = claimsAgent([
      docstring('Any redirect on the way is followed, so the caller always receives the final page rather than a 3xx status.', 9),
      docstring('Fetch documentation pages over HTTP.', 1),
      { source: 'comment', quote: 'import httpx', file: 'app/doc_links.py', line: 3, part: null },
    ]);

    const { folder, results } = await runCanary(agent);

    // Of the two required claims one was found; of the two listed claims the
    // hand list judges, one is right — the optional summary counts in neither.
    expect(rowsOf(results.rows, 'fake', 'claims-recall')).toEqual({ 'canary-python': 0.5, [ALL_CASES]: 0.5 });
    expect(rowsOf(results.rows, 'fake', 'claims-precision')).toEqual({ 'canary-python': 0.5, [ALL_CASES]: 0.5 });
    const agentRows = results.rows.filter((row) => row.agent === 'fake');
    expect(new Set(agentRows.map((row) => row.name))).toEqual(new Set(['claims-recall', 'claims-precision']));
    expect(agentRows.find((row) => row.case === 'canary-python')).toMatchObject({
      model: 'fake/model',
      promptVersions: { claims: CLAIMS_PROMPT_VERSION },
    });
    // The plain pass lists no claim, so it gives no listing score.
    expect(rowsOf(results.rows, NO_AGENT, 'claims-recall')).toEqual({});
    const trace = readFileSync(join(folder, TRACE_FILE), 'utf8').trim().split('\n').map((line) => JSON.parse(line) as AgentCall);
    expect(trace).toHaveLength(1);
    expect(trace[0]).toMatchObject({ case: 'canary-python', prompt: 'claims', promptVersion: CLAIMS_PROMPT_VERSION });
    expect(trace[0]!.input).not.toContain('source="story"');
  });

  it('records claims that fell back, which find nothing and give no precision', async () => {
    const { results } = await runCanary(claimsAgent([docstring('Redirects are never followed.', 9)]));

    expect(results.fallbacks).toEqual([
      { case: 'canary-python', agent: 'fake', prompt: 'claims', detail: expect.stringMatching(/^the agent gave no usable answer \(invalid-answer: /) },
    ]);
    expect(rowsOf(results.rows, 'fake', 'claims-recall')['canary-python']).toBe(0);
    expect(rowsOf(results.rows, 'fake', 'claims-precision')['canary-python']).toBeUndefined();
  });
});

describe('belowFullCoverage', () => {
  it('finds every coverage row under 100%, whoever produced it', () => {
    const rows = [
      { case: 'a', name: 'coverage', value: 1, agent: NO_AGENT },
      { case: 'b', name: 'coverage', value: 0.99, agent: 'pi' },
      { case: 'c', name: 'grouping-agreement', value: 0.5, agent: 'pi' },
    ] as ResultRow[];
    expect(belowFullCoverage(rows).map((row) => row.case)).toEqual(['b']);
  });
});
