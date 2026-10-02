import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_AGENT_SETTINGS, runAgentTasks } from '../src/agent.js';
import { piArguments, piEnvironment } from '../src/pi.js';
import { describeAgentContract } from './agent-contract.js';
import { GUARD, fakePi } from './fake-pi.js';

describeAgentContract('Pi', fakePi);

const LOCKED_DOWN = [
  '--mode',
  'json',
  '--no-session',
  '--offline',
  '--no-approve',
  '--no-extensions',
  '--extension',
  '/guard/pi-guard.js',
  '--no-skills',
  '--no-prompt-templates',
  '--no-themes',
  '--no-context-files',
  '--tools',
  'read,grep,find,ls',
  '--system-prompt',
  'The instructions.',
];

describe('piArguments', () => {
  it('locks Pi down to the companion guard and file-reading tools', () => {
    expect(piArguments({ instructions: 'The instructions.' }, '/guard/pi-guard.js', true)).toEqual(LOCKED_DOWN);
  });

  it('adds the model and the effort after the lockdown', () => {
    expect(
      piArguments({ instructions: 'The instructions.', model: 'anthropic/x', effort: 'high' }, '/guard/pi-guard.js', true),
    ).toEqual([...LOCKED_DOWN, '--model', 'anthropic/x', '--thinking', 'high']);
  });

  it('leaves the effort out when the installed Pi cannot take one', () => {
    expect(piArguments({ instructions: 'The instructions.', effort: 'high' }, '/guard/pi-guard.js', false)).toEqual(
      LOCKED_DOWN,
    );
  });
});

describe('piEnvironment', () => {
  it('drops every GitHub token variable, names the read root and keeps Pi offline', () => {
    const env = piEnvironment(
      { HOME: '/home/r', GITHUB_TOKEN: 'a', GH_TOKEN: 'b', GH_ENTERPRISE_TOKEN: 'c', GITHUB_ENTERPRISE_TOKEN: 'd', ANTHROPIC_API_KEY: 'own' },
      '/copy',
    );
    expect(env).toEqual({
      HOME: '/home/r',
      ANTHROPIC_API_KEY: 'own',
      SECOND_LOOK_READ_ROOT: '/copy',
      PI_OFFLINE: '1',
      PI_TELEMETRY: '0',
    });
  });
});

describe('the Pi adapter', () => {
  it('starts Pi with exactly the locked-down arguments, in the copy, with the prompt on stdin', async () => {
    const pi = fakePi({ runs: [{ text: '{"verdict":"yes"}' }] });
    const root = mkdtempSync(join(tmpdir(), 'second-look-copy-'));
    await runAgentTasks(
      pi.adapter,
      [{ root, instructions: 'The instructions.', prompt: '@README.md --help', schema: {} }],
      { ...DEFAULT_AGENT_SETTINGS, model: 'fake/m', effort: 'low' },
    );
    const [run] = pi.calls().filter((call) => call.kind === 'run');
    expect(run!.args).toEqual([
      ...LOCKED_DOWN.map((arg) => (arg === '/guard/pi-guard.js' ? GUARD : arg)),
      '--model',
      'fake/m',
      '--thinking',
      'low',
    ]);
    expect(run!.stdin).toBe('@README.md --help');
    expect(run!.env).toMatchObject({ SECOND_LOOK_READ_ROOT: root, PI_OFFLINE: '1', PI_TELEMETRY: '0' });
  });

  it('refuses to run when the guard extension is missing', async () => {
    const pi = fakePi({ runs: [{ text: '{}' }] }, { guardPath: join(tmpdir(), 'no-such-second-look-guard.js') });
    const root = mkdtempSync(join(tmpdir(), 'second-look-copy-'));
    const { probe, results } = await runAgentTasks(pi.adapter, [{ root, instructions: 'i', prompt: 'p', schema: {} }]);
    expect(probe.usable).toBe(false);
    expect(probe.reason).toMatch(/guard is missing/);
    expect(results[0]).toMatchObject({ ok: false, reason: 'unusable' });
    expect(pi.runs()).toHaveLength(0);
  });

  it('counts the tokens of every model turn, tool calls included', async () => {
    const pi = fakePi({ runs: [{ text: '{"verdict":"yes"}', toolUse: true }] });
    const root = mkdtempSync(join(tmpdir(), 'second-look-copy-'));
    const { results } = await runAgentTasks(pi.adapter, [
      { root, instructions: 'i', prompt: 'p', schema: {} },
    ]);
    expect(results[0]!.stamp!.tokens).toMatchObject({ input: 200, output: 40, total: 250 });
    expect(results[0]!.stamp!.costUsd).toBeCloseTo(0.02);
  });
});
