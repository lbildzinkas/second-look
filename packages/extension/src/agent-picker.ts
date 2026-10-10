import * as vscode from 'vscode';
import { AGENT_NAMES, DEFAULT_EFFORT, TESTED_MODELS, isTestedModel, type AgentName } from '@second-look/engine';
import {
  AGENT_SETTING_KEYS,
  EFFORT_LEVELS,
  agentLabel,
  readAgentSettings,
  testedAtText,
  type AgentSettings,
} from './agent-settings.js';
import { OPEN_REVIEW_CONTAINER_COMMAND } from './commands.js';

/**
 * The quick change of the agent settings (issue 134), opened by clicking
 * the status bar entry or by the "Choose agent and model" command: a
 * summary of the agent, model, effort and account label, where each pick
 * edits that one value in the user settings. Changing the agent continues
 * to its model and effort, since the old ones are rarely the new agent's.
 * A workspace setting overrides the user one, so the summary marks a
 * value set there and every edit it overrides warns. The full setup form
 * lives in step 1 of the side bar, which the summary's last item opens.
 */

const TITLE = 'Second Look: Choose agent and model';

/** One row of the summary: the setting it edits, or none for "Open the setup". */
interface SummaryItem extends vscode.QuickPickItem {
  field?: keyof typeof AGENT_SETTING_KEYS;
}

/** Opens the summary and runs the pick the reviewer makes; Escape changes nothing. */
export async function chooseAgent(): Promise<void> {
  const settings = readAgentSettings();
  const picked = await vscode.window.showQuickPick(summaryItems(settings), { title: TITLE, placeHolder: 'Pick what to change' });
  if (picked === undefined) return;
  if (picked.field === undefined) {
    await vscode.commands.executeCommand(OPEN_REVIEW_CONTAINER_COMMAND);
    return;
  }
  if (picked.field === 'agent') return chooseAgentName(settings);
  if (picked.field === 'model') {
    await chooseModel(settings, settings.model);
    return;
  }
  if (picked.field === 'effort') return chooseEffort(settings);
  return chooseAccount(settings);
}

/** The summary's rows: each value in use, with "tested at" on a tested model. */
function summaryItems(settings: AgentSettings): SummaryItem[] {
  const tested = testedAt(settings.agent, settings.model);
  const model = settings.model === '' ? 'default model' : settings.model;
  return [
    { label: '$(hubot) Agent', description: agentLabel(settings.agent), detail: overrideNote('agent'), field: 'agent' },
    {
      label: '$(sparkle) Model',
      description: tested === undefined ? model : `${model} · ${tested}`,
      detail: overrideNote('model'),
      field: 'model',
    },
    {
      label: '$(dashboard) Effort',
      description: settings.effort === '' ? 'default effort' : settings.effort,
      detail: overrideNote('effort'),
      field: 'effort',
    },
    {
      label: '$(account) Account label',
      description: settings.account === '' ? 'none' : settings.account,
      detail: overrideNote('account'),
      field: 'account',
    },
    { label: '', kind: vscode.QuickPickItemKind.Separator },
    { label: '$(layout-sidebar-left) Open the setup in the side bar' },
  ];
}

/** Picks the agent, then continues to its model and effort. */
async function chooseAgentName(settings: AgentSettings): Promise<void> {
  const items = AGENT_NAMES.map((agent) => ({ label: agentLabel(agent), description: inUse(agent === settings.agent), agent }));
  const picked = await vscode.window.showQuickPick(items, { title: `${TITLE}: agent`, placeHolder: 'The installed coding agent the companion drives' });
  if (picked === undefined) return;
  await writeSetting('agent', picked.agent);
  const chosen = { ...settings, agent: picked.agent };
  // Another agent's model is rarely this one's, so none is marked in use.
  const model = await chooseModel(chosen, picked.agent === settings.agent ? settings.model : undefined);
  if (model === undefined) return;
  await chooseEffort({ ...chosen, model });
}

/**
 * Picks the model: the tested ones first, then the agent's own default,
 * then any other by name, with the model in use, when known, marked.
 * Resolves with the model written, or undefined when the reviewer
 * dismissed the pick.
 */
