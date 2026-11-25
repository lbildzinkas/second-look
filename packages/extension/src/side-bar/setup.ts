import { isAbsolute } from 'node:path';
import {
  AGENT_NAMES,
  DEFAULT_EFFORT,
  TESTED_MODELS,
  chooseJiraSite,
  isTestedModel,
  isTicketKey,
  jiraSiteHost,
  jiraSiteSetting,
  modelAndEffortProblem,
  type AgentName,
  type AgentStamp,
  type JiraProbeRpcResult,
  type JiraSite,
  type JiraSiteChoice,
  type JiraTestRpcResult,
  type ProbeAgentsRpcResult,
  type TestAgentRpcResult,
} from '@second-look/engine';
import { EFFORT_LEVELS, agentLabel, testedAtText } from '../agent-settings.js';
import { escapeHtml } from '../overview.js';

/** One agent as the probe of the installed agents reports it. */
export type ProbedAgent = ProbeAgentsRpcResult['agents'][number];

/** The choices the setup form holds until Save writes them. */
export interface SetupDraft {
  agent: AgentName;
  /** The model; empty is the agent's own default. */
  model: string;
  /** True when the model is typed under "Other…". */
  other: boolean;
  /** The effort; empty is the agent's own default. */
  effort: string;
  account: string;
  /** The agent path field's text. */
  path: string;
}

/** Step 1's setup form as it stands (issue 135). */
export interface SetupView {
  /** True while the form shows in step 1's card. */
  open: boolean;
  draft: SetupDraft;
  probe: { state: 'probing' } | { state: 'probed'; agents: ProbedAgent[] } | { state: 'failed'; message: string };
  /** The Test button's run: absent before it is pressed. */
  test?: { state: 'testing' } | { state: 'tested'; result: TestAgentRpcResult } | { state: 'failed'; message: string };
  /** Why the last Save, Test or path was refused, in plain words. */
  problem?: string;
  /** The Jira row: the tracker login's check and its Test (issue 191). */
  jira: JiraRowView;
}

/** The setup form's Jira row as it stands. */
export interface JiraRowView {
  /** The `second-look.jira.site` setting as it reads, untrimmed. */
  site: string;
  /** The check of Claude Code's Atlassian connection: absent until the reviewer asks for it. */
  check?: { state: 'checking' } | { state: 'checked'; result: JiraProbeRpcResult } | { state: 'failed'; message: string };
  /** The ticket key the Test fetches, as typed. */
  key: string;
  /** The Test's fetch: absent before it is pressed. */
  test?: { state: 'testing'; key: string } | { state: 'tested'; result: JiraTestRpcResult } | { state: 'failed'; message: string };
  /** Why the last Test was refused, in plain words. */
  problem?: string;
  /** Counts the times Connect Jira opened the row, so the side bar scrolls to it once each time. */
  reveal?: number;
}

/** The fields the form's controls edit. */
export type SetupField = 'agent' | 'model' | 'other' | 'otherModel' | 'effort' | 'account' | 'path' | 'jiraKey';

/** The form's buttons. */
export type SetupAction = 'open' | 'save' | 'defaults' | 'test' | 'usePath' | 'install' | 'openJira' | 'checkJira' | 'testJira' | 'jiraSite';

/** A change or a press in the setup form, as the side bar's script reports it. */
export type SetupMessage =
  | { type: 'setup'; field: SetupField; value: string }
  | { type: 'setup'; action: SetupAction; value: string; fields: Partial<Record<SetupField, string>> };

const FIELDS: readonly SetupField[] = ['agent', 'model', 'other', 'otherModel', 'effort', 'account', 'path', 'jiraKey'];
const ACTIONS: readonly SetupAction[] = ['open', 'save', 'defaults', 'test', 'usePath', 'install', 'openJira', 'checkJira', 'testJira', 'jiraSite'];
/** The fields typed in a text box, which a press carries as they stand. */
const TEXT_FIELDS: readonly SetupField[] = ['otherModel', 'account', 'path', 'jiraKey'];

/** Where each agent's install instructions are. */
export const INSTALL_PAGES: Record<AgentName, string> = {
  pi: 'https://github.com/earendil-works/pi/tree/main/packages/coding-agent',
  'claude-code': 'https://code.claude.com/docs/en/setup',
};

