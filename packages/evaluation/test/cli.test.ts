import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { removeCopy } from '../../engine/src/cache.js';
import { GROUPING_PROMPT_VERSION } from '../../engine/src/grouping.js';
import { RANKING_PROMPT_VERSION } from '../../engine/src/ranking.js';
import { STORY_PROMPT_VERSION } from '../../engine/src/story.js';
import {
  CaptureStream,
  PR_7_URL,
  fixtureFetch,
  pull7,
  temporaryCacheDir,
} from '../../engine/test/helpers.js';
import { CLAUDE_GUARD, FAKE_CLAUDE, fakeClaude } from '../../engine/test/fake-claude.js';
import { hasStamp } from '../src/baseline.js';
import { loadCase, loadCases } from '../src/case.js';
import { report, runCli } from '../src/cli.js';
import { recordCase } from '../src/record.js';
import { ALL_CASES, NO_AGENT, TRACE_FILE, traceAgentCall } from '../src/run.js';
import type { ResultRow, RunResults } from '../src/run.js';

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
    const { code, out } = await cli(['run', '--baseline', BASELINE, '--runs', join(scratch, 'runs')]);
    expect(out).toContain('example-42  noise-recall:lockfile:claimed  1');
    expect(out).toContain('example-7  rank-top-3  0.5');
    expect(out).toContain('pallets-click-3781  coverage  1');
    // The canaries' noise and parts pass while their claim checks fail as
    // expected failures, because the review reports no claims yet.
    expect(out).toContain('canary-python  claims-found  0');
    expect(out).toContain(
      'canary-csharp  claims-fetch-offered  0  (expected failure: the review reports no claims)',
    );
    expect(out).toMatch(/baseline: 0 dropped, 0 missing, \d+ gained/);
    expect(code).toBe(0);

    const results = JSON.parse(readFileSync(join(runFolder(), 'results.json'), 'utf8')) as RunResults;
    expect(results.failures).toEqual([]);
    // Without --agent no model is called: every row is the plain pass's,
    // stamped with the versions of the prompts its case is tied to.
    for (const row of results.rows) {
      expect(hasStamp(row)).toBe(true);
      expect(row).toMatchObject({ agent: NO_AGENT, model: NO_AGENT, effort: NO_AGENT });
    }
    expect(results.rows.find((row) => row.case === 'example-42')!.promptVersions).toEqual({});
    expect(results.rows.find((row) => row.case === 'example-7')!.promptVersions).toEqual({
      grouping: GROUPING_PROMPT_VERSION,
      ranking: RANKING_PROMPT_VERSION,
      story: STORY_PROMPT_VERSION,
    });
    expect(results.rows.some((row) => row.case === ALL_CASES)).toBe(true);
    // A model-free run calls no agent, so its trace is empty.
    expect(readFileSync(join(runFolder(), TRACE_FILE), 'utf8')).toBe('');
  });

  it('keeps scoring a case whose expected.json omits whole sections', async () => {
    const legacy = join(scratch, 'cases', 'example-7');
    cpSync(join(REPOSITORY_CASES, 'example-7'), legacy, { recursive: true });
    const expectedPath = join(legacy, 'expected.json');
    const recorded = JSON.parse(readFileSync(expectedPath, 'utf8')) as Record<string, unknown>;
    delete recorded.claims;
    delete recorded.importantParts;
    delete recorded.noise;
    delete recorded.groups;
    writeFileSync(expectedPath, `${JSON.stringify(recorded, null, 2)}\n`);

    const loaded = await loadCase(legacy);
    expect(loaded.expected.groups).toBeUndefined();
    expect(loaded.expected.claims).toEqual([]);
    expect(loaded.expected.importantParts).toEqual([]);
    expect(loaded.expected.noise).toEqual({});

    const run = await cli(['run', '--cases', join(scratch, 'cases'), '--runs', join(scratch, 'runs')]);
    expect(run.err).toBe('');
    expect(run.code).toBe(0);
    expect(run.out).toContain('example-7  coverage');
    const results = JSON.parse(readFileSync(join(runFolder(), 'results.json'), 'utf8')) as RunResults;
    expect(results.failures).toEqual([]);
    const rows = results.rows.filter((row) => row.case === 'example-7');
    expect(rows.map((row) => row.name)).toEqual(['coverage']);
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

  it('keeps only the cases tied to no prompt with --model-free', async () => {
    const { code, out } = await cli(['run', '--model-free', '--runs', join(scratch, 'runs')]);
    expect(out).toContain('example-42  coverage  1');
    expect(out).not.toContain('example-7  coverage');
    expect(code).toBe(0);
  });

  it.each([
    [['--agent', 'codex'], '--agent codex is not supported; choose pi or claude-code'],
    [['--agent', 'pi', '--model-free'], '--model-free runs no agent; leave out --agent'],
    [['--agent', 'pi', '--agent-timeout', '0'], '--agent-timeout needs a number of seconds above zero'],
  ])('refuses agent options %j it cannot honour', async (flags, message) => {
    const { code, err } = await cli(['run', ...flags, '--runs', join(scratch, 'runs')]);
    expect(err).toContain(message);
    expect(code).toBe(1);
  });

  it('names every agent it can drive in its help', async () => {
    const { code, out } = await cli(['--help']);
    expect(out).toContain('[--agent pi|claude-code [--model <model>]');
    expect(out).toContain('With --agent pi or --agent\nclaude-code,');
    expect(code).toBe(0);
  });

  it("drives the installed Claude Code with --agent claude-code, locked down, at the model and effort given", async () => {
    const cases = join(scratch, 'cases');
    cpSync(join(REPOSITORY_CASES, 'example-7'), join(cases, 'example-7'), { recursive: true });
    const claude = fakeClaude({ version: '2.1.296', runs: [{ text: 'no JSON here', model: 'claude-sonnet-5-5' }] });
    const out = new CaptureStream();
    const code = await runCli(
      ['run', '--cases', cases, '--agent', 'claude-code', '--model', 'claude-sonnet-5-5', '--effort', 'high', '--runs', join(scratch, 'runs')],
      { PATH: process.env['PATH'], FAKE_CLAUDE_DIR: claude.dir },
      { out, err: new CaptureStream() },
      { agents: { claudeCode: { command: [process.execPath, FAKE_CLAUDE], guardPath: CLAUDE_GUARD } } },
    );
    expect(code).toBe(0);

    // Every call of every prompt the case is tied to went through Claude
    // Code's lockdown, asking for the model and effort given.
    const runs = claude.calls().filter((call) => call.kind === 'run');
    expect(runs.length).toBeGreaterThanOrEqual(3);
    for (const call of runs) {
      const flag = (name: string) => call.args[call.args.indexOf(name) + 1];
      expect(flag('--model')).toBe('claude-sonnet-5-5');
      expect(flag('--effort')).toBe('high');
      expect(flag('--tools')).toBe('Read,Grep,Glob');
      expect(flag('--permission-mode')).toBe('default');
    }
    const results = JSON.parse(readFileSync(join(runFolder(), 'results.json'), 'utf8')) as RunResults;
    const agentRows = results.rows.filter((row) => row.agent !== NO_AGENT);
    expect(new Set(agentRows.map((row) => row.name))).toEqual(
      new Set(['coverage', 'grouping-agreement', 'rank-median', 'rank-top-3', 'story-must-review', 'story-order']),
    );
    for (const row of agentRows) {
      expect(row).toMatchObject({ agent: 'claude-code', agentVersion: '2.1.296', model: 'claude-sonnet-5-5', effort: 'high' });
    }
    expect(new Set(results.fallbacks?.map((fallback) => fallback.prompt))).toEqual(new Set(['grouping', 'ranking', 'story']));
    expect(out.text).toContain('TESTED claude-code 2.1.296 claude-sonnet-5-5 high');
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
    writeFileSync(record, JSON.stringify({ ...json, prompts: ['criteria'] }));

    const { code, err } = await cli(['run', '--cases', folder, '--runs', join(scratch, 'runs')]);
    expect(err).toContain('case tied names the unregistered prompt criteria');
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
    expect(cases.map((each) => each.id)).toEqual([
      'canary-csharp',
      'canary-python',
      'criteria-python',
      'criteria-typescript',
      'encode-httpx-3690',
      'example-42',
      'example-7',
      'mine',
      'misstated-python',
      'pallets-click-3781',
      'planted-click',
      'planted-typescript',
      'seeded-csharp',
      'seeded-python',
      'seeded-typescript',
      'sindresorhus-ky-880',
    ]);
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

describe('report', () => {
  /** A row as a run writes it, with the whole stamp. */
  function row(overrides: Partial<ResultRow>): ResultRow {
    return {
      case: ALL_CASES,
      name: 'coverage',
      value: 1,
      better: 'higher',
      companionVersion: '0.1.0',
      promptVersions: {},
      agent: NO_AGENT,
      agentVersion: NO_AGENT,
      model: NO_AGENT,
      effort: NO_AGENT,
      runDate: '2026-10-07T15:08:38.849Z',
      ...overrides,
    };
  }

  it('lists every tested combination with its agent, version, model, effort, run date and scores', () => {
    const out = report({
      rows: [
        row({ agent: 'pi', agentVersion: '0.86.1', model: 'zai-coding-cn/glm-5.3', effort: 'default' }),
        row({ case: 'example-7', name: 'rank-top-3', value: 0.9, agent: 'pi', agentVersion: '0.86.1', model: 'zai-coding-cn/glm-5.3', effort: 'default' }),
      ],
      failures: [],
    });
    expect(out).toContain(
      'TESTED pi 0.86.1 zai-coding-cn/glm-5.3 default (run 2026-10-07T15:08:38.849Z): grouping: coverage 1',
    );
  });

  it('prints one TESTED line per combination, and none for a model-free run', () => {
    const pi = { agent: 'pi', agentVersion: '0.86.1', model: 'zai-coding-cn/glm-5.3', effort: 'default' };
    const claude = { agent: 'claude-code', agentVersion: '2.0.0', model: 'sonnet', effort: 'default' };
    const lines = report({ rows: [row(pi), row(claude)], failures: [] }).trim().split('\n');
    const tested = lines.filter((line) => line.startsWith('TESTED'));
    expect(tested).toHaveLength(2);
    expect(tested[0]).toMatch(/^TESTED pi /);
    expect(tested[1]).toMatch(/^TESTED claude-code /);
    expect(report({ rows: [row({ case: 'example-7' })], failures: [] })).not.toContain('TESTED');
  });
});
