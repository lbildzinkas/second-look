import * as vscode from 'vscode';
import {
  apiKeyOverrideWarning,
  agentStatusBarText,
  isAgentChosen,
  readAgentSettings,
  untestedModelWarning,
  type AgentSettings,
} from './agent-settings.js';
import { CHOOSE_AGENT_COMMAND } from './commands.js';

/**
 * The status bar entry for the agent in use: the agent, model and effort
 * the settings choose, each default named as such, the account or subscription when labelled, and — for
 * Claude Code started with an inherited Anthropic API key — the warning
 * that the key silently overrides the subscription. A beaker marks a
 * combination the evaluation never tested, with the full warning in the
 * tooltip, and a gear the defaults before the reviewer chose anything.
 * Clicking it opens the quick pick that changes them (issue 134). Every result
 * the companion shows is stamped with the same agent, version, model,
 * effort, login and account label by the engine, so what the reviewer reads here
 * is what answered.
 */
export class AgentStatusBar {
  private readonly item: vscode.StatusBarItem;
  private readonly env: NodeJS.ProcessEnv;
  private readonly watchConfiguration: vscode.Disposable;

  constructor(env: NodeJS.ProcessEnv = process.env) {
    this.env = env;
    this.item = vscode.window.createStatusBarItem('second-look.agent', vscode.StatusBarAlignment.Left);
    this.item.command = CHOOSE_AGENT_COMMAND;
    this.watchConfiguration = vscode.workspace.onDidChangeConfiguration((change) => {
      if (change.affectsConfiguration('second-look')) this.refresh();
    });
  }

  /** Rereads the settings and shows the agent, model and effort in use. */
  refresh(): void {
    const settings = readAgentSettings();
    const warning = apiKeyOverrideWarning(settings, this.env);
    const untested = untestedModelWarning(settings);
    const isChosen = isAgentChosen();
    const icon = warning !== undefined ? '$(warning) ' : untested !== undefined ? '$(beaker) ' : isChosen ? '' : '$(settings-gear) ';
    this.item.text = `${icon}${agentStatusBarText(settings)}`;
    this.item.tooltip = tooltip(settings, isChosen, [warning, untested]);
    this.item.backgroundColor =
      warning === undefined ? undefined : new vscode.ThemeColor('statusBarItem.warningBackground');
    this.item.show();
  }

  dispose(): void {
    this.watchConfiguration.dispose();
    this.item.dispose();
  }
}

/** The tooltip: whether anything is chosen yet, what the entry shows, the lockdown behind it, and any warnings. */
function tooltip(settings: AgentSettings, isChosen: boolean, warnings: readonly (string | undefined)[]): string {
  const lines = [
    ...(isChosen ? [] : ['Not chosen yet, click to choose', '']),
    agentStatusBarText(settings),
    '',
    'Second Look drives this agent, locked down, for its model work: file-reading tools only,',
    'on a read-only copy of the change. The agent signs in with its own login, which the',
    'companion never reads. Every result is stamped with the agent, its version, the model, the effort,',
    'the run date, the tokens and cost the agent reports, and the account label, when set.',
  ];
  if (settings.agent === 'claude-code') {
    lines.push("Each run's stamp also names the login it used.");
  }
  for (const warning of warnings) {
    if (warning !== undefined) lines.push('', warning);
  }
  return lines.join('\n');
}