/** Reads a setup message out of what the webview delivered, if it is one. */
export function setupMessage(value: unknown): SetupMessage | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const { type, field, action, value: text, fields } = value as Record<string, unknown>;
  if (type !== 'setup' || typeof text !== 'string') return undefined;
  if (typeof field === 'string' && (FIELDS as readonly string[]).includes(field)) return { type, field: field as SetupField, value: text };
  if (typeof action !== 'string' || !(ACTIONS as readonly string[]).includes(action)) return undefined;
  const typed: Partial<Record<SetupField, string>> = {};
  if (typeof fields === 'object' && fields !== null) {
    for (const name of TEXT_FIELDS) {
      const each = (fields as Record<string, unknown>)[name];
      if (typeof each === 'string') typed[name] = each;
    }
  }
  return { type, action: action as SetupAction, value: text, fields: typed };
}

/** The models the evaluation tested with the agent, in the order it lists them. */
export function testedModels(agent: AgentName): string[] {
  return [...new Set(TESTED_MODELS.filter((entry) => entry.agent === agent).map((entry) => entry.model))];
}

/** The draft an agent starts on: its first tested combination, else its defaults. */
export function agentDraft(agent: AgentName, draft: SetupDraft, path: string): SetupDraft {
  const tested = TESTED_MODELS.find((entry) => entry.agent === agent);
  const effort = tested === undefined || tested.effort === DEFAULT_EFFORT ? '' : tested.effort;
  return { ...draft, agent, model: tested?.model ?? '', other: false, effort, path };
}

/** The effort levels to offer: the ones the agent's help lists, else the known ones, kept to those the engine accepts. */
export function effortLevels(agent: AgentName, probed: ProbedAgent | undefined): string[] {
  if (probed?.supports.effort === false) return [];
  const listed = probed !== undefined && probed.effortLevels.length > 0 ? probed.effortLevels : EFFORT_LEVELS[agent];
  return listed.filter((level) => modelAndEffortProblem(agent, { effort: level }) === undefined);
}

/** Why the draft cannot be saved or tested, checked as the engine checks it; absent when it can. */
export function setupProblem(draft: SetupDraft): string | undefined {
  const problem = modelAndEffortProblem(draft.agent, { model: draft.model, effort: draft.effort });
  return problem === undefined ? undefined : `Not saved or tested: ${problem}.`;
}

/** Why the agent path field's text cannot be used, as the engine refuses it; absent when it can. */
export function pathProblem(path: string): string | undefined {
  if (path === '' || isAbsolute(path)) return undefined;
  return `The path must be an absolute path to the executable, not ${JSON.stringify(path)}.`;
}

function probedAgent(view: SetupView, agent: AgentName): ProbedAgent | undefined {
  return view.probe.state === 'probed' ? view.probe.agents.find((each) => each.agent === agent) : undefined;
}

/** The line under an agent's name: its version, whether it is ready, and the login it would use. */
export function agentLine(view: SetupView, agent: AgentName): string {
  if (view.probe.state === 'probing') return 'checking…';
  const probed = probedAgent(view, agent);
  if (probed === undefined) return 'not checked';
  if (!probed.installed) return 'not found';
  const version = probed.version === '' ? 'version unknown' : probed.version;
  if (!probed.usable) return `${version} · cannot run`;
  return `${version} · ready · ${probed.login?.source ?? 'its own login'}`;
}

/** Who answered a test, as its stamp says. */
export function stampLine(stamp: AgentStamp): string {
  const effort = stamp.effort === null ? 'default effort' : `effort ${stamp.effort}`;
  const parts = [`${stamp.agent} ${stamp.agentVersion}`.trim(), stamp.model ?? 'model unknown', effort, stamp.login?.source, stamp.account];
  return parts.filter((part) => part !== undefined && part !== '').join(' · ');
}

/** A choice in a group of radio buttons. */
function radio(field: SetupField, value: string, label: string, checked: boolean, note = ''): string {
  const id = `setup-${field}-${value === '' ? 'default' : value}`.replace(/[^\w-]/g, '_');
  const small = note === '' ? '' : `<small>${escapeHtml(note)}</small>`;
  return `<button type="button" role="radio" aria-checked="${checked}" id="${escapeHtml(id)}" class="choice" data-field="${field}" data-value="${escapeHtml(value)}">${escapeHtml(label)}${small}</button>`;
}

function group(id: string, label: string, choices: string): string {
  return `<h3 class="label" id="${id}">${label}</h3><div class="choices" role="radiogroup" aria-labelledby="${id}">${choices}</div>`;
}

