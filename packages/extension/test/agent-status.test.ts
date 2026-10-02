import { beforeEach, describe, expect, it } from 'vitest';
import { AGENT_NAMES } from '@second-look/engine';
import { stub, stubContext } from './vscode-stub.js';
import { activate } from '../src/extension.js';
import { AgentStatusBar } from '../src/agent-status.js';
import {
  apiKeyOverrideWarning,
  agentStatusBarText,
  readAgentSettings,
  type AgentSettings,
} from '../src/agent-settings.js';

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
});
