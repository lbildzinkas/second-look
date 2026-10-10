import * as vscode from 'vscode';
import {
  API_KEY_VARIABLE,
  DEFAULT_EFFORT,
  TESTED_MODELS,
  isAgentName,
  isTestedModel,
  type AgentName,
  type ReviewAgentChoice,
  type TestedModel,
} from '@second-look/engine';

/**
 * The agent settings (issue 27): which installed coding agent the companion
 * drives, the model it runs, the effort level it runs at (issue 121) and
 * the reviewer's label for the account or subscription it bills. They are documented in their descriptions in the
 * extension's manifest, the status bar shows what they choose, and every
 * review request carries them so the engine runs its agent passes with
 * them and stamps the account label on their results. Choosing a
 * combination the evaluation never tested shows the warning below
 * (issue 3), which blocks nothing.
 */

/** The agent settings, read from the `second-look` section. */
export interface AgentSettings {
  /** The agent the companion drives: `pi` or `claude-code`. */
  agent: AgentName;
  /** The model to ask for; empty is the agent's own default model. */
  model: string;
  /** The effort level to ask for, one the agent accepts; empty is the agent's own default. */
  effort: string;
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
    effort: configuration.get<string>('agentEffort', '').trim(),
    account: configuration.get<string>('agentAccount', '').trim(),
  };
}

/**
 * The agent choice a review request carries (issue 65): the agent, model,
 * effort and account the settings chose, so the engine runs every agent pass
 * with them. Switching the settings and re-running a review changes the
 * stamp on every agent-produced result.
 */
export function reviewAgentChoice(settings: AgentSettings): ReviewAgentChoice {
  return { agent: settings.agent, model: settings.model, effort: settings.effort, account: settings.account };
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

/** What the status bar shows: the agent, model and effort in use, and the account when labelled. */
export function agentStatusBarText(settings: AgentSettings): string {
  const agent = settings.agent === 'claude-code' ? 'Claude Code' : 'Pi';
  const model = settings.model === '' ? 'default model' : settings.model;
  const effort = settings.effort === '' ? 'default effort' : `effort ${settings.effort}`;
  const parts = settings.account === '' ? [agent, model, effort] : [agent, model, effort, settings.account];
  return `Second Look: ${parts.join(' · ')}`;
}

/** Where the current list of tested combinations is published, as the warning names it. */
const TESTED_MODELS_PAGE = "the repository's docs/tested-models.md";

/**
 * The warning (issue 3) that the settings pick an agent, model and effort
 * the companion's evaluation never tested: prompts behave differently on
 * each model, so results from an untested combination say little about
 * the tested ones. Non-blocking — every review still runs, stamped with
 * who answered — and quiet when the choice is tested. With no model
 * chosen the agent's own default runs, and only the run's stamp tells
 * which, so an agent with a tested model at the chosen effort stays
 * quiet while one with none warns whatever model runs. An empty effort
 * is the agent's own default, which is how the evaluation records it.
 */
export function untestedModelWarning(
  settings: AgentSettings,
  tested: readonly TestedModel[] = TESTED_MODELS,
): string | undefined {
  const name = settings.agent === 'claude-code' ? 'Claude Code' : 'Pi';
  const level = settings.effort === '' ? DEFAULT_EFFORT : settings.effort;
  const at = level === DEFAULT_EFFORT ? 'at its default effort' : `at effort ${level}`;
  const tried = tested.filter((entry) => entry.agent === settings.agent && entry.effort === level);
  const tail =
    `Reviews still run and every result is stamped with who answered. The tested combinations ` +
    `are published in ${TESTED_MODELS_PAGE}.`;
  if (settings.model === '') {
    if (tried.length > 0) return undefined;
    return `${name} ${at} has not been tested with any model, so its results say little about the tested combinations. ${tail}`;
  }
  if (isTestedModel(tested, settings.agent, settings.model, level)) return undefined;
  const models = [...new Set(tried.map((entry) => entry.model))].join(', ');
  const known = tried.length === 0 ? '' : `; ${at} it has been tested with ${models}`;
  return `${name} with ${settings.model} ${at} has not been tested by the companion's evaluation${known}. ${tail}`;
}
