import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GROUPING_INSTRUCTIONS } from '../../engine/src/grouping.js';
import { scriptedAgent } from '../../engine/test/helpers.js';
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

let runs: string;

beforeEach(() => {
  runs = mkdtempSync(join(tmpdir(), 'second-look-eval-runs-'));
});

afterEach(() => {
  rmSync(runs, { recursive: true, force: true });
});

async function run(answers: string[]) {
  const all = await loadCases([join(PACKAGE, 'cases')]);
  const cases = all.filter((each) => each.id === 'example-7' || each.id === 'example-42');
  return runEvaluation({
    cases,
    registry: await loadRegistry(join(PACKAGE, 'prompts.json')),
    companionVersion: '0.1.0',
    runsFolder: runs,
    now: new Date('2026-10-02T00:00:00.000Z'),
    agent: { adapter: scriptedAgent(answers) },
  });
}

function rowsOf(rows: readonly ResultRow[], agent: string, name: string): Record<string, number> {
  return Object.fromEntries(
    rows.filter((row) => row.agent === agent && row.name === name).map((row) => [row.case, row.value]),
  );
}

describe('runEvaluation with an agent', () => {
  it("scores the grouping prompt's cases with the agent too, stamped with who answered, and traces each call", async () => {
    const { folder, results } = await run([LABELLED_ANSWER]);

    // The plain pass scores every case; the agent only the cases tied to its prompt.
    expect(rowsOf(results.rows, NO_AGENT, 'coverage')).toEqual({ 'example-42': 1, 'example-7': 1, [ALL_CASES]: 1 });
    expect(rowsOf(results.rows, 'fake', 'coverage')).toEqual({ 'example-7': 1, [ALL_CASES]: 1 });
    expect(rowsOf(results.rows, 'fake', 'grouping-agreement')).toEqual({ 'example-7': 1, [ALL_CASES]: 1 });
    expect(rowsOf(results.rows, NO_AGENT, 'grouping-agreement')['example-7']).toBeLessThan(1);
    const agentRows = results.rows.filter((row) => row.agent === 'fake');
    expect(agentRows.map((row) => row.name).sort()).toEqual(['coverage', 'coverage', 'grouping-agreement', 'grouping-agreement']);
    for (const row of agentRows) {
      expect(row).toMatchObject({
        agentVersion: '1.2.3',
        model: 'fake/model',
        effort: 'default',
        promptVersions: { grouping: '1' },
      });
    }
    expect(results.fallbacks).toEqual([]);

    const trace = readFileSync(join(folder, TRACE_FILE), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as AgentCall);
    expect(trace).toHaveLength(1);
    expect(trace[0]).toMatchObject({
      case: 'example-7',
      prompt: 'grouping',
      promptVersion: '1',
      agent: 'fake',
      model: 'fake/model',
      output: LABELLED_ANSWER,
    });
    expect(trace[0]!.input.startsWith(GROUPING_INSTRUCTIONS)).toBe(true);
  });

  it('records a fallback when the answer stays invalid, and scores the plain grouping it kept', async () => {
    const invalid = JSON.stringify({ parts: [{ name: 'all', hunks: ['h99'] }] });
    const { folder, results } = await run([invalid, invalid]);

    expect(results.fallbacks).toEqual([
      { case: 'example-7', agent: 'fake', detail: expect.stringMatching(/^the agent gave no usable answer \(invalid-answer: /) },
    ]);
    expect(rowsOf(results.rows, 'fake', 'grouping-agreement')['example-7']).toBe(
      rowsOf(results.rows, NO_AGENT, 'grouping-agreement')['example-7'],
    );
    expect(readFileSync(join(folder, TRACE_FILE), 'utf8').trim().split('\n')).toHaveLength(2);
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
