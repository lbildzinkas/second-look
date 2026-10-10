import { describe, expect, it } from 'vitest';
import { AGENT_EFFORT_LEVELS, AGENT_NAMES, agentAdapter, isAgentName, modelAndEffortProblem } from '../src/agents.js';
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

describe('modelAndEffortProblem', () => {
  it('takes a plain model and an effort the agent accepts, or neither', () => {
    expect(modelAndEffortProblem('claude-code', { model: 'claude-sonnet-5-5', effort: 'high' })).toBeUndefined();
    expect(modelAndEffortProblem('pi', { model: 'zai-coding-cn/glm-5.3:high', effort: 'minimal' })).toBeUndefined();
    expect(modelAndEffortProblem('pi', { model: 'anthropic/claude_sonnet-5.5', effort: '' })).toBeUndefined();
    expect(modelAndEffortProblem('claude-code', {})).toBeUndefined();
    for (const agent of AGENT_NAMES) {
      for (const effort of AGENT_EFFORT_LEVELS[agent]) expect(modelAndEffortProblem(agent, { effort })).toBeUndefined();
    }
  });

  it('refuses a model that starts with a dash, so it never reads as another flag', () => {
    expect(modelAndEffortProblem('claude-code', { model: '--help' })).toBe(
      'the model "--help" is not a plain name: use only letters, digits and . _ - / :, not starting with -',
    );
    expect(modelAndEffortProblem('pi', { model: '-x', effort: 'high' })).toContain('the model "-x" is not a plain name');
  });

  it('refuses a model with anything but the plain characters', () => {
    for (const model of ['sonnet --dangerously-skip-permissions', 'a;b', 'sonnet\n--help', 'opus[1m]', '$(id)']) {
      expect(modelAndEffortProblem('claude-code', { model }), model).toContain('is not a plain name');
    }
  });

  it('refuses an effort that starts with a dash', () => {
    expect(modelAndEffortProblem('pi', { effort: '--thinking' })).toBe(
      'the effort "--thinking" is not a plain level: use only letters, digits and . _ - / :, not starting with -',
    );
  });

  it('refuses an effort the chosen agent does not accept, naming the levels it does', () => {
    expect(modelAndEffortProblem('claude-code', { model: 'sonnet', effort: 'ultra' })).toBe(
      "claude-code does not accept the effort \"ultra\": choose low, medium, high, xhigh, max, or leave it empty for the agent's own default",
    );
    // Pi takes `off` and `minimal`; Claude Code does not.
    expect(modelAndEffortProblem('pi', { effort: 'off' })).toBeUndefined();
    expect(modelAndEffortProblem('claude-code', { effort: 'off' })).toContain('claude-code does not accept the effort "off"');
    expect(modelAndEffortProblem('claude-code', { effort: 'HIGH' })).toContain('does not accept the effort "HIGH"');
  });
});
