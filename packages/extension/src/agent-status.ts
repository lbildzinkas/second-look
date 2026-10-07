import * as vscode from 'vscode';
import {
  apiKeyOverrideWarning,
  agentStatusBarText,
  readAgentSettings,
  untestedModelWarning,
  type AgentSettings,
} from './agent-settings.js';

/**
 * The status bar entry for the agent in use: the agent and model the
 * settings choose, the account or subscription when labelled, and — for
 * Claude Code started with an inherited Anthropic API key — the warning
 * that the key silently overrides the subscription, with the warning for
 * a combination the evaluation never tested in its tooltip. Every result
 * the companion shows is stamped with the same agent, version, model,
 * login and account label by the engine, so what the reviewer reads here
 * is what answered.
 */
export class AgentStatusBar {
  private readonly item: vscode.StatusBarItem;
  private readonly env: NodeJS.ProcessEnv;
  private readonly watchConfiguration: vscode.Disposable;

  constructor(env: NodeJS.ProcessEnv = process.env) {
    this.env = env;
    this.item = vscode.window.createStatusBarItem('second-look.agent', vscode.StatusBarAlignment.Left);
    this.watchConfiguration = vscode.workspace.onDidChangeConfiguration((change) => {
      if (change.affectsConfiguration('second-look')) this.refresh();
    });
  }

  /** Rereads the settings and shows the agent and model in use. */
  refresh(): void {
    const settings = readAgentSettings();
    const warning = apiKeyOverrideWarning(settings, this.env);
    const text = agentStatusBarText(settings);
    this.item.text = warning === undefined ? text : `$(warning) ${text}`;
    this.item.tooltip = tooltip(settings, [warning, untestedModelWarning(settings)]);
    this.item.backgroundColor =
      warning === undefined ? undefined : new vscode.ThemeColor('statusBarItem.warningBackground');
    this.item.show();
  }

  dispose(): void {
    this.watchConfiguration.dispose();
    this.item.dispose();
  }
}

/** The tooltip: what the entry shows, the lockdown behind it, and any warnings. */
function tooltip(settings: AgentSettings, warnings: readonly (string | undefined)[]): string {
  const lines = [
    agentStatusBarText(settings),
    '',
    'Second Look drives this agent, locked down, for its model work: file-reading tools only,',
    'on a read-only copy of the change. The agent signs in with its own login, which the',
    'companion never reads. Every result is stamped with the agent, its version, the model,',
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
