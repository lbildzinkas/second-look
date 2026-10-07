import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GROUPING_INSTRUCTIONS, GROUPING_PROMPT_VERSION } from '../../engine/src/grouping.js';
import { RANKING_INSTRUCTIONS, RANKING_PROMPT_VERSION } from '../../engine/src/ranking.js';
import { STORY_INSTRUCTIONS, STORY_PROMPT_VERSION } from '../../engine/src/story.js';
import { CLAIMS_INSTRUCTIONS, CLAIMS_PROMPT_VERSION } from '../../engine/src/claims.js';
import { VERDICTS_INSTRUCTIONS, VERDICTS_PROMPT_VERSION } from '../../engine/src/verdicts.js';
import { LIBRARY_VERDICTS_INSTRUCTIONS, LIBRARY_VERDICTS_PROMPT_VERSION } from '../../engine/src/library-verdicts.js';
import { UNEXPLAINED_INSTRUCTIONS, UNEXPLAINED_PROMPT_VERSION } from '../../engine/src/unexplained.js';
import { CRITERIA_MAPPING_INSTRUCTIONS, CRITERIA_MAPPING_PROMPT_VERSION } from '../../engine/src/criteria-mapping.js';
import { DRAFT_COMMENT_INSTRUCTIONS, DRAFT_COMMENT_PROMPT_VERSION } from '../../engine/src/draft-comment.js';
import { EXPLAIN_INSTRUCTIONS, EXPLAIN_PROMPT_VERSION } from '../../engine/src/explain.js';
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

/** Runs one case alone, the agent running only the given prompts: the verdicts prompt unless named. */
async function runVerdicts(id: string, adapter: AgentAdapter, prompts: readonly string[] = ['verdicts']) {
  const all = await loadCases([join(PACKAGE, 'cases')]);
  return runEvaluation({
    cases: all.filter((each) => each.id === id),
    registry: await loadRegistry(join(PACKAGE, 'prompts.json')),
    companionVersion: '0.1.0',
    runsFolder: runs,
    now: new Date('2026-10-04T00:00:00.000Z'),
    agent: { adapter },
    prompts,
  });
}

const CHANGED_LINE = { file: 'src/tomli/_re.py', line: 83, quote: 'micros = int(micros_str.rjust(6, "0")) if micros_str else 0' };

/** An agent that gives misstated-python's two description claims the given verdicts, citing the changed line. */
function verdictsAgent(first: string, second: string): AgentAdapter {
  const verdict = (id: string, kind: string) => ({ id, verdict: kind, source: 'the change itself', reason: 'r', evidence: [CHANGED_LINE], library: null });
  return answeringAgent((request) =>
    request.instructions === VERDICTS_INSTRUCTIONS ? { verdicts: [verdict('c1', first), verdict('c2', second)] } : 'not an answer',
  );
}

