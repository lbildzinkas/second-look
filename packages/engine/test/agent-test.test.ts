import { existsSync, readdirSync, statSync } from 'node:fs';
import { basename } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AgentAdapter, AgentProbe, AgentRunRequest } from '../src/agent.js';
import { AGENT_TEST_INSTRUCTIONS, AGENT_TEST_PROMPT, AGENT_TEST_SCHEMA, testAgent, type AgentTestResult } from '../src/agent-test.js';
import type { AgentName } from '../src/agents.js';
import { removeCopy } from '../src/cache.js';
import { claudeArguments, guardHookCommand } from '../src/claude-code.js';
import { ENGINE_PROTOCOL_VERSION, JSON_RPC_INVALID_PARAMS, NOT_INITIALIZED_CODE } from '../src/rpc.js';
import { runRpcServer, type RpcAgentDeps } from '../src/server.js';
import { ENGINE_GITHUB_TOKEN } from './agent-contract.js';
import { CLAUDE_GUARD, fakeClaude, type FakeClaudeScenario } from './fake-claude.js';
import { fakePi, type FakePiScenario } from './fake-pi.js';
import { temporaryCacheDir } from './helpers.js';

/**
 * The agents/test request (issue 132): one tiny run of the chosen agent,
 * model and effort, locked down as a review runs it, against the fake
 * agents.
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

type Fake = ReturnType<typeof fakeClaude> | ReturnType<typeof fakePi>;

/** The engine's agents, each name starting the fake that plays it. */
function agents(fakes: Partial<Record<AgentName, Fake>>, timeoutMs = 10_000): RpcAgentDeps {
  return {
    adapterFor: (name) => fakes[name]!.adapter,
    defaultAgent: 'pi',
    settings: { timeoutMs, concurrency: 1 },
  };
}

function request(method: string, params: unknown, id: number): string {
  return JSON.stringify({ jsonrpc: '2.0', id, method, params });
}

const HANDSHAKE = request('initialize', { protocolVersion: ENGINE_PROTOCOL_VERSION }, 1);

/** Runs the server over the lines with the given agents; answers by request id. */
async function serve(lines: string[], agent: RpcAgentDeps): Promise<(id: number) => Response> {
  let index = 0;
  const written: string[] = [];
  await runRpcServer(
    { readLine: async () => (index < lines.length ? lines[index++]! : null) },
    { writeLine: (line) => written.push(line) },
    { cacheDir, agent },
  );
  const responses = written.map((line) => JSON.parse(line) as Response);
  return (id) => responses.find((response) => response.id === id)!;
}

/** The answer to one test request of `choice`. */
async function test(choice: Record<string, unknown>, deps: RpcAgentDeps): Promise<AgentTestResult> {
  const answers = await serve([HANDSHAKE, request('agents/test', { agent: choice }, 2)], deps);
  expect(answers(2).error).toBeUndefined();
  return answers(2).result as AgentTestResult;
}

const CLAUDE_UNKNOWN_MODEL =
  "There's an issue with the selected model (bogus-model). It may not exist or you may not have access to it. " +
  'Run --model to pick a different model.';

