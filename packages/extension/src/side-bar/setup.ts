import { isAbsolute } from 'node:path';
import {
  AGENT_NAMES,
  DEFAULT_EFFORT,
  TESTED_MODELS,
  isTestedModel,
  modelAndEffortProblem,
  type AgentName,
  type AgentStamp,
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
}

/** The fields the form's controls edit. */
export type SetupField = 'agent' | 'model' | 'other' | 'otherModel' | 'effort' | 'account' | 'path';

/** The form's buttons. */
export type SetupAction = 'open' | 'save' | 'defaults' | 'test' | 'usePath' | 'install';

/** A change or a press in the setup form, as the side bar's script reports it. */
export type SetupMessage =
  | { type: 'setup'; field: SetupField; value: string }
  | { type: 'setup'; action: SetupAction; value: string; fields: Partial<Record<SetupField, string>> };

const FIELDS: readonly SetupField[] = ['agent', 'model', 'other', 'otherModel', 'effort', 'account', 'path'];
const ACTIONS: readonly SetupAction[] = ['open', 'save', 'defaults', 'test', 'usePath', 'install'];
/** The fields typed in a text box, which a press carries as they stand. */
const TEXT_FIELDS: readonly SetupField[] = ['otherModel', 'account', 'path'];

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

/**
 * Step 1's setup form: a card per installed agent from the probe, the
 * model — tested ones first, then the agent's default, then any other by
 * name — the effort levels with the default first and the tested ones
 * marked, the optional account label, and the agent path field, only when
 * the probe found no agent. Save, Use the defaults and Test below.
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
    `</div>`
  );
}
