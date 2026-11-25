import * as vscode from 'vscode';
import {
  isAgentName,
  type AgentPaths,
  type JiraProbeRpcResult,
  type JiraTestParams,
  type JiraTestRpcResult,
  type ProbeAgentsRpcResult,
  type ReviewAgentChoice,
  type TestAgentRpcResult,
} from '@second-look/engine';
import { writeSetting } from '../agent-picker.js';
import { AGENT_PATH_SETTINGS, AGENT_SETTING_KEYS, readAgentPaths, readAgentSettings, reviewAgentChoice } from '../agent-settings.js';
import {
  INSTALL_PAGES,
  agentDraft,
  chosenJiraSite,
  jiraTestProblem,
  pathProblem,
  setupProblem,
  testedModels,
  type JiraRowView,
  type SetupDraft,
  type SetupField,
  type SetupMessage,
  type SetupView,
} from './setup.js';

/** The global-state flag set once step 1's form has opened by itself, or the reviewer saved or chose the defaults. */
export const SETUP_SEEN_KEY = 'second-look.setupSeen';

/** What the form asks the engine: the probe of the installed agents, the agent test, and the Jira row's check and test. */
export interface SetupEngine {
  probeAgents(paths: AgentPaths): Promise<ProbeAgentsRpcResult>;
  testAgent(agent: ReviewAgentChoice): Promise<TestAgentRpcResult>;
  probeJira(agent: ReviewAgentChoice): Promise<JiraProbeRpcResult>;
  testJira(params: JiraTestParams): Promise<JiraTestRpcResult>;
}

/** The setting that picks the Jira site when the Atlassian account reaches several. */
export const JIRA_SITE_SETTING = 'jira.site';

/** The `second-look.jira.site` setting as it reads. */
function readJiraSite(): string {
  return vscode.workspace.getConfiguration('second-look').get<string>(JIRA_SITE_SETTING, '');
}

/** A message as plain words. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
  /** The same for the Jira row's checks and tests, and the times Connect Jira opened it. */
  private jiraChecks = 0;
  private jiraTests = 0;
  private reveals = 0;

  constructor(deps: SetupFormDeps) {
    this.deps = deps;
    this.view = { open: opensByItself(deps.globalState), draft: settingsDraft(), probe: { state: 'probing' }, jira: { site: readJiraSite(), key: '' } };
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
    // A test still out describes the draft this one replaces, so its answer is dropped.
    this.tests += 1;
    // The Jira row keeps its check: it describes Claude Code's connection, not the draft.
    this.view = { open: true, draft: settingsDraft(), probe: { state: 'probing' }, jira: { ...this.view.jira, site: readJiraSite() } };
    this.deps.onChange();
    void this.probe();
  }

  /**
   * Step 6's Connect Jira: opens the form at its Jira row, scrolled into
   * view, and checks Claude Code's Atlassian connection, unless the
   * agent is Pi, whose row says Jira needs Claude Code.
   */
  async openJira(): Promise<void> {
    if (!this.view.open) this.open();
    this.reveals += 1;
    this.setJira({ reveal: this.reveals });
    if (this.view.draft.agent !== 'pi') await this.checkJira();
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
    if (message.action === 'openJira') return this.openJira();
    if (message.action === 'checkJira') return this.checkJira();
    if (message.action === 'testJira') return this.testJira();
    if (message.action === 'jiraSite') {
      await vscode.commands.executeCommand('workbench.action.openSettings', `second-look.${JIRA_SITE_SETTING}`);
      return;
    }
    if (message.action === 'save') {
      const problem = setupProblem(this.view.draft);
      if (problem !== undefined) return this.refuse(problem);
      const { agent, model, effort, account } = this.view.draft;
      await writeSetting(AGENT_SETTING_KEYS.agent, agent);
      await writeSetting(AGENT_SETTING_KEYS.model, model);
      await writeSetting(AGENT_SETTING_KEYS.effort, effort);
      await writeSetting(AGENT_SETTING_KEYS.account, account.trim());
    }
    await this.deps.globalState.update(SETUP_SEEN_KEY, true);
    this.view = { ...this.view, open: false };
    this.deps.onChange();
  }

  private edit(field: SetupField, value: string): void {
    if (field === 'jiraKey') {
      this.view = { ...this.view, jira: { ...this.view.jira, key: value, problem: undefined } };
      return;
    }
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
    const isSameRun = next.agent === draft.agent && next.model === draft.model && next.effort === draft.effort && next.account.trim() === draft.account.trim();
    const { open, probe, test, jira } = this.view;
    this.view = { open, probe, jira, draft: next, ...(isSameRun && test !== undefined ? { test } : {}) };
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
    const refused = pathProblem(path.trim());
    if (refused !== undefined) return this.refuse(refused);
    await writeSetting(AGENT_PATH_SETTINGS[agent], path.trim());
    const { open, draft, probe, problem, jira } = this.view;
    this.view = { open, draft, probe, jira, ...(problem !== undefined ? { problem } : {}) };
    this.tests += 1;
    await this.probe();
  }

  private setJira(change: Partial<JiraRowView>): void {
    this.view = { ...this.view, jira: { ...this.view.jira, ...change } };
    this.deps.onChange();
  }

  /**
   * The Claude Code the Jira row's runs use, whatever agent reviews: its
   * path setting, and the draft's model when the draft is Claude Code
   * with a model the engine accepts, else Claude Code's own default.
   */
  private jiraAgent(): ReviewAgentChoice {
    const { draft } = this.view;
    const model = draft.agent === 'claude-code' && setupProblem(draft) === undefined ? draft.model : '';
    const path = readAgentPaths()['claude-code'];
    return { agent: 'claude-code', model, ...(path !== undefined ? { path } : {}) };
  }

  /** Checks Claude Code's Atlassian connection for the Jira row, reading the site setting afresh; a test shown is cleared. */
  private async checkJira(): Promise<void> {
    const check = ++this.jiraChecks;
    this.jiraTests += 1;
    this.setJira({ site: readJiraSite(), check: { state: 'checking' }, test: undefined, problem: undefined });
    try {
      const result = await (await this.deps.engine()).probeJira(this.jiraAgent());
      if (check === this.jiraChecks) this.setJira({ check: { state: 'checked', result } });
    } catch (error) {
      if (check === this.jiraChecks) this.setJira({ check: { state: 'failed', message: messageOf(error) } });
    }
  }

  /** Fetches the ticket key typed from the site the check chose, with nothing kept. */
  private async testJira(): Promise<void> {
    const { jira } = this.view;
    const problem = jiraTestProblem(jira);
    const site = chosenJiraSite(jira);
    const checked = jira.check?.state === 'checked' ? jira.check.result : undefined;
    if (problem !== undefined || site === undefined || checked?.state !== 'connected') {
      this.setJira({ problem: problem ?? 'Check Jira first.' });
      return;
    }
    const test = ++this.jiraTests;
    const key = jira.key.trim();
    this.setJira({ test: { state: 'testing', key }, problem: undefined });
    try {
      const result = await (await this.deps.engine()).testJira({ agent: this.jiraAgent(), route: checked.route, site, key });
      if (test === this.jiraTests) this.setJira({ test: { state: 'tested', result } });
    } catch (error) {
      if (test === this.jiraTests) this.setJira({ test: { state: 'failed', message: messageOf(error) } });
    }
  }
}