describe('agents/test', () => {
  it('runs Claude Code once, locked down as a review runs it, in an empty folder removed afterwards, and answers with the stamp', async () => {
    const claude = fakeClaude({
      version: '2.1.296',
      runs: [{ text: '{"ok":true}', model: 'claude-sonnet-5-5' }],
    } satisfies FakeClaudeScenario);
    const result = await test(
      { agent: 'claude-code', model: 'claude-sonnet-5-5', effort: 'high', account: 'work subscription' },
      agents({ 'claude-code': claude }),
    );

    expect(result).toMatchObject({
      ok: true,
      stamp: {
        agent: 'claude-code',
        agentVersion: '2.1.296',
        model: 'claude-sonnet-5-5',
        effort: 'high',
        login: { source: 'the stored Claude subscription sign-in' },
        account: 'work subscription',
        tokens: { input: 100, output: 20, cacheRead: 5, cacheWrite: 0, total: 125 },
        costUsd: 0.01,
      },
    });
    const runs = claude.runs();
    expect(runs).toHaveLength(1);
    const [run] = runs;
    const hook = guardHookCommand(process.execPath, CLAUDE_GUARD);
    expect(claude.calls()[0]!.args).toEqual(
      claudeArguments(
        { instructions: AGENT_TEST_INSTRUCTIONS, schema: AGENT_TEST_SCHEMA, model: 'claude-sonnet-5-5', effort: 'high' },
        true,
        hook,
      ),
    );
    expect(run!.prompt).toBe(AGENT_TEST_PROMPT);
    expect(basename(run!.cwd)).toMatch(/^second-look-agent-test-/);
    // The fake reports its working folder resolved, as macOS's /var is a link to /private/var.
    const root = run!.env['SECOND_LOOK_READ_ROOT']!;
    expect(basename(root)).toBe(basename(run!.cwd));
    expect(run!.env['GITHUB_TOKEN']).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain(ENGINE_GITHUB_TOKEN);
    expect(existsSync(root)).toBe(false);
    expect(existsSync(run!.cwd)).toBe(false);
  });

  it('says in plain words that Claude Code cannot run a bad model', async () => {
    const claude = fakeClaude({ runs: [{ error: CLAUDE_UNKNOWN_MODEL }] });
    const result = await test({ agent: 'claude-code', model: 'bogus-model', effort: 'high' }, agents({ 'claude-code': claude }));

    expect(result).toMatchObject({ ok: false, reason: 'unknown-model', stamp: { agent: 'claude-code', effort: 'high' } });
    expect(result.ok === false && result.message).toBe(`Claude Code cannot run the model "bogus-model": ${CLAUDE_UNKNOWN_MODEL}`);
    expect(claude.runs()).toHaveLength(1);
    expect(existsSync(claude.runs()[0]!.cwd)).toBe(false);
  });

  it('says in plain words that Claude Code is not signed in, naming the login it used', async () => {
    const claude = fakeClaude(
      { runs: [{ error: 'Invalid API key · Fix external API key' }] },
      { env: { ANTHROPIC_API_KEY: 'sk-ant-not-a-real-key' } },
    );
    const result = await test({ agent: 'claude-code', model: 'claude-sonnet-5-5' }, agents({ 'claude-code': claude }));

    expect(result).toMatchObject({ ok: false, reason: 'not-signed-in' });
    expect(result.ok === false && result.message).toBe('Claude Code is not signed in: Invalid API key · Fix external API key');
    expect(result.stamp.login!.source).toContain('ANTHROPIC_API_KEY');
    expect(JSON.stringify(result)).not.toContain('sk-ant-not-a-real-key');
  });

  it('says in plain words that Pi cannot run a bad model, or is not signed in', async () => {
    const badModel = fakePi({ runs: [{ error: 'Model "fake-provider/bogus-model" not found' }] } satisfies FakePiScenario);
    const signedOut = fakePi({ runs: [{ error: 'No API key found for fake-provider' }] });

    const model = await test({ agent: 'pi', model: 'fake-provider/bogus-model' }, agents({ pi: badModel }));
    const login = await test({ agent: 'pi', model: 'fake-provider/fake-model' }, agents({ pi: signedOut }));

    expect(model).toMatchObject({ ok: false, reason: 'unknown-model', stamp: { agent: 'pi' } });
    expect(model.ok === false && model.message).toBe(
      'Pi cannot run the model "fake-provider/bogus-model": Model "fake-provider/bogus-model" not found',
    );
    expect(login).toMatchObject({ ok: false, reason: 'not-signed-in' });
    expect(login.ok === false && login.message).toBe('Pi is not signed in: No API key found for fake-provider');
  });

  it('says in plain words when the agent does not answer in time, and still removes the folder', async () => {
    const claude = fakeClaude({ runs: [{ hang: true, partial: '{"ok"' }] });
    const result = await test({ agent: 'claude-code' }, agents({ 'claude-code': claude }, 2000));

    expect(result).toMatchObject({ ok: false, reason: 'timeout', message: 'Claude Code did not answer within 2 seconds' });
    expect(existsSync(claude.runs()[0]!.cwd)).toBe(false);
  });

  it('fails an answer that is not the one-field JSON the test asks for', async () => {
    const pi = fakePi({ runs: [{ text: '{"ok":false}' }] });
    const result = await test({ agent: 'pi' }, agents({ pi }));

    expect(result).toMatchObject({ ok: false, reason: 'invalid-answer' });
    expect(result.ok === false && result.message).toContain('Pi answered, but not with the JSON the test asks for');
    expect(pi.runs()).toHaveLength(1);
  });

  it('runs nothing when the agent cannot be locked down or is not installed, and says why', async () => {
    const old = fakeClaude({ version: '1.0.0', lacksLockdown: true, runs: [{ text: '{"ok":true}' }] });
    const missing = fakePi({ notInstalled: true, runs: [{ text: '{"ok":true}' }] });

    const lacks = await test({ agent: 'claude-code' }, agents({ 'claude-code': old }));
    const absent = await test({ agent: 'pi' }, agents({ pi: missing }));

    expect(lacks).toMatchObject({
      ok: false,
      reason: 'unusable',
      message: "Claude Code 1.0.0 lacks --strict-mcp-config, which the companion's lockdown needs",
      stamp: { agent: 'claude-code', agentVersion: '1.0.0', model: null },
    });
    expect(absent).toMatchObject({ ok: false, reason: 'unusable', stamp: { agent: 'pi', agentVersion: '' } });
    expect(old.runs()).toHaveLength(0);
    expect(missing.runs()).toHaveLength(0);
  });

  it('refuses a test before the handshake, without an agent choice, or with a choice the engine cannot run', async () => {
    const pi = fakePi({ runs: [{ text: '{"ok":true}' }] });
    const answers = await serve(
      [
        request('agents/test', { agent: { agent: 'pi' } }, 1),
        HANDSHAKE.replace('"id":1', '"id":2'),
        request('agents/test', {}, 3),
        request('agents/test', { agent: { agent: 'codex' } }, 4),
        request('agents/test', { agent: { agent: 'pi', effort: 'turbo' } }, 5),
        request('agents/test', { agent: { agent: 'pi', model: '--dangerous' } }, 6),
      ],
      agents({ pi }),
    );

    expect(answers(1).error).toMatchObject({ code: NOT_INITIALIZED_CODE });
    for (const id of [3, 4, 5, 6]) expect(answers(id).error).toMatchObject({ code: JSON_RPC_INVALID_PARAMS });
    expect(answers(3).error!.message).toContain('the agent choice must be an object');
    expect(answers(4).error!.message).toContain('the agent choice names an agent the engine cannot drive');
    expect(answers(5).error!.message).toContain('pi does not accept the effort "turbo"');
    expect(answers(6).error!.message).toContain('is not a plain name');
    expect(pi.runs()).toHaveLength(0);
  });
});

describe('testAgent', () => {
  it('hands the one run an empty folder it cannot write to', async () => {
    const seen: { entries: string[]; writable: boolean }[] = [];
    const probe: AgentProbe = {
      agent: 'pi',
      installed: true,
      version: '1.0.0',
      usable: true,
      supports: { effort: true },
      effortLevels: [],
      lockdown: ['a stub'],
    };
    const adapter: AgentAdapter = {
      agent: 'pi',
      probe: async () => probe,
      run: async (request: AgentRunRequest) => {
        seen.push({ entries: readdirSync(request.root), writable: (statSync(request.root).mode & 0o222) !== 0 });
        const stamp = { agent: 'pi', agentVersion: '1.0.0', model: 'stub/model', effort: null, runAt: new Date().toISOString() };
        return { status: 'completed', text: '{"ok":true}', stamp };
      },
    };

    const result = await testAgent(adapter, 'pi', { timeoutMs: 1000, concurrency: 1 });

    expect(result).toMatchObject({ ok: true, stamp: { model: 'stub/model' } });
    expect(seen).toEqual([{ entries: [], writable: false }]);
  });
});
