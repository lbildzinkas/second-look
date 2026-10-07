import { beforeEach, describe, expect, it } from 'vitest';
import { AGENT_NAMES } from '@second-look/engine';
import { stub, stubContext } from './vscode-stub.js';
import { activate } from '../src/extension.js';
import { AgentStatusBar } from '../src/agent-status.js';
import {
  apiKeyOverrideWarning,
  agentStatusBarText,
  readAgentSettings,
  reviewAgentChoice,
  untestedModelWarning,
  type AgentSettings,
} from '../src/agent-settings.js';
import type { TestedModel } from '@second-look/engine';

const CLAUDE_CODE: AgentSettings = { agent: 'claude-code', model: 'sonnet', account: 'Claude Max (work)' };

describe('readAgentSettings', () => {
  beforeEach(() => stub.reset());

  it('defaults to Pi, the agent\u2019s own model and no account label', () => {
    expect(readAgentSettings()).toEqual({ agent: 'pi', model: '', account: '' });
  });

  it('reads the agent, model and account the settings carry', () => {
    stub.configuration = {
      'second-look.agent': 'claude-code',
      'second-look.agentModel': ' sonnet ',
      'second-look.agentAccount': ' Claude Max (work) ',
    };
    expect(readAgentSettings()).toEqual(CLAUDE_CODE);
  });

  it('offers every agent the engine can drive, by the engine\u2019s own list', () => {
    for (const agent of AGENT_NAMES) {
      stub.configuration = { 'second-look.agent': agent };
      expect(readAgentSettings().agent).toBe(agent);
    }
  });

  it('falls back to Pi on a value the settings no longer offer', () => {
    stub.configuration = { 'second-look.agent': 'codex' };
    expect(readAgentSettings().agent).toBe('pi');
  });
});

describe('reviewAgentChoice', () => {
  it('carries the agent, model and account the settings chose, as the review request does', () => {
    expect(reviewAgentChoice(CLAUDE_CODE)).toEqual({
      agent: 'claude-code',
      model: 'sonnet',
      account: 'Claude Max (work)',
    });
    expect(reviewAgentChoice({ agent: 'pi', model: '', account: '' })).toEqual({
      agent: 'pi',
      model: '',
      account: '',
    });
  });
});

describe('apiKeyOverrideWarning', () => {
  it('warns when Claude Code is the agent and an API key is inherited', () => {
    const warning = apiKeyOverrideWarning({ agent: 'claude-code', model: '', account: '' }, { ANTHROPIC_API_KEY: 'k' });
    expect(warning).toContain('ANTHROPIC_API_KEY');
    expect(warning).toMatch(/overrides the Claude subscription/);
  });

  it('stays quiet for Pi, or when no key is inherited', () => {
    expect(apiKeyOverrideWarning({ agent: 'pi', model: '', account: '' }, { ANTHROPIC_API_KEY: 'k' })).toBeUndefined();
    expect(apiKeyOverrideWarning(CLAUDE_CODE, {})).toBeUndefined();
    expect(apiKeyOverrideWarning(CLAUDE_CODE, { ANTHROPIC_API_KEY: '' })).toBeUndefined();
  });
});

describe('agentStatusBarText', () => {
  it('shows the agent and model in use, and the account when labelled', () => {
    expect(agentStatusBarText({ agent: 'pi', model: '', account: '' })).toBe('Second Look: Pi · default model');
    expect(agentStatusBarText(CLAUDE_CODE)).toBe('Second Look: Claude Code · sonnet · Claude Max (work)');
  });
});

describe('untestedModelWarning', () => {
  const TESTED: readonly TestedModel[] = [
    { agent: 'pi', agentVersion: '0.86.1', model: 'zai-coding-cn/glm-5.3', effort: 'default', runDate: '2026-10-07T15:08:38.849Z', scores: { coverage: 1 } },
  ];

  it('stays quiet for a tested agent and model', () => {
    expect(untestedModelWarning({ agent: 'pi', model: 'zai-coding-cn/glm-5.3', account: '' }, TESTED)).toBeUndefined();
  });

  it('stays quiet for an agent with a tested model when no model is chosen: only the run’s stamp tells which runs', () => {
    expect(untestedModelWarning({ agent: 'pi', model: '', account: '' }, TESTED)).toBeUndefined();
  });

  it('warns for a model the evaluation never tested, naming the tested ones and blocking nothing', () => {
    const warning = untestedModelWarning({ agent: 'pi', model: 'anthropic/claude-sonnet-5', account: '' }, TESTED);
    expect(warning).toContain('Pi with anthropic/claude-sonnet-5 has not been tested');
    expect(warning).toContain('tested with zai-coding-cn/glm-5.3');
    expect(warning).toContain('Reviews still run');
    expect(warning).toContain('docs/tested-models.md');
  });

  it('warns for an agent with no tested model, whatever model runs', () => {
    const none = untestedModelWarning({ agent: 'claude-code', model: '', account: '' }, TESTED);
    expect(none).toContain('Claude Code has not been tested with any model');
    expect(none).toContain('Reviews still run');
    const named = untestedModelWarning({ agent: 'claude-code', model: 'sonnet', account: '' }, TESTED);
    expect(named).toContain('Claude Code with sonnet has not been tested');
    expect(named).toContain('Reviews still run');
  });

  it('reads the published list by default, which today tests Pi alone', () => {
    expect(untestedModelWarning({ agent: 'pi', model: 'zai-coding-cn/glm-5.3', account: '' })).toBeUndefined();
    expect(untestedModelWarning({ agent: 'claude-code', model: '', account: '' })).toContain('Claude Code');
  });
});