function textBox(field: SetupField, label: string, value: string, placeholder: string): string {
  return (
    `<label class="label" for="setup-${field}">${label}</label>` +
    `<input type="text" id="setup-${field}" class="setup-text" data-field="${field}" value="${escapeHtml(value)}" placeholder="${escapeHtml(placeholder)}">`
  );
}

function setupButton(action: SetupAction, label: string, kind: 'primary' | 'secondary' | 'link', value = '', disabled = false): string {
  return `<button type="button" id="setup-${action}${value === '' ? '' : `-${value}`}" class="${kind}" data-action="${action}" data-value="${escapeHtml(value)}"${disabled ? ' disabled' : ''}>${escapeHtml(label)}</button>`;
}

/** What the probe says about each agent that is not ready, with the install link for one not found. */
function agentNotes(view: SetupView): string {
  if (view.probe.state === 'failed') return `<p class="note">The installed agents could not be checked: ${escapeHtml(view.probe.message)}</p>`;
  return AGENT_NAMES.map((agent) => {
    const probed = probedAgent(view, agent);
    if (probed === undefined) return '';
    const warning = probed.login?.warning === undefined ? '' : `<p class="note">⚠ ${escapeHtml(probed.login.warning)}</p>`;
    if (probed.usable) return warning;
    const install = probed.installed ? '' : ` ${setupButton('install', `Install ${agentLabel(agent)}`, 'link', agent)}`;
    return `<p class="note">${escapeHtml(probed.reason ?? `${agentLabel(agent)} cannot run with the companion's lockdown`)}${install}</p>` + warning;
  }).join('');
}

/** The test's result: ok with the stamp, or the reason it failed. */
function testLine(view: SetupView): string {
  const { test } = view;
  if (test === undefined) return '';
  const text =
    test.state === 'testing'
      ? 'Testing: one tiny run of the chosen agent, model and effort…'
      : test.state === 'failed'
        ? `✕ The test could not run: ${test.message}`
        : test.result.ok
          ? `✓ ok · ${stampLine(test.result.stamp)}`
          : `✕ ${test.result.message} · ${stampLine(test.result.stamp)}`;
  return `<p class="note test" role="status">${escapeHtml(text)}</p>`;
}

/** The command that adds the fallback's Atlassian server for every folder, as the docs give it. */
export const JIRA_FALLBACK_ADD = 'claude mcp add -s user --transport http atlassian https://mcp.atlassian.com/v2/mcp';

/** The command that signs the fallback's Atlassian server in. */
export const JIRA_FALLBACK_LOGIN = 'claude mcp login atlassian';

/** Where the connector is authorised: claude.ai's connector settings, on the Claude account this profile's Claude Code signs in with. */
const CONNECTOR_STEP =
  'Authorise the Atlassian connector at claude.ai → Settings → Connectors, signed in to the Claude account this profile’s Claude Code uses (your work account for work tickets), then check again.';

/** The fallback, for an account without the connector. */
const FALLBACK_STEP = `Without the connector, add Atlassian’s own MCP server once with ${JIRA_FALLBACK_ADD}, sign it in with ${JIRA_FALLBACK_LOGIN}, then check again.`;

/** The Jira site the row reads from: the setting's problem, or the site chosen from those the account reaches. */
export function jiraSiteChoice(jira: JiraRowView): { problem: string } | JiraSiteChoice | undefined {
  const setting = jiraSiteSetting(jira.site);
  if ('problem' in setting) return { problem: setting.problem };
  const { check } = jira;
  if (check?.state !== 'checked' || check.result.state !== 'connected') return undefined;
  return chooseJiraSite(check.result.sites, setting.host);
}

/** The site the Test fetches from, once the check is connected and a site is chosen. */
export function chosenJiraSite(jira: JiraRowView): JiraSite | undefined {
  const choice = jiraSiteChoice(jira);
  return choice !== undefined && 'state' in choice && choice.state === 'chosen' ? choice.site : undefined;
}

/** Why the Jira Test can't fetch the key typed, in plain words; absent when it can. */
export function jiraTestProblem(jira: JiraRowView): string | undefined {
  if (chosenJiraSite(jira) === undefined) return 'Check Jira first: the Test fetches from the site the check chose.';
  const key = jira.key.trim();
  if (!isTicketKey(key)) return `Type a Jira ticket key such as ABC-123${key === '' ? '' : `, not ${JSON.stringify(key)}`}.`;
  return undefined;
}