describe('runEvaluation with the verdicts prompt', () => {
  it("scores the verdicts the agent gives the case's hand-labelled claims, stamped with who answered", async () => {
    const { folder, results } = await runVerdicts('misstated-python', verdictsAgent('refuted', 'verified'));

    expect(rowsOf(results.rows, 'fake', 'verdict-accuracy')).toEqual({ 'misstated-python': 1, [ALL_CASES]: 1 });
    expect(rowsOf(results.rows, 'fake', 'false-verified')).toEqual({ 'misstated-python': 0, [ALL_CASES]: 0 });
    const agentRows = results.rows.filter((row) => row.agent === 'fake');
    expect(new Set(agentRows.map((row) => row.name))).toEqual(new Set(['verdict-accuracy', 'false-verified']));
    expect(agentRows.find((row) => row.case === 'misstated-python')).toMatchObject({ model: 'fake/model', promptVersions: { verdicts: VERDICTS_PROMPT_VERSION } });
    const trace = readFileSync(join(folder, TRACE_FILE), 'utf8').trim().split('\n').map((line) => JSON.parse(line) as AgentCall);
    expect(trace).toHaveLength(1);
    expect(trace[0]).toMatchObject({ case: 'misstated-python', prompt: 'verdicts', promptVersion: VERDICTS_PROMPT_VERSION });
    expect(trace[0]!.input).toContain('Pads the fractional seconds of a datetime on the right with zeros');
  });

  it('counts a misstatement the agent verified as false-verified', async () => {
    const { results } = await runVerdicts('misstated-python', verdictsAgent('verified', 'verified'));

    expect(rowsOf(results.rows, 'fake', 'verdict-accuracy')['misstated-python']).toBe(0.5);
    expect(rowsOf(results.rows, 'fake', 'false-verified')['misstated-python']).toBe(1);
  });

  it('records verdicts that fell back, every claim left not checked', async () => {
    const { results } = await runVerdicts('misstated-python', answeringAgent(() => ({ verdicts: [] })));

    expect(results.fallbacks).toEqual([
      { case: 'misstated-python', agent: 'fake', prompt: 'verdicts', detail: expect.stringMatching(/^the agent gave no usable answer \(invalid-answer: /) },
    ]);
    expect(rowsOf(results.rows, 'fake', 'verdict-accuracy')['misstated-python']).toBe(0);
    expect(rowsOf(results.rows, 'fake', 'false-verified')['misstated-python']).toBe(0);
  });
});

describe('runEvaluation with the unexplained-changes prompt', () => {
  /** An agent comparing planted-typescript: the planted rename's first part and the feature flagged, and only the description's missing change listed. */
  const comparingAgent = (): AgentAdapter =>
    answeringAgent((request) =>
      request.instructions === UNEXPLAINED_INSTRUCTIONS
        ? {
            unexplained: [
              { part: 'p1', reason: 'Renames codePoint to toCodePoint, which nothing mentions.' },
              { part: 'p2', reason: 'Changes how a heading is matched.' },
            ],
            described: [{ source: 'description', quote: "The README's acceptance criteria section now says that a trailing colon is allowed.", reason: 'The README is not changed.' }],
          }
        : 'not an answer',
    );

  it("scores the agent's comparison of the plain parts with the description and the recorded issue against the hand labels", async () => {
    const { folder, results } = await runVerdicts('planted-typescript', comparingAgent(), ['unexplained']);

    expect(rowsOf(results.rows, 'fake', 'unexplained-recall')).toEqual({ 'planted-typescript': 1, [ALL_CASES]: 1 });
    expect(rowsOf(results.rows, 'fake', 'unexplained-precision')).toEqual({ 'planted-typescript': 0.5, [ALL_CASES]: 0.5 });
    expect(rowsOf(results.rows, 'fake', 'described-recall')).toEqual({ 'planted-typescript': 0.5, [ALL_CASES]: 0.5 });
    expect(rowsOf(results.rows, 'fake', 'described-precision')).toEqual({ 'planted-typescript': 1, [ALL_CASES]: 1 });
    expect(results.rows.find((row) => row.agent === 'fake' && row.case === 'planted-typescript')).toMatchObject({
      model: 'fake/model',
      promptVersions: { unexplained: UNEXPLAINED_PROMPT_VERSION },
    });
    expect(rowsOf(results.rows, NO_AGENT, 'unexplained-recall')).toEqual({});
    const trace = readFileSync(join(folder, TRACE_FILE), 'utf8').trim().split('\n').map((line) => JSON.parse(line) as AgentCall);
    expect(trace).toHaveLength(1);
    expect(trace[0]).toMatchObject({ case: 'planted-typescript', prompt: 'unexplained', promptVersion: UNEXPLAINED_PROMPT_VERSION });
    expect(trace[0]!.input).toContain('[i1] #212 in example-org/example-repo, which the pull request closes');
  });

  it('records a comparison that fell back, which flags nothing and gives no precision', async () => {
    const { results } = await runVerdicts('planted-typescript', scriptedAgent([]), ['unexplained']);

    expect(results.fallbacks).toEqual([
      { case: 'planted-typescript', agent: 'fake', prompt: 'unexplained', detail: expect.stringMatching(/^the agent gave no usable answer/) },
    ]);
    expect(rowsOf(results.rows, 'fake', 'unexplained-recall')['planted-typescript']).toBe(0);
    expect(rowsOf(results.rows, 'fake', 'unexplained-precision')['planted-typescript']).toBeUndefined();
  });
});

describe('runEvaluation with the criteria-mapping prompt', () => {
  /** An agent mapping planted-typescript's criteria: the heading one met by its code and test, the setting one wrongly met by the same code. */
  const mappingAgent = (): AgentAdapter =>
    answeringAgent((request) => {
      if (request.instructions !== CRITERIA_MAPPING_INSTRUCTIONS) return 'not an answer';
      const code = [{ file: 'packages/engine/src/criteria.ts', line: 26, quote: "return HEADING.exec(line)?.[1]?.replace(/:$/, '').trim();" }];
      const tests = [{ file: 'packages/engine/test/criteria.test.ts', line: 57, quote: "it('matches a heading written with a trailing colon', () => {" }];
      return {
        criteria: [
          { id: 'a1', verdict: 'met', reason: 'The heading match drops a trailing colon.', code, tests, manual: [] },
          { id: 'a2', verdict: 'met', reason: 'The heading match drops a trailing colon.', code, tests: [], manual: [] },
        ],
      };
    });

  it("scores the agent's verdicts on the recorded criteria against the hand labels, stamped with who answered", async () => {
    const { folder, results } = await runVerdicts('planted-typescript', mappingAgent(), ['criteria-mapping']);

    expect(rowsOf(results.rows, 'fake', 'criteria-accuracy')).toEqual({ 'planted-typescript': 0.5, [ALL_CASES]: 0.5 });
    expect(rowsOf(results.rows, 'fake', 'criteria-false-met')).toEqual({ 'planted-typescript': 1, [ALL_CASES]: 1 });
    expect(rowsOf(results.rows, 'fake', 'criteria-code-recall')).toEqual({ 'planted-typescript': 1, [ALL_CASES]: 1 });
    expect(rowsOf(results.rows, 'fake', 'criteria-tests-recall')).toEqual({ 'planted-typescript': 1, [ALL_CASES]: 1 });
    expect(rowsOf(results.rows, 'fake', 'criteria-manual-recall')).toEqual({});
    expect(results.rows.find((row) => row.agent === 'fake' && row.case === 'planted-typescript')).toMatchObject({
      model: 'fake/model',
      promptVersions: { 'criteria-mapping': CRITERIA_MAPPING_PROMPT_VERSION },
    });
    expect(rowsOf(results.rows, NO_AGENT, 'criteria-accuracy')).toEqual({});
    const trace = readFileSync(join(folder, TRACE_FILE), 'utf8').trim().split('\n').map((line) => JSON.parse(line) as AgentCall);
    expect(trace).toHaveLength(1);
    expect(trace[0]).toMatchObject({ case: 'planted-typescript', prompt: 'criteria-mapping', promptVersion: CRITERIA_MAPPING_PROMPT_VERSION });
    expect(trace[0]!.input).toContain('[a2] from issue i1, line 6');
  });

  it('records a mapping that fell back, which leaves every criterion not checked', async () => {
    const { results } = await runVerdicts('planted-typescript', scriptedAgent([]), ['criteria-mapping']);

    expect(results.fallbacks).toEqual([
      { case: 'planted-typescript', agent: 'fake', prompt: 'criteria-mapping', detail: expect.stringMatching(/^the agent gave no usable answer/) },
    ]);
    expect(rowsOf(results.rows, 'fake', 'criteria-accuracy')['planted-typescript']).toBe(0);
    expect(rowsOf(results.rows, 'fake', 'criteria-false-met')['planted-typescript']).toBe(0);
    expect(rowsOf(results.rows, 'fake', 'criteria-code-recall')['planted-typescript']).toBe(0);
  });
});

describe('runEvaluation with the draft-comment prompt', () => {
  /** An agent drafting canary-python's two findings: a good draft from the unverifiable claim, one inventing a fix from the refuted one. */
  const draftingAgent = (): AgentAdapter =>
    answeringAgent((request) => {
      if (request.instructions !== DRAFT_COMMENT_INSTRUCTIONS) return 'not an answer';
      if (request.prompt.includes('a refuted claim')) return { comment: 'Pass `follow_redirects=True` in `app/client.py` and it works.' };
      return { comment: 'The docstring at `app/doc_links.py:9` says redirects are followed; can you show where, since that depends on httpx?' };
    });

  it("scores the agent's own drafts from the case's findings on the plain checks, stamped with who answered", async () => {
    const { folder, results } = await runVerdicts('canary-python', draftingAgent(), ['draft-comment']);

    // The refuted claim's draft cites nothing the finding offers and adds a fix it does not state, but both stay short.
    expect(rowsOf(results.rows, 'fake', 'draft-cites-evidence')).toEqual({ 'canary-python': 0.5, [ALL_CASES]: 0.5 });
    expect(rowsOf(results.rows, 'fake', 'draft-no-new-claim')).toEqual({ 'canary-python': 0.5, [ALL_CASES]: 0.5 });
    expect(rowsOf(results.rows, 'fake', 'draft-under-cap')).toEqual({ 'canary-python': 1, [ALL_CASES]: 1 });
    expect(results.rows.find((row) => row.agent === 'fake' && row.case === 'canary-python')).toMatchObject({
      model: 'fake/model',
      promptVersions: { 'draft-comment': DRAFT_COMMENT_PROMPT_VERSION },
    });
    // The plain pass drafts nothing, so it gives no draft score.
    expect(rowsOf(results.rows, NO_AGENT, 'draft-cites-evidence')).toEqual({});
    expect(results.fallbacks).toEqual([]);
    const trace = readFileSync(join(folder, TRACE_FILE), 'utf8').trim().split('\n').map((line) => JSON.parse(line) as AgentCall);
    // One call per finding: the run does not retry a draft the checks would refuse.
    expect(trace).toHaveLength(2);
    expect(trace[0]).toMatchObject({ case: 'canary-python', prompt: 'draft-comment', promptVersion: DRAFT_COMMENT_PROMPT_VERSION });
    expect(trace[1]!.input).toContain('- httpx/_client.py:643: follow_redirects: bool = False,');
  });

  it('records a draft that fell back, which fails every check', async () => {
    const { results } = await runVerdicts('canary-python', scriptedAgent([]), ['draft-comment']);

    expect(results.fallbacks).toHaveLength(2);
    expect(results.fallbacks![0]).toEqual({ case: 'canary-python', agent: 'fake', prompt: 'draft-comment', detail: expect.stringMatching(/^the agent gave no usable answer/) });
    expect(rowsOf(results.rows, 'fake', 'draft-cites-evidence')['canary-python']).toBe(0);
    expect(rowsOf(results.rows, 'fake', 'draft-no-new-claim')['canary-python']).toBe(0);
    expect(rowsOf(results.rows, 'fake', 'draft-under-cap')['canary-python']).toBe(0);
  });
});

describe('runEvaluation with the explain prompt', () => {
  /**
   * An agent explaining encode-httpx-3690's two labelled parts: the
   * server's wait, citing its removed and kept lines; the parser's
   * wait_ready, citing a line the part does not show and naming code
   * the change does not show.
   */
  const explainingAgent = (): AgentAdapter =>
    answeringAgent((request) => {
      if (request.instructions !== EXPLAIN_INSTRUCTIONS) return 'not an answer';
      if (request.prompt.includes('name: HTTPServer.wait in src/httpx/_server.py')) {
        return {
          does: '`wait` now calls `sleep(1)` in its loop with no `KeyboardInterrupt` handler around it.',
          matters: 'An interrupt now leaves the loop by raising instead of breaking out of it.',
          cited: [
            { file: 'src/httpx/_server.py', side: 'base', line: 107, quote: 'except KeyboardInterrupt:' },
            { file: 'src/httpx/_server.py', side: 'head', line: 113, quote: 'sleep(1)' },
          ],
        };
      }
      return {
        does: '`wait_ready` waits on an `asyncio.Event` until data arrives.',
        matters: 'The server loop calls it before reading a request.',
        cited: [{ file: 'src/httpx/_parsers.py', side: 'head', line: 999, quote: 'def wait_ready(self):' }],
      };
    });

  it("scores the agent's own explanations of the labelled parts on the plain checks, stamped with who answered", async () => {
    const { folder, results } = await runVerdicts('encode-httpx-3690', explainingAgent(), ['explain']);

    expect(rowsOf(results.rows, 'fake', 'explain-cites-part')).toEqual({ 'encode-httpx-3690': 0.5, [ALL_CASES]: 0.5 });
    expect(rowsOf(results.rows, 'fake', 'explain-names-in-change')).toEqual({ 'encode-httpx-3690': 0.5, [ALL_CASES]: 0.5 });
    expect(results.rows.find((row) => row.agent === 'fake' && row.case === 'encode-httpx-3690')).toMatchObject({
      model: 'fake/model',
      promptVersions: { explain: EXPLAIN_PROMPT_VERSION },
    });
    // The plain pass explains nothing, so it gives no explain score.
    expect(rowsOf(results.rows, NO_AGENT, 'explain-cites-part')).toEqual({});
    expect(results.fallbacks).toEqual([]);
    const trace = readFileSync(join(folder, TRACE_FILE), 'utf8').trim().split('\n').map((line) => JSON.parse(line) as AgentCall);
    // One call per part: the run does not retry an explanation the checks would refuse.
    expect(trace).toHaveLength(2);
    expect(trace[0]).toMatchObject({ case: 'encode-httpx-3690', prompt: 'explain', promptVersion: EXPLAIN_PROMPT_VERSION });
    expect(trace[1]!.input).toContain('- base 107:             except KeyboardInterrupt:');
  });

  it('records an explanation that fell back, which fails every check', async () => {
    const { results } = await runVerdicts('encode-httpx-3690', scriptedAgent([]), ['explain']);

    expect(results.fallbacks).toHaveLength(2);
    expect(results.fallbacks![0]).toEqual({ case: 'encode-httpx-3690', agent: 'fake', prompt: 'explain', detail: expect.stringMatching(/^the agent gave no usable answer/) });
    expect(rowsOf(results.rows, 'fake', 'explain-cites-part')['encode-httpx-3690']).toBe(0);
    expect(rowsOf(results.rows, 'fake', 'explain-names-in-change')['encode-httpx-3690']).toBe(0);
  });
});

describe('runEvaluation with the library verdicts prompt', () => {
  const REDIRECT = 'Any redirect on the way is followed, so the caller always receives the final page rather than a 3xx status.';

  /** Leaves the canary's library claim unverifiable needing httpx, then refutes it from httpx's source as the given citation says. */
  function libraryAgent(cited: { file: string; line: number; quote: string }): AgentAdapter {
    return answeringAgent((request) => {
      if (request.instructions === VERDICTS_INSTRUCTIONS) {
        return {
          verdicts: [
            { id: 'c1', verdict: 'verified', source: 'the change itself', reason: 'r', evidence: [{ file: 'app/doc_links.py', line: 14, quote: 'return response.text' }], library: null },
            { id: 'c2', verdict: 'unverifiable', source: 'the change itself', reason: 'It turns on httpx.', evidence: [], library: 'httpx' },
          ],
        };
      }
      if (request.instructions === LIBRARY_VERDICTS_INSTRUCTIONS) {
        expect(request.prompt).toContain(REDIRECT);
        return { verdict: 'refuted', source: 'library source at the pinned version', reason: 'A client follows no redirect by default.', evidence: [cited] };
      }
      return 'not an answer';
    });
  }

  it("presses the fetch the verdict offers, from the case's recorded download, and passes the canary's claim checks", async () => {
    const { folder, results } = await runVerdicts('canary-python', libraryAgent({ file: 'httpx/_client.py', line: 171, quote: 'follow_redirects: bool = False,' }), ['library-verdicts']);

    const agentRows = results.rows.filter((row) => row.agent === 'fake' && row.case === 'canary-python');
    expect(Object.fromEntries(agentRows.map((row) => [row.name, row.value]))).toEqual({
      'claims-found': 1,
      'claims-verdict:refuted': 1,
      'claims-verdict:verified': 1,
      'claims-evidence': 1,
      'claims-fetch-offered': 1,
    });
    expect(agentRows[0]).toMatchObject({ promptVersions: { 'library-verdicts': LIBRARY_VERDICTS_PROMPT_VERSION } });
    const trace = readFileSync(join(folder, TRACE_FILE), 'utf8').trim().split('\n').map((line) => JSON.parse(line) as AgentCall);
    expect(trace.map((call) => call.prompt)).toEqual(['verdicts', 'library-verdicts']);
    // The read-only library is removed once scored, so the run folder stays removable.
    expect(existsSync(join(folder, 'libraries', 'canary-python'))).toBe(false);
  });

  it("accepts the case's other evidence line, the same default where the change's own type declares it", async () => {
    const { results } = await runVerdicts('canary-python', libraryAgent({ file: 'httpx/_client.py', line: 643, quote: 'follow_redirects: bool = False,' }), ['library-verdicts']);

    expect(rowsOf(results.rows, 'fake', 'claims-evidence')['canary-python']).toBe(1);
  });

  it('fails the evidence check when the citation is not in the library at the pinned version', async () => {
    const { results } = await runVerdicts('canary-python', libraryAgent({ file: 'httpx/_client.py', line: 170, quote: 'follow_redirects: bool = False,' }), ['library-verdicts']);

    expect(rowsOf(results.rows, 'fake', 'claims-verdict:refuted')['canary-python']).toBe(0);
    expect(rowsOf(results.rows, 'fake', 'claims-fetch-offered')['canary-python']).toBe(1);
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