describe('AgentStatusBar', () => {
  beforeEach(() => stub.reset());

  it('shows the agent and model in use, with the lockdown and the stamp in its tooltip', () => {
    stub.configuration = { 'second-look.agent': 'claude-code', 'second-look.agentModel': 'sonnet' };
    const bar = new AgentStatusBar({});
    bar.refresh();
    const [item] = stub.statusBarItems;
    expect(item!.text).toBe('Second Look: Claude Code · sonnet');
    expect(item!.tooltip).toContain('Every result is stamped');
    expect(item!.tooltip).toContain("names the login it used");
    expect(item!.backgroundColor).toBeUndefined();
    expect(item!.shown).toBe(true);
    bar.dispose();
  });

  it('shows the inherited API key warning when Claude Code would be overridden', () => {
    stub.configuration = { 'second-look.agent': 'claude-code' };
    const bar = new AgentStatusBar({ ANTHROPIC_API_KEY: 'sk-ant-inherited' });
    bar.refresh();
    const [item] = stub.statusBarItems;
    expect(item!.text).toBe('$(warning) Second Look: Claude Code · default model');
    expect(item!.tooltip).toContain('overrides the Claude subscription');
    expect(item!.backgroundColor).toMatchObject({ id: 'statusBarItem.warningBackground' });
    bar.dispose();
  });

  it('refreshes when the settings change', () => {
    const bar = new AgentStatusBar({});
    bar.refresh();
    expect(stub.statusBarItems[0]!.text).toBe('Second Look: Pi · default model');
    stub.configuration = { 'second-look.agent': 'claude-code', 'second-look.agentModel': 'sonnet' };
    stub.fireConfigurationChange();
    expect(stub.statusBarItems[0]!.text).toBe('Second Look: Claude Code · sonnet');
    bar.dispose();
  });

  it('is created and refreshed by activate, with the environment injected', () => {
    activate(stubContext() as never, { env: { ANTHROPIC_API_KEY: 'sk-ant-inherited' } });
    const [item] = stub.statusBarItems;
    // The key is inherited, but Pi is the agent, so no warning shows for it.
    expect(item!.text).toBe('Second Look: Pi · default model');
    expect(item!.tooltip).not.toContain('names the login it used');
  });

  it('carries the untested-combination warning in its tooltip, beside any API-key one', () => {
    stub.configuration = { 'second-look.agent': 'claude-code' };
    const bar = new AgentStatusBar({ ANTHROPIC_API_KEY: 'sk-ant-inherited' });
    bar.refresh();
    const [item] = stub.statusBarItems;
    expect(item!.tooltip).toContain('overrides the Claude subscription');
    expect(item!.tooltip).toContain('has not been tested with any model');
    bar.dispose();
  });
});

describe('the untested-combination warning', () => {
  beforeEach(() => stub.reset());

  it('shows once at activation for the settings the reviewer arrives with', () => {
    stub.configuration = { 'second-look.agent': 'claude-code' };
    activate(stubContext() as never, {});
    expect(stub.warningMessages).toHaveLength(1);
    expect(stub.warningMessages[0]).toContain('Claude Code has not been tested with any model');
  });

  it('shows when the reviewer chooses an untested agent or model, and not again for the tested one', () => {
    activate(stubContext() as never, {});
    expect(stub.warningMessages).toEqual([]);

    stub.configuration = { 'second-look.agentModel': 'anthropic/claude-sonnet-5' };
    stub.fireConfigurationChange();
    expect(stub.warningMessages).toHaveLength(1);
    expect(stub.warningMessages[0]).toContain('Pi with anthropic/claude-sonnet-5 has not been tested');

    stub.warningMessages = [];
    stub.configuration = { 'second-look.agentModel': 'zai-coding-cn/glm-5.3' };
    stub.fireConfigurationChange();
    expect(stub.warningMessages).toEqual([]);
  });
});