/** The sites, by their hosts, as the row names them. */
function siteNames(sites: readonly JiraSite[]): string {
  return sites.map((site) => jiraSiteHost(site)).join(', ');
}

/**
 * What the row says of the check, each state with its plain message and
 * its next step: connected with the site, needs a login, not configured,
 * or couldn't be checked.
 */
export function jiraLines(jira: JiraRowView): { status: string; next?: string } {
  const { check } = jira;
  if (check === undefined) {
    return { status: 'Not checked yet.', next: 'Check Jira asks Claude Code whether its Atlassian connection can read Jira; it fetches no ticket and stores no Jira login.' };
  }
  if (check.state === 'checking') return { status: 'Checking Claude Code’s Atlassian connection…' };
  if (check.state === 'failed') return { status: `✕ Jira could not be checked: ${check.message}`, next: 'Check again once Claude Code runs.' };
  const { result } = check;
  if (result.state === 'failed') return { status: `✕ Jira could not be checked: ${result.message}`, next: 'Check again once Claude Code runs.' };
  if (result.state === 'not-configured') return { status: '✕ Not configured: Claude Code has no Atlassian connection.', next: `${CONNECTOR_STEP} ${FALLBACK_STEP}` };
  if (result.state === 'needs-login') {
    const next = result.route === 'connector' ? CONNECTOR_STEP.replace('Authorise', 'Reconnect') : `Sign Atlassian’s MCP server in again with ${JIRA_FALLBACK_LOGIN}, then check again.`;
    return { status: `✕ Needs login: ${result.detail}.`, next };
  }
  const through = result.route === 'connector' ? 'the claude.ai Atlassian connector' : 'Atlassian’s MCP server (the fallback)';
  const choice = jiraSiteChoice(jira);
  if (choice === undefined) return { status: `✓ Connected through ${through}.` };
  if ('problem' in choice) return { status: `✓ Connected through ${through}.`, next: 'Fix the second-look.jira.site setting, or empty it, then check again.' };
  if (choice.state === 'chosen') return { status: `✓ Connected through ${through} · site ${jiraSiteHost(choice.site)}.`, next: 'Type a ticket key and press Test to fetch it.' };
  if (choice.state === 'none') return { status: `✓ Connected through ${through}, but the Atlassian account reaches no Jira site.`, next: 'Sign the connection in with the Atlassian account that holds your Jira site, then check again.' };
  if (choice.state === 'several') {
    return { status: `✓ Connected through ${through}. The account reaches several Jira sites: ${siteNames(choice.sites)}.`, next: 'Set second-look.jira.site to the one to read tickets from, then check again.' };
  }
  return {
    status: `✓ Connected through ${through}, but second-look.jira.site names ${choice.host}, which the account doesn’t reach. It reaches: ${siteNames(choice.sites) || 'no Jira site'}.`,
    next: 'Set second-look.jira.site to one of those sites, or empty it, then check again.',
  };
}

/** The Jira Test's line: fetching, the ticket's key and summary, or why none was read. */
function jiraTestLine(jira: JiraRowView): string {
  const { test } = jira;
  if (test === undefined) return '';
  const text =
    test.state === 'testing'
      ? `Fetching ${test.key} from Jira…`
      : test.state === 'failed'
        ? `✕ The test could not run: ${test.message}`
        : test.result.ok
          ? `✓ ${test.result.key} · ${test.result.summary}`
          : `✕ ${test.result.message}`;
  return `<p class="note test" role="status">${escapeHtml(text)}</p>`;
}

/**
 * The setup form's Jira row (issue 191): the tracker login's check, each
 * state with its message and next step, the site it chose or the sites
 * to choose from, and the Test, which fetches the one ticket the reviewer
 * types. Under Pi, the row says Jira criteria need Claude Code.
 */
