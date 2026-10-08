import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_AGENT_SETTINGS, runAgentTasks, type AgentTask } from '../src/agent.js';
import type { JsonSchema } from '../src/json-schema.js';
import {
  claudeArguments,
  claudeEnvironment,
  claudeLogin,
  claudeRunEnvironment,
  claudeSettings,
  credentialDenyRules,
  guardHookCommand,
} from '../src/claude-code.js';
import { CLAUDE_READ_TOOLS } from '../src/claude-guard-check.js';
import { CREDENTIAL_PATHS } from '../src/read-guard.js';
import { describeAgentContract } from './agent-contract.js';
import { CLAUDE_GUARD, fakeClaude } from './fake-claude.js';

// Claude Code takes an effort level but never reports one back, so a run
// without a requested effort is stamped without an effort.
describeAgentContract('Claude Code', fakeClaude, { reportsEffort: false });

const SCHEMA: JsonSchema = { type: 'object', properties: { verdict: { enum: ['yes', 'no'] } } };

const HOOK = '"/usr/bin/node" "/engine/dist/claude-guard.js"';

const lockedDown = (hookCommand: string): string[] => [
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
  '--permission-mode',
  'default',
  '--settings',
  claudeSettings(hookCommand),
  '--system-prompt',
  'The instructions.',
];

const LOCKED_DOWN = lockedDown(HOOK);

describe('claudeArguments', () => {
  it('locks Claude Code down to print mode, user settings, no MCP servers, file-reading tools, the default mode and the guard', () => {
    expect(claudeArguments({ instructions: 'The instructions.' }, true, HOOK)).toEqual(LOCKED_DOWN);
  });

  it('has the answer checked against the task schema', () => {
    expect(claudeArguments({ instructions: 'The instructions.', schema: SCHEMA }, true, HOOK)).toEqual([
      ...LOCKED_DOWN,
      '--json-schema',
      JSON.stringify(SCHEMA),
    ]);
  });

  it('adds the model and the effort after the lockdown', () => {
    expect(claudeArguments({ instructions: 'The instructions.', model: 'sonnet', effort: 'high' }, true, HOOK)).toEqual([
      ...LOCKED_DOWN,
      '--model',
      'sonnet',
      '--effort',
      'high',
    ]);
  });

  it('leaves the effort out when the installed Claude Code cannot take one', () => {
    expect(claudeArguments({ instructions: 'The instructions.', effort: 'high' }, false, HOOK)).toEqual(LOCKED_DOWN);
  });
});

describe('claudeSettings', () => {
  it('pins hooks on and runs the guard hook before every tool', () => {
    const settings = JSON.parse(claudeSettings(HOOK)) as {
      disableAllHooks: boolean;
      hooks: { PreToolUse: { matcher: string; hooks: { type: string; command: string; timeout: number }[] }[] };
    };
    expect(settings.disableAllHooks).toBe(false);
    expect(settings.hooks).toEqual({
      PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: HOOK, timeout: 30 }] }],
    });
  });

  it('denies reading every credential path, folders with everything in them', () => {
    const settings = JSON.parse(claudeSettings(HOOK)) as { permissions: { deny: string[] } };
    expect(settings.permissions.deny).toEqual(credentialDenyRules());
    expect(settings.permissions.deny).toEqual(
      expect.arrayContaining(['Read(~/.ssh)', 'Read(~/.ssh/**)', 'Read(~/.config/gh/**)', 'Read(~/.netrc)', 'Read(~/.claude/.credentials.json)']),
    );
    expect(settings.permissions.deny).not.toContain('Read(~/.netrc/**)');
    const folders = CREDENTIAL_PATHS.filter((credential) => credential.folder).length;
    expect(settings.permissions.deny).toHaveLength(CREDENTIAL_PATHS.length + folders);
  });
});

