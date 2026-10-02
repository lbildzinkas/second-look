import * as vscode from 'vscode';
import { API_KEY_VARIABLE, isAgentName, type AgentName } from '@second-look/engine';

/**
 * The agent settings (issue 27): which installed coding agent the companion
 * drives, the model it runs and the reviewer's label for the account or
 * subscription it bills. They are documented in their descriptions in the
 * extension's manifest, and the status bar shows what they choose, so the
 * reviewer can tell at a glance which agent would answer.
 */

/** The agent settings, read from the `second-look` section. */
export interface AgentSettings {
  /** The agent the companion drives: `pi` or `claude-code`. */
  agent: AgentName;
  /** The model to ask for; empty is the agent's own default model. */
  model: string;
  /** The reviewer's label for the account or subscription the agent bills; empty hides it. */
  account: string;
}

/**
 * Reads the agent settings. A value the settings no longer offer falls back
 * to Pi, so a renamed agent never breaks the companion.
 */
export function readAgentSettings(): AgentSettings {
  const configuration = vscode.workspace.getConfiguration('second-look');
  const agent = configuration.get<string>('agent', 'pi');
  return {
    agent: isAgentName(agent) ? agent : 'pi',
    model: configuration.get<string>('agentModel', '').trim(),
    account: configuration.get<string>('agentAccount', '').trim(),
  };
}

/**
 * The warning that an inherited API key overrides the Claude subscription,
 * when the editor's environment carries one and Claude Code is the agent.
 * The key is never read, printed or copied — only its presence is checked.
 */
export function apiKeyOverrideWarning(settings: AgentSettings, env: NodeJS.ProcessEnv): string | undefined {
  if (settings.agent !== 'claude-code') return undefined;
  const key = env[API_KEY_VARIABLE];
  if (key === undefined || key === '') return undefined;
  return (
    `An ${API_KEY_VARIABLE} inherited from this window's environment overrides the Claude ` +
    'subscription sign-in: every Claude Code run bills the API key instead. ' +
    'Remove the variable and restart the editor to review on the subscription.'
  );
}

/** What the status bar shows: the agent and model in use, and the account when labelled. */
export function agentStatusBarText(settings: AgentSettings): string {
  const agent = settings.agent === 'claude-code' ? 'Claude Code' : 'Pi';
  const model = settings.model === '' ? 'default model' : settings.model;
  const parts = settings.account === '' ? [agent, model] : [agent, model, settings.account];
  return `Second Look: ${parts.join(' · ')}`;
}
