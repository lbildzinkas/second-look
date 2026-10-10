import * as vscode from 'vscode';
import { isAgentName, type AgentPaths, type ProbeAgentsRpcResult, type ReviewAgentChoice, type TestAgentRpcResult } from '@second-look/engine';
import { writeSetting } from '../agent-picker.js';
import { AGENT_PATH_SETTINGS, readAgentPaths, readAgentSettings, reviewAgentChoice } from '../agent-settings.js';
import {
  INSTALL_PAGES,
  agentDraft,
  pathProblem,
  setupProblem,
  testedModels,
  type SetupDraft,
  type SetupField,
  type SetupMessage,
  type SetupView,
} from './setup.js';

/** The global-state flag set once step 1's form has opened by itself, or the reviewer saved or chose the defaults. */
export const SETUP_SEEN_KEY = 'second-look.setupSeen';

/** What the form asks the engine: the probe of the installed agents, and the agent test. */
export interface SetupEngine {
  probeAgents(paths: AgentPaths): Promise<ProbeAgentsRpcResult>;
  testAgent(agent: ReviewAgentChoice): Promise<TestAgentRpcResult>;
}

export interface SetupFormDeps {
  /** The engine, started and past its handshake. */
  engine(): Promise<SetupEngine>;
  /** The extension's global state, which keeps the first-open flag. */
  globalState: vscode.Memento;
  /** Redraws the side bar. */
  onChange(): void;
}

/**
 * True on the first open: no `second-look.agent` in any scope, and the
 * form never opened by itself before.
 */
export function opensByItself(globalState: vscode.Memento): boolean {
  const set = vscode.workspace.getConfiguration('second-look').inspect('agent');
  const isSet = set?.globalValue !== undefined || set?.workspaceValue !== undefined || set?.workspaceFolderValue !== undefined;
  return !isSet && globalState.get(SETUP_SEEN_KEY) !== true;
}

/** The draft the settings in use start the form on. */
function settingsDraft(): SetupDraft {
  const settings = readAgentSettings();
  const other = settings.model !== '' && !testedModels(settings.agent).includes(settings.model);
  return { agent: settings.agent, model: settings.model, other, effort: settings.effort, account: settings.account, path: settings.path ?? '' };
}

/**
 * Step 1's setup form (issue 135): it opens by itself on the first open,
 * and later from step 1's change link and the agent quick pick. It shows
 * the probe of the installed agents, runs the agent test only when Test is
 * pressed, writes the agent, model, effort and account to the user
 * settings on Save, and writes the agent's path setting from the path
 * field — shown only when the probe found no agent — then probes again.
 */
export class SetupForm {
  private view: SetupView;
  private readonly deps: SetupFormDeps;
  /** Counts the probes and tests started, so a replaced one's late answer is dropped. */
  private probes = 0;
  private tests = 0;

  constructor(deps: SetupFormDeps) {
    this.deps = deps;
    this.view = { open: opensByItself(deps.globalState), draft: settingsDraft(), probe: { state: 'probing' } };
  }

  /** The form as it stands. */
  get current(): SetupView {
    return this.view;
  }

  /** The side bar was drawn: an open form has now been seen, and its agents are probed. */
  shown(): void {
    if (!this.view.open) return;
    void this.deps.globalState.update(SETUP_SEEN_KEY, true);
    void this.probe();
  }

  /** Opens the form on the settings in use, and probes the installed agents. */
  open(): void {
    this.view = { open: true, draft: settingsDraft(), probe: { state: 'probing' } };
    this.deps.onChange();
    void this.probe();
  }

  async handle(message: SetupMessage): Promise<void> {
    if ('field' in message) {
      this.edit(message.field, message.value);
      this.deps.onChange();
      return;
    }
    for (const [field, value] of Object.entries(message.fields)) this.edit(field as SetupField, value);
    if (message.action === 'open') return this.open();
    if (message.action === 'install') {
      if (isAgentName(message.value)) await vscode.env.openExternal(vscode.Uri.parse(INSTALL_PAGES[message.value]));
      return;
    }
    if (message.action === 'usePath') return this.usePath();
    if (message.action === 'test') return this.test();
    if (message.action === 'save') {
      const problem = setupProblem(this.view.draft);
      if (problem !== undefined) return this.refuse(problem);
      const { agent, model, effort, account } = this.view.draft;
      await writeSetting('agent', agent);
      await writeSetting('model', model);
      await writeSetting('effort', effort);
      await writeSetting('account', account.trim());
    }
    await this.deps.globalState.update(SETUP_SEEN_KEY, true);
    this.view = { ...this.view, open: false };
    this.deps.onChange();
  }

  private edit(field: SetupField, value: string): void {
    const { draft } = this.view;
    let next: SetupDraft = draft;
    if (field === 'agent' && isAgentName(value) && value !== draft.agent) next = agentDraft(value, draft, readAgentPaths()[value] ?? '');
    if (field === 'model') next = { ...draft, model: value, other: false };
    if (field === 'other') next = { ...draft, other: true };
    if (field === 'otherModel') next = { ...draft, model: value.trim(), other: true };
    if (field === 'effort') next = { ...draft, effort: value };
    if (field === 'account') next = { ...draft, account: value };
    if (field === 'path') next = { ...draft, path: value };
    // A test describes the combination it ran, so changing it clears the result.
    const isSameRun = next.agent === draft.agent && next.model === draft.model && next.effort === draft.effort;
    const { open, probe, test } = this.view;
    this.view = { open, probe, draft: next, ...(isSameRun && test !== undefined ? { test } : {}) };
    if (!isSameRun) this.tests += 1;
  }

  private refuse(problem: string): void {
    this.view = { ...this.view, problem };
    this.deps.onChange();
  }

  private async probe(): Promise<void> {
    const probe = ++this.probes;
    this.view = { ...this.view, probe: { state: 'probing' } };
    this.deps.onChange();
    try {
      const { agents } = await (await this.deps.engine()).probeAgents(readAgentPaths());
      if (probe === this.probes) this.view = { ...this.view, probe: { state: 'probed', agents } };
    } catch (error) {
      if (probe === this.probes) this.view = { ...this.view, probe: { state: 'failed', message: error instanceof Error ? error.message : String(error) } };
    }
    this.deps.onChange();
  }

  private async test(): Promise<void> {
    const problem = setupProblem(this.view.draft);
    if (problem !== undefined) return this.refuse(problem);
    const test = ++this.tests;
    const { agent, model, effort, account } = this.view.draft;
    const path = readAgentPaths()[agent];
    this.view = { ...this.view, test: { state: 'testing' } };
    this.deps.onChange();
    try {
      const choice = reviewAgentChoice({ agent, model, effort, account: account.trim(), ...(path !== undefined ? { path } : {}) });
      const result = await (await this.deps.engine()).testAgent(choice);
      if (test === this.tests) this.view = { ...this.view, test: { state: 'tested', result } };
    } catch (error) {
      if (test === this.tests) this.view = { ...this.view, test: { state: 'failed', message: error instanceof Error ? error.message : String(error) } };
    }
    this.deps.onChange();
  }

  /** Writes the agent path field to the agent's path setting in the user settings, then probes again. */
  private async usePath(): Promise<void> {
    const { agent, path } = this.view.draft;
    const problem = pathProblem(path.trim());
    if (problem !== undefined) return this.refuse(problem);
    await vscode.workspace.getConfiguration('second-look').update(AGENT_PATH_SETTINGS[agent], path.trim(), vscode.ConfigurationTarget.Global);
    await this.probe();
  }
}
