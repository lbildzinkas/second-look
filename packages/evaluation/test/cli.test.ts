import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { removeCopy } from '../../engine/src/cache.js';
import {
  CaptureStream,
  PR_7_URL,
  fixtureFetch,
  pull7,
  temporaryCacheDir,
} from '../../engine/test/helpers.js';
import { hasStamp } from '../src/baseline.js';
import { loadCases } from '../src/case.js';
import { runCli } from '../src/cli.js';
import { recordCase } from '../src/record.js';
import { ALL_CASES, NO_AGENT, TRACE_FILE, traceAgentCall } from '../src/run.js';
import type { RunResults } from '../src/run.js';

const BASELINE = fileURLToPath(new URL('../baseline.json', import.meta.url));
const REPOSITORY_CASES = fileURLToPath(new URL('../cases', import.meta.url));

let scratch: string;
let cacheDir: string;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'second-look-eval-'));
  cacheDir = temporaryCacheDir();
});

afterEach(async () => {
  rmSync(scratch, { recursive: true, force: true });
  await removeCopy(cacheDir);
});

async function cli(
  argv: string[],
  env: NodeJS.ProcessEnv = {},
): Promise<{ code: number; out: string; err: string }> {
  const out = new CaptureStream();
  const err = new CaptureStream();
  const code = await runCli(argv, env, { out, err }, { fetch: fixtureFetch(pull7()).fetch });
  return { code, out: out.text, err: err.text };
}

/** The single run folder under the scratch runs folder. */
function runFolder(): string {
  const [folder] = readdirSync(join(scratch, 'runs'));
  return join(scratch, 'runs', folder!);
}

describe('the run command', () => {
  it('scores the repository cases with no drop against the stored baseline', async () => {
    const { code, out } = await cli([
      'run',
      '--model-free',
      '--baseline',
      BASELINE,
      '--runs',
      join(scratch, 'runs'),
    ]);
    expect(out).toContain('example-42  noise-recall:lockfile:claimed  1');
    expect(out).toContain('example-7  rank-top-3  0.5');
    expect(out).toMatch(/baseline: 0 dropped, 0 missing, \d+ gained/);
    expect(code).toBe(0);

    const results = JSON.parse(readFileSync(join(runFolder(), 'results.json'), 'utf8')) as RunResults;
    expect(results.failures).toEqual([]);
    for (const row of results.rows) {
      expect(hasStamp(row)).toBe(true);
      expect(row).toMatchObject({ agent: NO_AGENT, model: NO_AGENT, effort: NO_AGENT, promptVersions: {} });
    }
    expect(results.rows.some((row) => row.case === ALL_CASES)).toBe(true);
    // A model-free run calls no agent, so its trace is empty.
    expect(readFileSync(join(runFolder(), TRACE_FILE), 'utf8')).toBe('');
  });

  it('fails when a model-free score drops below the baseline', async () => {
    const stored = JSON.parse(readFileSync(BASELINE, 'utf8')) as RunResults;
    const raised = stored.rows.map((row) =>
      row.case === 'example-7' && row.name === 'rank-top-3' ? { ...row, value: 1 } : row,
    );
    const baseline = join(scratch, 'baseline.json');
    writeFileSync(baseline, JSON.stringify({ ...stored, rows: raised }));

    const { code, out } = await cli(['run', '--baseline', baseline, '--runs', join(scratch, 'runs')]);
    expect(out).toContain('DROP example-7 rank-top-3: 1 -> 0.5');
    expect(code).toBe(1);
  });

  it('never compares baseline rows without their stamp', async () => {
    const stored = JSON.parse(readFileSync(BASELINE, 'utf8')) as RunResults;
    const unstamped = stored.rows.map(({ runDate: _runDate, ...row }) => ({ ...row, value: 99 }));
    const baseline = join(scratch, 'baseline.json');
    writeFileSync(baseline, JSON.stringify({ rows: unstamped }));

    const { code, out } = await cli(['run', '--baseline', baseline, '--runs', join(scratch, 'runs')]);
    expect(out).toContain(`0 dropped`);
    expect(out).toContain(`${stored.rows.length} unstamped and not compared`);
    expect(code).toBe(0);
  });

  it('writes a baseline from the run', async () => {
    const written = join(scratch, 'written.json');
    const { code } = await cli(['run', '--write-baseline', written, '--runs', join(scratch, 'runs')]);
    expect(code).toBe(0);
    const results = JSON.parse(readFileSync(written, 'utf8')) as RunResults;
    expect(results.rows.length).toBeGreaterThan(0);
  });

  it('selects no case when no prompt changed since the ref', async () => {
    const { code, out } = await cli(['run', '--changed-since', 'HEAD', '--runs', join(scratch, 'runs')]);
    expect(out).toContain('prompts changed since HEAD: none');
    expect(out).toContain('no cases selected; nothing to run');
    expect(code).toBe(0);
  });

  it('refuses a case tied to a prompt the registry does not know', async () => {
    const folder = join(scratch, 'cases');
    await recordCase(PR_7_URL, { token: 't', cacheDir, casesFolder: folder, id: 'tied', fetch: fixtureFetch(pull7()).fetch });
    const record = join(folder, 'tied', 'case.json');
    const json = JSON.parse(readFileSync(record, 'utf8')) as { prompts: string[] };
    writeFileSync(record, JSON.stringify({ ...json, prompts: ['story'] }));

    const { code, err } = await cli(['run', '--cases', folder, '--runs', join(scratch, 'runs')]);
    expect(err).toContain('case tied names the unregistered prompt story');
    expect(code).toBe(1);
  });
});