async function chooseModel(settings: AgentSettings, inUseModel: string | undefined): Promise<string | undefined> {
  const tested = [...new Set(TESTED_MODELS.filter((entry) => entry.agent === settings.agent).map((entry) => entry.model))];
  const models = inUseModel === undefined || inUseModel === '' || tested.includes(inUseModel) ? tested : [...tested, inUseModel];
  const items: (vscode.QuickPickItem & { model?: string })[] = [
    ...models.map((model) => ({
      label: model,
      description: note(testedAt(settings.agent, model), model === inUseModel),
      model,
    })),
    { label: 'Default model', description: note(`${agentLabel(settings.agent)}'s own default`, inUseModel === ''), model: '' },
    { label: 'Other…', description: 'type the model in the agent’s own naming' },
  ];
  const picked = await vscode.window.showQuickPick(items, { title: `${TITLE}: model`, placeHolder: `The model ${agentLabel(settings.agent)} runs` });
  if (picked === undefined) return undefined;
  const model =
    picked.model ??
    (await vscode.window.showInputBox({
      title: `${TITLE}: model`,
      value: inUseModel ?? '',
      prompt: 'The model in the agent’s own naming, such as anthropic/claude-sonnet-5 for Pi or sonnet for Claude Code; empty uses its default.',
    }))?.trim();
  if (model === undefined) return undefined;
  await writeSetting('model', model);
  return model;
}

/** Picks the effort among the levels the agent accepts, marking the ones tested with the model. */
async function chooseEffort(settings: AgentSettings): Promise<void> {
  const tested = (level: string): string | undefined =>
    isTestedModel(TESTED_MODELS, settings.agent, settings.model, level === '' ? DEFAULT_EFFORT : level)
      ? '$(pass) tested with this model'
      : undefined;
  const items = ['', ...EFFORT_LEVELS[settings.agent]].map((effort) => ({
    label: effort === '' ? 'Default effort' : effort,
    description: note(tested(effort), effort === settings.effort),
    effort,
  }));
  const picked = await vscode.window.showQuickPick(items, { title: `${TITLE}: effort`, placeHolder: `The effort ${agentLabel(settings.agent)} runs at` });
  if (picked === undefined) return;
  await writeSetting('effort', picked.effort);
}

/** Edits the account label; an empty label hides it. */
async function chooseAccount(settings: AgentSettings): Promise<void> {
  const account = await vscode.window.showInputBox({
    title: `${TITLE}: account label`,
    value: settings.account,
    prompt: 'A label for the account or subscription the agent bills, stamped on every result; the companion never reads the login. Empty hides it.',
  });
  if (account === undefined) return;
  await writeSetting('account', account.trim());
}

/**
 * Writes one agent setting to the user settings, and warns when a
 * workspace setting overrides it, so the choice would not take effect.
 */
async function writeSetting(field: keyof typeof AGENT_SETTING_KEYS, value: string): Promise<void> {
  await vscode.workspace.getConfiguration('second-look').update(AGENT_SETTING_KEYS[field], value, vscode.ConfigurationTarget.Global);
  if (overrideNote(field) === undefined) return;
  void vscode.window.showWarningMessage(
    `A workspace setting for second-look.${AGENT_SETTING_KEYS[field]} overrides the user setting just changed, ` +
      'so the choice takes no effect here. Remove it from the workspace settings to use the choice.',
  );
}

/** The note on a summary row whose value a workspace or folder setting overrides. */
function overrideNote(field: keyof typeof AGENT_SETTING_KEYS): string | undefined {
  const set = vscode.workspace.getConfiguration('second-look').inspect(AGENT_SETTING_KEYS[field]);
  if (set?.workspaceValue === undefined && set?.workspaceFolderValue === undefined) return undefined;
  return '$(warning) Set in the workspace settings, which override the user settings';
}

function testedAt(agent: AgentName, model: string): string | undefined {
  const tested = testedAtText(agent, model);
  return tested === undefined ? undefined : `$(pass) ${tested}`;
}

function inUse(isInUse: boolean): string | undefined {
  return isInUse ? 'in use' : undefined;
}

function note(text: string | undefined, isInUse: boolean): string | undefined {
  const parts = [text, inUse(isInUse)].filter((part) => part !== undefined);
  return parts.length === 0 ? undefined : parts.join(' · ');
}
