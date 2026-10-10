import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AGENT_EFFORT_LEVELS, type AgentProbe } from '../src/agent.js';
import { agentAdapter } from '../src/agents.js';
import { removeCopy } from '../src/cache.js';
import { ENGINE_PROTOCOL_VERSION, JSON_RPC_INVALID_PARAMS, NOT_INITIALIZED_CODE } from '../src/rpc.js';
import { runRpcServer, type RpcAgentDeps } from '../src/server.js';
import { CLAUDE_GUARD, FAKE_CLAUDE, fakeClaude, type FakeClaudeScenario } from './fake-claude.js';
import { FAKE_PI, GUARD, fakePi, type FakePiScenario } from './fake-pi.js';
import { PR_7_URL, fixtureFetch, pull7, temporaryCacheDir } from './helpers.js';

/**
 * The agents/probe request (issue 131), run against the fake agents
 * installed as the real ones are: as `pi` and `claude` commands on the
 * engine's PATH, or at the path a setting names.
 */

let cacheDir: string;

beforeAll(() => {
  cacheDir = temporaryCacheDir();
});

afterAll(async () => {
  await removeCopy(cacheDir);
});

interface Response {
  id: number | null;
  result?: unknown;
  error?: { code: number; message: string };
}

/** A fake agent installed as an executable named `name` in `dir`, playing its scenario folder. */
function install(dir: string, name: string, fake: string): string {
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\nexec "${process.execPath}" "${fake}" "$@"\n`);
  chmodSync(path, 0o755);
  return path;
}

/** A folder for a PATH, holding the given fake agents as `pi` and `claude`. */
function bin(agents: { pi?: boolean; claude?: boolean }): string {
  const dir = mkdtempSync(join(tmpdir(), 'second-look-probe-bin-'));
  if (agents.pi) install(dir, 'pi', FAKE_PI);
  if (agents.claude) install(dir, 'claude', FAKE_CLAUDE);
  return dir;
}

/** The engine's agents as `serve` builds them, finding each command on `path` unless a setting names one. */
function agents(env: NodeJS.ProcessEnv): RpcAgentDeps {
  return {
    adapterFor: (name, path) =>
      agentAdapter(name, { pi: { guardPath: GUARD }, claudeCode: { guardPath: CLAUDE_GUARD }, env }, path),
    defaultAgent: 'pi',
    settings: { timeoutMs: 10_000, concurrency: 1 },
  };
}

/** Fake agent scenario folders, and the engine environment that points the fakes at them. */
function scenarios(
  pi: Partial<FakePiScenario>,
  claude: Partial<FakeClaudeScenario>,
  path: string,
  extra: NodeJS.ProcessEnv = {},
): { env: NodeJS.ProcessEnv; piDir: string } {
  const piDir = fakePi({ runs: [{ text: '{}' }], ...pi }).dir;
  const claudeDir = fakeClaude({ runs: [{ text: '{}' }], ...claude }).dir;
  return { env: { PATH: path, FAKE_PI_DIR: piDir, FAKE_CLAUDE_DIR: claudeDir, ...extra }, piDir };
}

function request(method: string, params: unknown, id: number): string {
  return JSON.stringify({ jsonrpc: '2.0', id, method, params });
}

const HANDSHAKE = request('initialize', { protocolVersion: ENGINE_PROTOCOL_VERSION }, 1);

/** Runs the server over the lines with the given agents; answers by request id. */
async function serve(lines: string[], agent: RpcAgentDeps, fetchImpl?: typeof fetch): Promise<(id: number) => Response> {
  let index = 0;
  const written: string[] = [];
  await runRpcServer(
    { readLine: async () => (index < lines.length ? lines[index++]! : null) },
    { writeLine: (line) => written.push(line) },
    { cacheDir, agent, ...(fetchImpl ? { fetch: fetchImpl } : {}) },
  );
  const responses = written.map((line) => JSON.parse(line) as Response);
  return (id) => responses.find((response) => response.id === id)!;
}

/** The probe of each agent, by name, from a probe answer. */
function probes(response: Response): Record<string, AgentProbe> {
  expect(response.error).toBeUndefined();
  const { agents: list } = response.result as { agents: AgentProbe[] };
  expect(list.map((probe) => probe.agent)).toEqual(['pi', 'claude-code']);
  return Object.fromEntries(list.map((probe) => [probe.agent, probe]));
}

describe('agents/probe', () => {
  it('reports both installed agents: version, lockdown, the effort levels their help lists and Claude Code’s login', async () => {
    const { env } = scenarios(
      { version: '0.86.1', flagHelp: { '--thinking': 'Set thinking level: off, low, high' } },
      { version: '2.1.296', flagHelp: { '--effort': 'Effort level for the current session\n      (low, medium, high)' } },
      bin({ pi: true, claude: true }),
    );
    const answers = await serve([HANDSHAKE, request('agents/probe', {}, 2)], agents(env));

    const { pi, 'claude-code': claude } = probes(answers(2));
    expect(pi).toMatchObject({ installed: true, version: '0.86.1', usable: true, supports: { effort: true } });
    expect(pi!.effortLevels).toEqual(['off', 'low', 'high']);
    expect(pi!.lockdown.length).toBeGreaterThan(0);
    expect(pi!.login).toBeUndefined();
    expect(claude).toMatchObject({ installed: true, version: '2.1.296', usable: true, supports: { effort: true } });
    expect(claude!.effortLevels).toEqual(['low', 'medium', 'high']);
    expect(claude!.login).toEqual({ source: 'the stored Claude subscription sign-in' });
  });

  it('names an inherited API key as Claude Code’s login, with its override warning, and runs no model', async () => {
    const { env, piDir } = scenarios({}, {}, bin({ pi: true, claude: true }), { ANTHROPIC_API_KEY: 'sk-ant-inherited' });
    const answers = await serve([HANDSHAKE, request('agents/probe', {}, 2)], agents(env));

    const { 'claude-code': claude } = probes(answers(2));
    expect(claude!.login!.source).toContain('ANTHROPIC_API_KEY');
    expect(claude!.login!.warning).toContain('overrides the Claude subscription sign-in');
    expect(JSON.stringify(answers(2))).not.toContain('sk-ant-inherited');
    expect(fakePiRuns(piDir)).toBe(0);
  });

  it('falls back to the levels each adapter knows when the help lists none', async () => {
    const { env } = scenarios({}, {}, bin({ pi: true, claude: true }));
    const answers = await serve([HANDSHAKE, request('agents/probe', {}, 2)], agents(env));

    const { pi, 'claude-code': claude } = probes(answers(2));
    expect(pi!.effortLevels).toEqual([...AGENT_EFFORT_LEVELS.pi]);
    expect(claude!.effortLevels).toEqual([...AGENT_EFFORT_LEVELS['claude-code']]);
  });

  it('says plainly that an agent is not on the PATH, while the other still reports', async () => {
    const { env } = scenarios({}, {}, bin({ pi: true }));
    const answers = await serve([HANDSHAKE, request('agents/probe', {}, 2)], agents(env));

    const { pi, 'claude-code': claude } = probes(answers(2));
    expect(pi).toMatchObject({ installed: true, usable: true });
    expect(claude).toMatchObject({ installed: false, usable: false, version: '', supports: { effort: false }, effortLevels: [] });
    expect(claude!.reason).toBe('Claude Code is not installed: no claude command was found on the PATH the engine started with');
  });

  it('reports a version too old for the lockdown as installed but not usable, saying what it lacks', async () => {
    const { env } = scenarios(
      { version: '0.10.0', missingFlags: ['--no-context-files', '--thinking'] },
      { version: '1.0.0', missingFlags: ['--strict-mcp-config'] },
      bin({ pi: true, claude: true }),
    );
    const answers = await serve([HANDSHAKE, request('agents/probe', {}, 2)], agents(env));

    const { pi, 'claude-code': claude } = probes(answers(2));
    expect(pi).toMatchObject({ installed: true, version: '0.10.0', usable: false, supports: { effort: false }, effortLevels: [] });
    expect(pi!.reason).toBe("Pi 0.10.0 lacks --no-context-files, which the companion's lockdown needs");
    expect(claude).toMatchObject({ installed: true, version: '1.0.0', usable: false, supports: { effort: true } });
    expect(claude!.reason).toBe("Claude Code 1.0.0 lacks --strict-mcp-config, which the companion's lockdown needs");
  });

  it('starts each agent from its path setting, off the PATH, and says plainly when nothing is there', async () => {
    const elsewhere = bin({ claude: true });
    const { env } = scenarios({}, { version: '2.1.296' }, bin({}));
    const paths = { pi: join(elsewhere, 'no-such-pi'), 'claude-code': join(elsewhere, 'claude') };
    const answers = await serve(
      [HANDSHAKE, request('agents/probe', {}, 2), request('agents/probe', { paths }, 3)],
      agents(env),
    );

    const before = probes(answers(2));
    expect(before['claude-code']).toMatchObject({ installed: false, usable: false });
    const after = probes(answers(3));
    expect(after['claude-code']).toMatchObject({ installed: true, version: '2.1.296', usable: true });
    expect(after['pi']).toMatchObject({ installed: false, usable: false });
    expect(after['pi']!.reason).toBe(`Pi was not found at ${paths.pi}`);
  });

  it('starts a review’s agent from the path its choice carries', async () => {
    // The fake at the path lacks part of the lockdown, so the review probes
    // it and runs nothing: its stamp names the version found at the path,
    // where the PATH holds no pi at all.
    const elsewhere = bin({ pi: true });
    const { env, piDir } = scenarios({ version: '0.1.0', lacksLockdown: true }, {}, bin({}));
    const choice = { agent: 'pi', path: join(elsewhere, 'pi') };
    const answers = await serve(
      [HANDSHAKE, request('review', { url: PR_7_URL, token: 'ghp_test-token', agent: choice }, 2)],
      agents(env),
      fixtureFetch(pull7()).fetch,
    );

    expect(answers(2).error).toBeUndefined();
    const grouping = (answers(2).result as { grouping: unknown }).grouping;
    expect(grouping).toMatchObject({ by: 'plain', agent: { stamp: { agent: 'pi', agentVersion: '0.1.0' } } });
    expect(JSON.stringify(grouping)).toContain("Pi 0.1.0 lacks --no-context-files, which the companion's lockdown needs");
    expect(fakePiRuns(piDir)).toBe(0);
  });

  it('refuses a path that is not absolute, a path for an agent it cannot drive, and a probe before the handshake', async () => {
    const answers = await serve(
      [
        request('agents/probe', {}, 1),
        HANDSHAKE.replace('"id":1', '"id":2'),
        request('agents/probe', { paths: { pi: 'bin/pi' } }, 3),
        request('agents/probe', { paths: { codex: '/usr/bin/codex' } }, 4),
        request('agents/probe', { paths: { 'claude-code': 7 } }, 5),
        request('review', { url: PR_7_URL, token: 'ghp_test-token', agent: { agent: 'pi', path: './pi' } }, 6),
      ],
      agents({ PATH: bin({}) }),
    );

    expect(answers(1).error).toMatchObject({ code: NOT_INITIALIZED_CODE });
    expect(answers(3).error).toMatchObject({ code: JSON_RPC_INVALID_PARAMS });
    expect(answers(3).error!.message).toBe('agents/probe: the pi path must be an absolute path to the executable, not "bin/pi"');
    expect(answers(4).error).toMatchObject({ code: JSON_RPC_INVALID_PARAMS });
    expect(answers(4).error!.message).toContain('"pi"?: string, "claude-code"?: string');
    expect(answers(5).error!.message).toBe('agents/probe: the claude-code path must be a string');
    expect(answers(6).error).toMatchObject({ code: JSON_RPC_INVALID_PARAMS });
    expect(answers(6).error!.message).toContain('the agent choice path must be an absolute path');
  });
});

/** How many runs the fake Pi playing the folder saw, beyond `--version` and `--help`. */
function fakePiRuns(dir: string): number {
  let text: string;
  try {
    text = readFileSync(join(dir, 'calls.jsonl'), 'utf8');
  } catch {
    return 0;
  }
  return text
    .split('\n')
    .filter((line) => line !== '')
    .filter((line) => (JSON.parse(line) as { kind: string }).kind === 'run').length;
}
