import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_AGENT_SETTINGS, runAgentTasks, type AgentTask } from '../src/agent.js';
import type { JsonSchema } from '../src/json-schema.js';
import { CLAUDE_READ_TOOLS, claudeArguments, claudeEnvironment, claudeLogin } from '../src/claude-code.js';
import { describeAgentContract } from './agent-contract.js';
import { fakeClaude } from './fake-claude.js';

// Claude Code takes an effort level but never reports one back, so a run
// without a requested effort is stamped without an effort.
describeAgentContract('Claude Code', fakeClaude, { reportsEffort: false });

const SCHEMA: JsonSchema = { type: 'object', properties: { verdict: { enum: ['yes', 'no'] } } };

const LOCKED_DOWN = [
  '--print',
  '--output-format',
  'stream-json',
  '--include-partial-messages',
  '--no-session-persistence',
  '--setting-sources',
  'user',
  '--strict-mcp-config',
  '--tools',
  'Read,Grep,Glob',
  '--permission-prompts',
  'none',
  '--system-prompt',
  'The instructions.',
];

describe('claudeArguments', () => {
  it('locks Claude Code down to print mode, user settings, no MCP servers and file-reading tools', () => {
    expect(claudeArguments({ instructions: 'The instructions.' }, true)).toEqual(LOCKED_DOWN);
  });

  it('has the answer checked against the task schema', () => {
    expect(claudeArguments({ instructions: 'The instructions.', schema: SCHEMA }, true)).toEqual([
      ...LOCKED_DOWN,
      '--json-schema',
      JSON.stringify(SCHEMA),
    ]);
  });

  it('adds the model and the effort after the lockdown', () => {
    expect(claudeArguments({ instructions: 'The instructions.', model: 'sonnet', effort: 'high' }, true)).toEqual([
      ...LOCKED_DOWN,
      '--model',
      'sonnet',
      '--effort',
      'high',
    ]);
  });

  it('leaves the effort out when the installed Claude Code cannot take one', () => {
    expect(claudeArguments({ instructions: 'The instructions.', effort: 'high' }, false)).toEqual(LOCKED_DOWN);
  });
});

describe('claudeEnvironment', () => {
  it('drops every GitHub token variable and keeps Claude Code off non-essential traffic', () => {
    const env = claudeEnvironment({
      HOME: '/home/r',
      GITHUB_TOKEN: 'a',
      GH_TOKEN: 'b',
      GH_ENTERPRISE_TOKEN: 'c',
      GITHUB_ENTERPRISE_TOKEN: 'd',
      ANTHROPIC_API_KEY: 'own',
      FAKE_AGENT_LOGIN: 'own-login',
    });
    expect(env).toEqual({
      HOME: '/home/r',
      ANTHROPIC_API_KEY: 'own',
      FAKE_AGENT_LOGIN: 'own-login',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    });
  });
});

describe('claudeLogin', () => {
  it('warns that an inherited API key overrides the subscription', () => {
    const login = claudeLogin({ ANTHROPIC_API_KEY: 'sk-ant-inherited' });
    expect(login.source).toContain('ANTHROPIC_API_KEY');
    expect(login.warning).toMatch(/overrides the Claude subscription/);
  });

  it('ignores an empty API key and names the stored subscription sign-in', () => {
    expect(claudeLogin({ ANTHROPIC_API_KEY: '' })).toEqual({ source: 'the stored Claude subscription sign-in' });
    expect(claudeLogin({})).toEqual({ source: 'the stored Claude subscription sign-in' });
  });

  it.each([
    [{ CLAUDE_CODE_OAUTH_TOKEN: 't' }, 'CLAUDE_CODE_OAUTH_TOKEN'],
    [{ CLAUDE_CODE_USE_BEDROCK: '1' }, 'Amazon Bedrock'],
    [{ CLAUDE_CODE_USE_VERTEX: 'true' }, 'Google Vertex AI'],
  ])('names the login from the environment %j', (env, expected) => {
    expect(claudeLogin(env).source).toContain(expected);
  });
});

describe('the Claude Code adapter', () => {
  const task = (root: string): AgentTask => ({
    root,
    instructions: 'The instructions.',
    prompt: 'The one fixed prompt.',
    schema: SCHEMA,
  });

  it('starts Claude Code with exactly the locked-down arguments, in the copy, with the prompt on stdin', async () => {
    const claude = fakeClaude({ runs: [{ text: '{"verdict":"yes"}' }] });
    const root = mkdtempSync(join(tmpdir(), 'second-look-copy-'));
    await runAgentTasks(claude.adapter, [task(root)], { ...DEFAULT_AGENT_SETTINGS, model: 'sonnet', effort: 'low' });
    const [run] = claude.calls().filter((call) => call.kind === 'run');
    expect(run!.args).toEqual([
      ...LOCKED_DOWN,
      '--json-schema',
      JSON.stringify(SCHEMA),
      '--model',
      'sonnet',
      '--effort',
      'low',
    ]);
    expect(run!.stdin).toBe('The one fixed prompt.');
    expect(run!.env['GITHUB_TOKEN']).toBeUndefined();
    expect(run!.env['ANTHROPIC_API_KEY']).toBeUndefined();
    expect(run!.env['CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC']).toBe('1');
    expect(realpathSync(run!.cwd)).toBe(realpathSync(root));
  });

  it('stamps each run with which login it used, and warns when an inherited API key overrides the subscription', async () => {
    const claude = fakeClaude(
      { runs: [{ text: '{"verdict":"yes"}' }] },
      { env: { ANTHROPIC_API_KEY: 'sk-ant-inherited' } },
    );
    const root = mkdtempSync(join(tmpdir(), 'second-look-copy-'));
    const { results } = await runAgentTasks(claude.adapter, [task(root)], DEFAULT_AGENT_SETTINGS);
    expect(results[0]!.ok).toBe(true);
    const login = results[0]!.stamp.login;
    expect(login?.source).toContain('ANTHROPIC_API_KEY');
    expect(login?.warning).toMatch(/overrides the Claude subscription/);
  });

  it('stamps the stored subscription sign-in when no key is inherited', async () => {
    const claude = fakeClaude({ runs: [{ text: '{"verdict":"yes"}' }] });
    const root = mkdtempSync(join(tmpdir(), 'second-look-copy-'));
    const { results } = await runAgentTasks(claude.adapter, [task(root)], DEFAULT_AGENT_SETTINGS);
    expect(results[0]!.stamp.login).toEqual({ source: 'the stored Claude subscription sign-in' });
  });

  it('refuses to run a version that lacks part of the lockdown', async () => {
    const claude = fakeClaude({ lacksLockdown: true, runs: [{ text: '{"verdict":"yes"}' }] });
    const root = mkdtempSync(join(tmpdir(), 'second-look-copy-'));
    const { probe, results } = await runAgentTasks(claude.adapter, [task(root)], DEFAULT_AGENT_SETTINGS);
    expect(probe.usable).toBe(false);
    expect(probe.reason).toMatch(/Claude Code .+ lacks --strict-mcp-config/);
    expect(results[0]).toMatchObject({ ok: false, reason: 'unusable' });
    expect(claude.runs()).toHaveLength(0);
  });

  it('reads the version out of Claude Code\u2019s own version line', async () => {
    const claude = fakeClaude({ version: '2.1.280', runs: [] });
    const probe = await claude.adapter.probe();
    expect(probe).toMatchObject({ agent: 'claude-code', version: '2.1.280', usable: true });
    expect(probe.lockdown).toContain(
      `tool allowlist: ${CLAUDE_READ_TOOLS.join(', ')} (no shell, no network, no edits)`,
    );
  });
});