export function jiraRow(view: SetupView): string {
  const { jira } = view;
  const reveal = jira.reveal === undefined ? '' : ` data-reveal="${jira.reveal}"`;
  const heading = `<h3 class="label" id="setup-jira">Jira</h3>`;
  if (view.draft.agent === 'pi') {
    return `<div class="jira" id="setup-jira-row"${reveal}>${heading}<p class="note">Jira criteria need Claude Code: Pi has no MCP and runs offline, so a review on Pi reads no Jira ticket. Choose Claude Code above to connect Jira.</p></div>`;
  }
  const lines = jiraLines(jira);
  const checking = jira.check?.state === 'checking';
  const check = setupButton('checkJira', jira.check === undefined ? 'Check Jira' : 'Check again', 'secondary', '', checking);
  const choice = jiraSiteChoice(jira);
  const siteSetting = choice !== undefined && ('problem' in choice || choice.state === 'several' || choice.state === 'not-reached') ? setupButton('jiraSite', 'Open the site setting', 'link') : '';
  const site = chosenJiraSite(jira);
  const test =
    site === undefined
      ? ''
      : textBox('jiraKey', 'Ticket key to test', jira.key, 'e.g. ABC-123') +
        `<div class="actions">${setupButton('testJira', 'Test', 'secondary', '', jira.test?.state === 'testing')}</div>`;
  const problem = jira.problem === undefined ? '' : `<p class="note problem" role="alert">${escapeHtml(jira.problem)}</p>`;
  const setting = jiraSiteSetting(jira.site);
  const settingProblem = 'problem' in setting ? `<p class="note problem">${escapeHtml(`${setting.problem.charAt(0).toUpperCase()}${setting.problem.slice(1)}.`)}</p>` : '';
  return (
    `<div class="jira" id="setup-jira-row"${reveal}>` +
    heading +
    settingProblem +
    `<p class="note" role="status">${escapeHtml(lines.status)}</p>` +
    (lines.next === undefined ? '' : `<p class="note">${escapeHtml(lines.next)}</p>`) +
    `<div class="actions">${check}${siteSetting}</div>` +
    test +
    problem +
    jiraTestLine(jira) +
    `</div>`
  );
}

/**
 * Step 1's setup form: a card per installed agent from the probe, the
 * model — tested ones first, then the agent's default, then any other by
 * name — the effort levels with the default first and the tested ones
 * marked, the optional account label, and the agent path field, only when
 * the probe found no agent. Save, Use the defaults and Test below, then
 * the Jira row.
 */
export function setupFormBody(view: SetupView): string {
  const { draft } = view;
  const probed = probedAgent(view, draft.agent);
  const agents = AGENT_NAMES.map((agent) => radio('agent', agent, agentLabel(agent), agent === draft.agent, agentLine(view, agent))).join('');
  const path =
    probed === undefined || probed.installed
      ? ''
      : textBox('path', `Path to the ${agentLabel(draft.agent)} executable`, draft.path, '/usr/local/bin/…') +
        `<div class="actions">${setupButton('usePath', 'Use this path', 'secondary')}</div>`;
  const tested = testedModels(draft.agent);
  const models =
    tested.map((model) => radio('model', model, model, !draft.other && draft.model === model, testedAtText(draft.agent, model) ?? '')).join('') +
    radio('model', '', 'Default model', !draft.other && draft.model === '', `${agentLabel(draft.agent)}'s own default`) +
    radio('other', '', 'Other…', draft.other, 'in the agent’s own naming');
  const other = draft.other ? textBox('otherModel', 'Model name', draft.model, 'such as sonnet or anthropic/claude-sonnet-5') : '';
  const isTested = (level: string): boolean => isTestedModel(TESTED_MODELS, draft.agent, draft.model, level === '' ? DEFAULT_EFFORT : level);
  const efforts = ['', ...effortLevels(draft.agent, probed)]
    .map((level) => radio('effort', level, level === '' ? 'default' : level, draft.effort === level, isTested(level) ? '✓ tested' : ''))
    .join('');
  const problem = view.problem === undefined ? '' : `<p class="note problem" role="alert">${escapeHtml(view.problem)}</p>`;
  const testing = view.test?.state === 'testing';
  return (
    `<div class="setup">` +
    group('setup-agent-label', 'Agent', agents) +
    agentNotes(view) +
    path +
    group('setup-model-label', 'Model', models) +
    other +
    group('setup-effort-label', 'Effort', efforts) +
    textBox('account', 'Account label (optional)', draft.account, 'e.g. Claude Max (work address)') +
    problem +
    `<div class="actions">${setupButton('save', 'Save', 'primary')}${setupButton('defaults', 'Use the defaults', 'secondary')}${setupButton('test', 'Test', 'secondary', '', testing)}</div>` +
    testLine(view) +
    jiraRow(view) +
    `</div>`
  );
}