describe('the record command', () => {
  it('records a case into the private folder, which a run then reads too', async () => {
    const privateFolder = join(scratch, 'private');
    const env = { SECOND_LOOK_EVAL_CASES: privateFolder, GITHUB_TOKEN: 'test-token' };
    const recorded = await cli(['record', PR_7_URL, '--id', 'mine', '--cache-dir', cacheDir], env);
    expect(recorded.err).toBe('');
    expect(recorded.code).toBe(0);
    expect(recorded.out).toContain(join(privateFolder, 'mine'));

    const case7 = join(privateFolder, 'mine');
    expect(readdirSync(case7).sort()).toEqual(['base', 'case.json', 'change.diff', 'expected.json', 'head']);
    const record = JSON.parse(readFileSync(join(case7, 'case.json'), 'utf8')) as Record<string, unknown>;
    expect(record).toMatchObject({ formatVersion: 1, id: 'mine', source: PR_7_URL, prompts: [], gitAttributes: null });
    // Every changed file waits for its hand label.
    const expected = JSON.parse(readFileSync(join(case7, 'expected.json'), 'utf8')) as {
      noise: Record<string, null>;
    };
    expect(Object.values(expected.noise)).toHaveLength(7);
    expect(Object.values(expected.noise).every((label) => label === null)).toBe(true);
    // The head keeps the file that names Cart, for the reference count.
    expect(readdirSync(join(case7, 'head', 'web')).sort()).toEqual(['cart.ts', 'checkout.ts']);

    const cases = await loadCases([REPOSITORY_CASES, privateFolder]);
    expect(cases.map((each) => each.id)).toEqual(['example-42', 'example-7', 'mine']);
    const run = await cli(['run', '--runs', join(scratch, 'runs')], env);
    expect(run.out).toContain('mine  coverage  1');
  });

  it('needs a cases folder and refuses to overwrite a case', async () => {
    const env = { GITHUB_TOKEN: 'test-token' };
    const nowhere = await cli(['record', PR_7_URL, '--cache-dir', cacheDir], env);
    expect(nowhere.err).toContain('name a cases folder with --cases or SECOND_LOOK_EVAL_CASES');
    expect(nowhere.code).toBe(1);

    const folder = join(scratch, 'cases');
    const args = ['record', PR_7_URL, '--cases', folder, '--cache-dir', cacheDir];
    expect((await cli(args, env)).code).toBe(0);
    expect(readdirSync(folder)).toEqual(['example-org-example-repo-7']);
    const again = await cli(args, env);
    expect(again.err).toContain('a case already exists at');
    expect(again.code).toBe(1);
  });

  it('refuses two cases with one name across folders', async () => {
    const folder = join(scratch, 'cases');
    await recordCase(PR_7_URL, { token: 't', cacheDir, casesFolder: folder, id: 'example-7', fetch: fixtureFetch(pull7()).fetch });
    await expect(loadCases([REPOSITORY_CASES, folder])).rejects.toThrow('two cases are named example-7');
  });
});

describe('traceAgentCall', () => {
  it('appends one JSON line per agent call', async () => {
    const call = {
      case: 'example-7',
      prompt: 'story',
      promptVersion: '1',
      agent: 'claude',
      agentVersion: '2.0.0',
      model: 'opus',
      effort: 'high',
      startedAt: '2026-10-02T00:00:00.000Z',
      durationMs: 12,
      input: 'in',
      output: 'out',
    };
    await traceAgentCall(scratch, call);
    await traceAgentCall(scratch, { ...call, durationMs: 13 });
    const lines = readFileSync(join(scratch, TRACE_FILE), 'utf8').trim().split('\n');
    expect(lines.map((line) => JSON.parse(line) as unknown)).toEqual([call, { ...call, durationMs: 13 }]);
  });
});