describe('guardHookCommand', () => {
  it('quotes the Node binary and the guard script', () => {
    expect(guardHookCommand('/usr/bin/node', '/engine/dist/claude-guard.js', 'linux')).toBe(
      '"/usr/bin/node" "/engine/dist/claude-guard.js"',
    );
    expect(
      guardHookCommand('/Applications/Code.app/Contents/MacOS/Code Helper (Plugin)', '/x/claude-guard.js', 'darwin'),
    ).toBe('"/Applications/Code.app/Contents/MacOS/Code Helper (Plugin)" "/x/claude-guard.js"');
    expect(guardHookCommand('C:\\Program Files\\nodejs\\node.exe', 'C:\\x\\claude-guard.js', 'win32')).toBe(
      '"C:\\Program Files\\nodejs\\node.exe" "C:\\x\\claude-guard.js"',
    );
  });

  it.each(['/x/a"; touch /tmp/p; "', '/x/`id`', '/x/$(id)', '/x/$HOME', '/x/a\nb', '/x/a\\"'])(
    'refuses a path that could change the command: %j',
    (path) => {
      expect(() => guardHookCommand(path, '/x/claude-guard.js', 'linux')).toThrow(/could change the guard's hook command/);
      expect(() => guardHookCommand('/usr/bin/node', path, 'darwin')).toThrow(/could change the guard's hook command/);
    },
  );

  it('refuses a backslash outside Windows, and a % on Windows', () => {
    expect(() => guardHookCommand('/usr/bin/node', '/x\\claude-guard.js', 'linux')).toThrow();
    expect(() => guardHookCommand('C:\\node.exe', 'C:\\%TEMP%\\claude-guard.js', 'win32')).toThrow();
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

describe('claudeRunEnvironment', () => {
  it('names the copy and the audit file for the guard, and runs the guard as Node inside the editor', () => {
    const env = claudeRunEnvironment({ HOME: '/home/r', GITHUB_TOKEN: 'a' }, '/copy', '/audit/audit.jsonl');
    expect(env).toEqual({
      HOME: '/home/r',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      SECOND_LOOK_READ_ROOT: '/copy',
      SECOND_LOOK_GUARD_AUDIT: '/audit/audit.jsonl',
      ELECTRON_RUN_AS_NODE: '1',
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
      ...lockedDown(`"${process.execPath}" "${CLAUDE_GUARD}"`),
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
    expect(run!.env['SECOND_LOOK_READ_ROOT']).toBe(root);
    expect(run!.env['ELECTRON_RUN_AS_NODE']).toBe('1');
    expect(realpathSync(run!.cwd)).toBe(realpathSync(root));
  });

  it('keeps the audit file outside the copy and removes it after the run', async () => {
    const claude = fakeClaude({ runs: [{ text: '{"verdict":"yes"}' }] });
    const root = mkdtempSync(join(tmpdir(), 'second-look-copy-'));
    await runAgentTasks(claude.adapter, [task(root)], DEFAULT_AGENT_SETTINGS);
    const [run] = claude.calls().filter((call) => call.kind === 'run');
    const audit = run!.env['SECOND_LOOK_GUARD_AUDIT']!;
    expect(audit).toMatch(/audit\.jsonl$/);
    expect(audit.startsWith(root)).toBe(false);
    expect(existsSync(dirname(audit))).toBe(false);
  });

  it('runs the guard on every tool call: in-copy reads pass, outside reads are refused, the answer stands', async () => {
    const root = mkdtempSync(join(tmpdir(), 'second-look-copy-'));
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'src', 'a.ts'), 'export const a = 1;\n');
    const claude = fakeClaude({
      runs: [
        {
          text: '{"verdict":"yes"}',
          toolCalls: [
            { name: 'Read', input: { file_path: join(root, 'src', 'a.ts') } },
            { name: 'Read', input: { file_path: '/etc/hosts' } },
            { name: 'Glob', input: { pattern: '/etc/*' } },
            { name: 'Bash', input: { command: 'cat /etc/hosts' } },
            { name: 'StructuredOutput', input: { verdict: 'yes' } },
          ],
        },
      ],
    });
    const { results } = await runAgentTasks(claude.adapter, [task(root)], DEFAULT_AGENT_SETTINGS);
    expect(results[0]).toMatchObject({ ok: true, answer: { verdict: 'yes' } });
    const hooks = claude.calls().filter((call) => call.kind === 'hook');
    expect(hooks.map((hook) => [hook.tool, hook.status])).toEqual([
      ['Read', 0],
      ['Read', 0],
      ['Glob', 0],
      ['Bash', 0],
      ['StructuredOutput', 0],
    ]);
    const decisions = hooks.map((hook) => (hook.stdout === '' ? 'pass' : JSON.parse(hook.stdout!).hookSpecificOutput.permissionDecision));
    expect(decisions).toEqual(['pass', 'deny', 'deny', 'deny', 'pass']);
    expect(hooks.every((hook) => !hook.stdout!.includes('"allow"') && !hook.stdout!.includes('updatedInput'))).toBe(true);
  });

  it('fails the run and discards what it wrote when a tool call never reached the guard', async () => {
    const root = mkdtempSync(join(tmpdir(), 'second-look-copy-'));
    const claude = fakeClaude({
      runs: [{ text: '{"verdict":"yes"}', skipGuard: true, toolCalls: [{ name: 'Read', input: { file_path: '/etc/hosts' } }] }],
    });
    const { results } = await runAgentTasks(claude.adapter, [task(root)], DEFAULT_AGENT_SETTINGS);
    expect(results[0]).toMatchObject({ ok: false, reason: 'agent-failed', attempts: 1, partial: '' });
    expect(results[0]!.ok === false && results[0]!.message).toMatch(
      /ran tool call toolu_fake_0_0 without the companion's guard, so the answer is discarded/,
    );
  });

  it('needs no audit line for a call Claude Code denied itself by a permission rule, before the hook', async () => {
    const root = mkdtempSync(join(tmpdir(), 'second-look-copy-'));
    const claude = fakeClaude({
      runs: [
        {
          text: '{"verdict":"yes"}',
          toolCalls: [
            { name: 'Read', input: { file_path: '~/.ssh/second-look-probe-does-not-exist' }, deniedByRule: true },
            { name: 'Read', input: { file_path: '/etc/hosts' } },
          ],
        },
      ],
    });
    const { results } = await runAgentTasks(claude.adapter, [task(root)], DEFAULT_AGENT_SETTINGS);
    expect(results[0]).toMatchObject({ ok: true, answer: { verdict: 'yes' } });
    expect(claude.calls().filter((call) => call.kind === 'hook').map((hook) => hook.id)).toEqual(['toolu_fake_0_1']);
  });

  it('fails the run when Claude Code reports a permission mode other than default', async () => {
    const root = mkdtempSync(join(tmpdir(), 'second-look-copy-'));
    const claude = fakeClaude({ runs: [{ text: '{"verdict":"yes"}', permissionMode: 'auto' }] });
    const { results } = await runAgentTasks(claude.adapter, [task(root)], DEFAULT_AGENT_SETTINGS);
    expect(results[0]).toMatchObject({ ok: false, reason: 'agent-failed', partial: '' });
    expect(results[0]!.ok === false && results[0]!.message).toMatch(/ran in the auto permission mode instead of default/);
  });

  it.each([
    ['answers nothing', 'process.stdin.resume(); process.stdin.on("end", () => process.exit(0));', /did not refuse a read outside the copy/],
    ['crashes', 'process.exit(1);', /the hook exited with 1/],
    ['allows the read', 'process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" } }));', /did not refuse/],
  ])('is unusable when the guard hook %s on an outside read', async (_name, script, reason) => {
    const guard = join(mkdtempSync(join(tmpdir(), 'second-look-bad-guard-')), 'guard.mjs');
    writeFileSync(guard, `${script}\n`);
    const claude = fakeClaude({ runs: [{ text: '{"verdict":"yes"}' }] }, { guardPath: guard });
    const root = mkdtempSync(join(tmpdir(), 'second-look-copy-'));
    const { probe, results } = await runAgentTasks(claude.adapter, [task(root)], DEFAULT_AGENT_SETTINGS);
    expect(probe.usable).toBe(false);
    expect(probe.reason).toMatch(/the companion's guard could not be run/);
    expect(probe.reason).toMatch(reason);
    expect(results[0]).toMatchObject({ ok: false, reason: 'unusable' });
    expect(claude.runs()).toHaveLength(0);
  });

  it('is unusable when the guard refuses but writes no audit line', async () => {
    const guard = join(mkdtempSync(join(tmpdir(), 'second-look-bad-guard-')), 'guard.mjs');
    const deny = { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'no' } };
    writeFileSync(guard, `process.stdout.write(${JSON.stringify(JSON.stringify(deny))});\n`);
    const probe = await fakeClaude({ runs: [] }, { guardPath: guard }).adapter.probe();
    expect(probe).toMatchObject({ usable: false });
    expect(probe.reason).toMatch(/did not write its audit line/);
  });

  it('is unusable when the guard is missing, or its path could change the hook command', async () => {
    const missing = await fakeClaude({ runs: [] }, { guardPath: join(tmpdir(), 'no-such-second-look-guard.js') }).adapter.probe();
    expect(missing).toMatchObject({ usable: false });
    expect(missing.reason).toMatch(/the companion's guard is missing/);
    const dir = mkdtempSync(join(tmpdir(), 'second-look-$guard-'));
    const unsafe = join(dir, 'claude-guard.mjs');
    writeFileSync(unsafe, '');
    const injected = await fakeClaude({ runs: [] }, { guardPath: unsafe }).adapter.probe();
    expect(injected).toMatchObject({ usable: false });
    expect(injected.reason).toMatch(/cannot be handed to Claude Code safely/);
  });

  it.each(['--settings', '--permission-mode'])('refuses to run a version whose help lacks %s', async (flag) => {
    const claude = fakeClaude({ missingFlags: [flag], runs: [{ text: '{"verdict":"yes"}' }] });
    const probe = await claude.adapter.probe();
    expect(probe.usable).toBe(false);
    expect(probe.reason).toContain(`lacks ${flag}`);
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
    expect(probe.lockdown.join('\n')).toMatch(/guard hook checks every tool call/);
    expect(probe.lockdown.join('\n')).toMatch(/permission mode pinned to default/);
  });
});
