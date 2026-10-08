import { describe, expect, it } from 'vitest';
import { AGENT_NAMES, agentAdapter, isAgentName } from '../src/agents.js';
import { CLAUDE_GUARD, FAKE_CLAUDE, fakeClaude } from './fake-claude.js';
import { FAKE_PI, GUARD, fakePi } from './fake-pi.js';

describe('agentAdapter', () => {
  it('offers the agents the settings name, Pi and Claude Code', () => {
    expect(AGENT_NAMES).toEqual(['pi', 'claude-code']);
    expect(isAgentName('pi')).toBe(true);
    expect(isAgentName('claude-code')).toBe(true);
    expect(isAgentName('codex')).toBe(false);
  });

  it('starts the named adapter, which stamps itself with its agent name', async () => {
    const pi = fakePi({ version: '0.86.1', runs: [] });
    const claude = fakeClaude({ version: '2.1.280', runs: [] });
    const named = agentAdapter('pi', {
      pi: { command: [process.execPath, FAKE_PI], guardPath: GUARD },
      env: { PATH: process.env['PATH'], FAKE_PI_DIR: pi.dir },
    });
    const other = agentAdapter('claude-code', {
      claudeCode: { command: [process.execPath, FAKE_CLAUDE], guardPath: CLAUDE_GUARD },
      env: { PATH: process.env['PATH'], FAKE_CLAUDE_DIR: claude.dir },
    });
    expect(named.agent).toBe('pi');
    expect(other.agent).toBe('claude-code');
    expect((await named.probe()).version).toBe('0.86.1');
    expect((await other.probe()).version).toBe('2.1.280');
  });

  it('refuses an unknown name with the choices, so a typo never picks another agent', () => {
    expect(() => agentAdapter('codex')).toThrow('unknown agent "codex": choose pi or claude-code');
  });
});
