import { beforeEach, describe, expect, it } from 'vitest';
import { NO_MARKS, type AgentPaths, type JiraProbeRpcResult, type JiraTestParams, type JiraTestRpcResult, type ReviewAgentChoice, type TestAgentRpcResult } from '@second-look/engine';
import { activate } from '../src/extension.js';
import { sideBarBody } from '../src/side-bar/page.js';
import { sideBarMessage } from '../src/side-bar/provider.js';
import { setupFormBody, setupMessage, stampLine, type ProbedAgent, type SetupAction, type SetupField, type SetupView } from '../src/side-bar/setup.js';
import { SETUP_SEEN_KEY, SetupForm, opensByItself, type SetupEngine } from '../src/side-bar/setup-form.js';
import { sideBarSteps, type SideBarState } from '../src/side-bar/steps.js';
import { ConfigurationTarget, stub, stubContext } from './vscode-stub.js';

const CLAUDE_READY: ProbedAgent = {
  agent: 'claude-code',
  installed: true,
  version: '2.1.296',
  usable: true,
  supports: { effort: true },
  effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
  login: { source: 'the stored Claude subscription sign-in' },
  lockdown: ['tool allowlist: Read, Grep, Glob'],
};
const CLAUDE_MISSING: ProbedAgent = {
  agent: 'claude-code',
  installed: false,
  version: '',
  usable: false,
  reason: 'Claude Code is not installed: no claude command was found on the PATH the engine started with',
  supports: { effort: false },
  effortLevels: [],
  lockdown: [],
};
const PI_READY: ProbedAgent = {
  agent: 'pi',
  installed: true,
  version: '0.86.1',
  usable: true,
  supports: { effort: true },
  effortLevels: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
  lockdown: ['guard extension'],
};
const STAMP = { agent: 'claude-code', agentVersion: '2.1.296', model: 'claude-sonnet-5-5', effort: 'high', runAt: '2026-10-10T00:00:00.000Z' };

const SITE = { id: '11111111-2222-3333-4444-555555555555', url: 'https://your-team.atlassian.net', name: 'Your Team' };
const OTHER_SITE = { id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', url: 'https://other-team.atlassian.net', name: 'Other Team' };

/** What the Jira double answers: the check, and the test. */
interface JiraAnswers {
  check?: JiraProbeRpcResult;
  test?: JiraTestRpcResult;
}

/** An engine double: answers the probe from the path settings it is given, and records every test and Jira check. */
function fakeEngine(
  answer: TestAgentRpcResult = { ok: true, stamp: STAMP },
  jira: JiraAnswers = {},
): SetupEngine & { probes: AgentPaths[]; tests: ReviewAgentChoice[]; jiraChecks: ReviewAgentChoice[]; jiraTests: JiraTestParams[] } {
  const engine = {
    probes: [] as AgentPaths[],
    tests: [] as ReviewAgentChoice[],
    jiraChecks: [] as ReviewAgentChoice[],
    jiraTests: [] as JiraTestParams[],
    probeJira(agent: ReviewAgentChoice) {
      engine.jiraChecks.push(agent);
      return Promise.resolve(jira.check ?? ({ state: 'connected', route: 'connector', sites: [SITE] } as JiraProbeRpcResult));
    },
    testJira(params: JiraTestParams) {
      engine.jiraTests.push(params);
      return Promise.resolve(jira.test ?? ({ ok: true, key: params.key, summary: 'Retry the webhook' } as JiraTestRpcResult));
    },
    probeAgents(paths: AgentPaths) {
      engine.probes.push(paths);
      const claude = paths['claude-code'] === '/opt/claude/bin/claude' ? CLAUDE_READY : CLAUDE_MISSING;
      return Promise.resolve({ agents: [PI_READY, claude] });
    },
    testAgent(agent: ReviewAgentChoice) {
      engine.tests.push(agent);
      return Promise.resolve(answer);
    },
  };
  return engine;
}

/** A setup form on the stub's global state, counting its redraws. */
function form(engine = fakeEngine()): { setup: SetupForm; engine: ReturnType<typeof fakeEngine>; redraws: () => number } {
  let redraws = 0;
  const setup = new SetupForm({ engine: () => Promise.resolve(engine), globalState: stubContext().globalState as never, onChange: () => (redraws += 1) });
  return { setup, engine, redraws: () => redraws };
}

/** Lets the form's probe and test settle. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** A change or a press as the page's script reports it: a field with its value, or an action with the text boxes' text. */
type Sent = { field: SetupField; value: string } | { action: SetupAction; value?: string; fields?: Partial<Record<SetupField, string>> };

async function send(setup: SetupForm, message: Sent): Promise<void> {
  const read = setupMessage({ type: 'setup', ...('action' in message ? { value: '', fields: {} } : {}), ...message });
  expect(read).toBeDefined();
  await setup.handle(read!);
  await settle();
}

function view(overrides: Partial<SetupView> = {}): SetupView {
  return {
    open: true,
    draft: { agent: 'claude-code', model: 'claude-sonnet-5-5', other: false, effort: 'high', account: '', path: '' },
    probe: { state: 'probed', agents: [PI_READY, CLAUDE_READY] },
    jira: { site: '', key: '' },
    ...overrides,
  };
}

describe('the setup form', () => {
  beforeEach(() => stub.reset());

  it('shows a card per agent with its version, readiness and login, the tested model first and marked, then the default and Other…', () => {
    const body = setupFormBody(view());
    expect(body).toContain('aria-checked="false" id="setup-agent-pi" class="choice" data-field="agent" data-value="pi">Pi<small>0.86.1 · ready · its own login</small>');
    expect(body).toContain(
      'aria-checked="true" id="setup-agent-claude-code" class="choice" data-field="agent" data-value="claude-code">Claude Code<small>2.1.296 · ready · the stored Claude subscription sign-in</small>',
    );
    const models = [...body.matchAll(/data-field="(?:model|other)" data-value="[^"]*">([^<]*)<small>([^<]*)</g)].map((match) => `${match[1]} · ${match[2]}`);
    expect(models).toEqual(['claude-sonnet-5-5 · tested at high', "Default model · Claude Code&#39;s own default", 'Other… · in the agent’s own naming']);
    expect(body).not.toContain('id="setup-otherModel"');
    expect(body).toContain('id="setup-account" class="setup-text" data-field="account" value="" placeholder="e.g. Claude Max (work address)"');
    expect(body).toContain('data-action="save"');
    expect(body).toContain('data-action="defaults"');
    expect(body).toContain('data-action="test"');
    // Installed: no agent path field.
    expect(body).not.toContain('data-field="path"');
  });

  it("offers the agent's effort levels, the default first and the tested level marked", () => {
    const efforts = [...setupFormBody(view()).matchAll(/data-field="effort" data-value="[^"]*">([^<]*)(?:<small>([^<]*))?/g)].map((match) =>
      [match[1], match[2]].filter(Boolean).join(' '),
    );
    expect(efforts).toEqual(['default', 'low', 'medium', 'high ✓ tested', 'xhigh', 'max']);
    // Pi's tested model runs at Pi's default effort, so the default is the one marked.
    const pi = setupFormBody(view({ draft: { agent: 'pi', model: 'zai-coding-cn/glm-5.3', other: false, effort: '', account: '', path: '' } }));
    expect(pi).toContain('data-value="">default<small>✓ tested</small>');
  });

  it('types any other model under Other…', () => {
    const body = setupFormBody(view({ draft: { agent: 'claude-code', model: 'opus', other: true, effort: '', account: '', path: '' } }));
    expect(body).toContain('aria-checked="true" id="setup-other-default"');
    expect(body).toContain('id="setup-otherModel" class="setup-text" data-field="otherModel" value="opus"');
  });

  it('shows an agent not found with its reason and install link, and the agent path field only then', () => {
    const missing = view({ probe: { state: 'probed', agents: [PI_READY, CLAUDE_MISSING] } });
    const body = setupFormBody(missing);
    expect(body).toContain('Claude Code<small>not found</small>');
    expect(body).toContain('no claude command was found on the PATH the engine started with');
    expect(body).toContain('data-action="install" data-value="claude-code">Install Claude Code</button>');
    expect(body).toContain('<label class="label" for="setup-path">Path to the Claude Code executable</label>');
    expect(body).toContain('data-action="usePath"');
    // With Pi chosen, which was found, no path field shows.
    expect(setupFormBody({ ...missing, draft: { ...missing.draft, agent: 'pi' } })).not.toContain('data-field="path"');
    // While the probe runs, nothing is known yet.
    const probing = setupFormBody(view({ probe: { state: 'probing' } }));
    expect(probing).toContain('Pi<small>checking…</small>');
    expect(probing).not.toContain('data-field="path"');
  });

  it('escapes every probe fact it shows', () => {
    const hostile = { ...CLAUDE_MISSING, reason: '<img src=x onerror=alert(1)>' };
    const body = setupFormBody(view({ probe: { state: 'probed', agents: [PI_READY, hostile] }, draft: { ...view().draft, path: '"><script>' } }));
    expect(body).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(body).not.toMatch(/<img|<script/);
  });

  it('shows the test result: ok with the stamp, or the reason it failed', () => {
    expect(stampLine({ ...STAMP, login: { source: 'the stored Claude subscription sign-in' }, account: 'work' })).toBe(
      'claude-code 2.1.296 · claude-sonnet-5-5 · effort high · the stored Claude subscription sign-in · work',
    );
    expect(setupFormBody(view({ test: { state: 'tested', result: { ok: true, stamp: STAMP } } }))).toContain(
      '<p class="note test" role="status">✓ ok · claude-code 2.1.296 · claude-sonnet-5-5 · effort high</p>',
    );
    const failed = { ok: false as const, reason: 'not-signed-in' as const, message: 'Claude Code is not signed in: Invalid API key', stamp: { ...STAMP, model: null, effort: null } };
    expect(setupFormBody(view({ test: { state: 'tested', result: failed } }))).toContain(
      '✕ Claude Code is not signed in: Invalid API key · claude-code 2.1.296 · model unknown · default effort',
    );
    const testing = setupFormBody(view({ test: { state: 'testing' } }));
    expect(testing).toContain('one tiny run of the chosen agent, model and effort…');
    expect(testing).toMatch(/data-action="test" data-value="" disabled>Test</);
  });

  it('reads only the changes and presses the form makes', () => {
    expect(sideBarMessage({ type: 'setup', field: 'agent', value: 'pi' })).toEqual({ type: 'setup', field: 'agent', value: 'pi' });
    expect(sideBarMessage({ type: 'setup', action: 'save', value: '', fields: { account: 'work', other: 'x', evil: 1 } })).toEqual({
      type: 'setup',
      action: 'save',
      value: '',
      fields: { account: 'work' },
    });
    expect(sideBarMessage({ type: 'setup', action: 'deleteEverything', value: '' })).toBeUndefined();
    expect(sideBarMessage({ type: 'setup', field: 'toString', value: '' })).toBeUndefined();
    expect(sideBarMessage({ type: 'setup', field: 'agent' })).toBeUndefined();
  });
});

describe("step 1's card", () => {
  const base: SideBarState = { settings: { agent: 'pi', model: '', effort: '', account: '' }, marks: NO_MARKS, sections: [], reviewing: false, storyRead: false };

  it('is the current step with the form while it is open, and folds to one line with a change link otherwise', () => {
    const open = { ...base, setup: view() };
    expect(sideBarSteps(open).map((step) => step.state).slice(0, 2)).toEqual(['current', 'to come']);
    expect(sideBarBody(open)).toContain('<div class="setup">');
    expect(sideBarBody(open)).not.toContain('id="step-1-change"');

    const folded = { ...base, setup: view({ open: false }) };
    expect(sideBarSteps(folded).map((step) => step.state).slice(0, 2)).toEqual(['done', 'current']);
    expect(sideBarBody(folded)).not.toContain('<div class="setup">');
    expect(sideBarBody(folded)).toContain('id="step-1-change" data-action="open"');
  });
});

describe('the setup form controller', () => {
  beforeEach(() => stub.reset());

  it('opens by itself only on the first open: no agent setting in any scope and the flag not set', async () => {
    expect(opensByItself(stubContext().globalState as never)).toBe(true);
    const { setup, engine } = form();
    expect(setup.current.open).toBe(true);
    // Drawn: seen for good, and the installed agents probed.
    setup.shown();
    await settle();
    expect(stub.globalState[SETUP_SEEN_KEY]).toBe(true);
    expect(engine.probes).toEqual([{}]);
    expect(setup.current.probe).toEqual({ state: 'probed', agents: [PI_READY, CLAUDE_MISSING] });
    expect(form().setup.current.open).toBe(false);

    stub.reset();
    stub.workspaceConfiguration['second-look.agent'] = 'pi';
    expect(opensByItself(stubContext().globalState as never)).toBe(false);
    // Folded, a draw probes nothing.
    const later = form();
    later.setup.shown();
    await settle();
    expect(later.engine.probes).toEqual([]);
  });

  it('saves the agent, model, effort and account to the user settings, and folds', async () => {
    const { setup } = form();
    setup.shown();
    await settle();
    await send(setup, { field: 'agent', value: 'claude-code' });
    // A new agent starts on its first tested combination.
    expect(setup.current.draft).toMatchObject({ agent: 'claude-code', model: 'claude-sonnet-5-5', effort: 'high' });
    await send(setup, { field: 'effort', value: 'max' });
    await send(setup, { action: 'save', fields: { account: '  Claude Max (work)  ' } });

    expect(stub.configurationUpdates).toEqual([
      { key: 'second-look.agent', value: 'claude-code', target: ConfigurationTarget.Global },
      { key: 'second-look.agentModel', value: 'claude-sonnet-5-5', target: ConfigurationTarget.Global },
      { key: 'second-look.agentEffort', value: 'max', target: ConfigurationTarget.Global },
      { key: 'second-look.agentAccount', value: 'Claude Max (work)', target: ConfigurationTarget.Global },
    ]);
    expect(setup.current.open).toBe(false);
    expect(stub.globalState[SETUP_SEEN_KEY]).toBe(true);
  });

  it('refuses a model or effort the engine would refuse, in its words, and writes nothing', async () => {
    const { setup, engine } = form();
    await send(setup, { field: 'other', value: '' });
    await send(setup, { field: 'otherModel', value: '--dangerously-skip-permissions' });
    await send(setup, { action: 'save' });
    expect(setup.current.problem).toBe(
      'Not saved or tested: the model "--dangerously-skip-permissions" is not a plain name: use only letters, digits and . _ - / :, not starting with -.',
    );
    await send(setup, { action: 'test' });
    expect(engine.tests).toEqual([]);
    expect(stub.configurationUpdates).toEqual([]);
    expect(setup.current.open).toBe(true);
  });

  it('"Use the defaults" dismisses the form for good, writing no setting', async () => {
    const { setup } = form();
    await send(setup, { action: 'defaults' });
    expect(setup.current.open).toBe(false);
    expect(stub.configurationUpdates).toEqual([]);
    expect(stub.globalState[SETUP_SEEN_KEY]).toBe(true);
    expect(form().setup.current.open).toBe(false);
  });

  it('runs the test only when pressed, once, on the chosen combination with its path, and shows its result', async () => {
    stub.configuration['second-look.claudeCodePath'] = '/opt/claude/bin/claude';
    const { setup, engine } = form(fakeEngine({ ok: false, reason: 'timeout', message: 'Claude Code did not answer within 300 seconds', stamp: STAMP }));
    setup.shown();
    await send(setup, { field: 'agent', value: 'claude-code' });
    expect(engine.tests).toEqual([]);

    await send(setup, { action: 'test', fields: { account: 'work' } });
    expect(engine.tests).toEqual([{ agent: 'claude-code', model: 'claude-sonnet-5-5', effort: 'high', account: 'work', path: '/opt/claude/bin/claude' }]);
    expect(setup.current.test).toEqual({
      state: 'tested',
      result: { ok: false, reason: 'timeout', message: 'Claude Code did not answer within 300 seconds', stamp: STAMP },
    });
    // The result describes the combination it ran: another clears it.
    await send(setup, { field: 'effort', value: 'low' });
    expect(setup.current.test).toBeUndefined();
    expect(stub.configurationUpdates).toEqual([]);
  });

  it('clears the result when only the account changes, since the engine stamps it on the result', async () => {
    const { setup, engine } = form();
    setup.shown();
    await send(setup, { field: 'agent', value: 'claude-code' });
    await send(setup, { action: 'test', fields: { account: 'work' } });
    expect(engine.tests).toEqual([{ agent: 'claude-code', model: 'claude-sonnet-5-5', effort: 'high', account: 'work' }]);
    expect(setup.current.test).toEqual({ state: 'tested', result: { ok: true, stamp: STAMP } });
    // Whitespace around the same label is the same run, as the test trims it.
    await send(setup, { field: 'account', value: ' work ' });
    expect(setup.current.test).toEqual({ state: 'tested', result: { ok: true, stamp: STAMP } });
    await send(setup, { field: 'account', value: 'personal' });
    expect(setup.current.test).toBeUndefined();
  });

  it("drops a test's late answer once the form was closed and opened again on another draft", async () => {
    let answer: (result: TestAgentRpcResult) => void = () => undefined;
    const engine = { ...fakeEngine(), testAgent: () => new Promise<TestAgentRpcResult>((resolve) => (answer = resolve)) };
    const { setup } = form(engine);
    await send(setup, { field: 'agent', value: 'claude-code' });
    const pressed = setup.handle(setupMessage({ type: 'setup', action: 'test', value: '', fields: {} })!);
    await settle();
    expect(setup.current.test).toEqual({ state: 'testing' });

    await send(setup, { action: 'defaults' });
    await send(setup, { action: 'open' });
    answer({ ok: true, stamp: STAMP });
    await pressed;
    expect(setup.current.draft.agent).toBe('pi');
    expect(setup.current.test).toBeUndefined();
  });

  it('writes the agent path field to the user settings when the agent is not found, then probes again and shows it ready', async () => {
    const { setup, engine } = form();
    setup.shown();
    await send(setup, { field: 'agent', value: 'claude-code' });
    expect(setupFormBody(setup.current)).toContain('data-field="path"');

    await send(setup, { action: 'usePath', fields: { path: 'bin/claude' } });
    expect(setup.current.problem).toBe('The path must be an absolute path to the executable, not "bin/claude".');
    expect(stub.configurationUpdates).toEqual([]);

    await send(setup, { action: 'usePath', fields: { path: ' /opt/claude/bin/claude ' } });
    expect(stub.configurationUpdates).toEqual([{ key: 'second-look.claudeCodePath', value: '/opt/claude/bin/claude', target: ConfigurationTarget.Global }]);
    expect(engine.probes).toEqual([{}, { 'claude-code': '/opt/claude/bin/claude' }]);
    const body = setupFormBody(setup.current);
    expect(body).toContain('Claude Code<small>2.1.296 · ready · the stored Claude subscription sign-in</small>');
    expect(body).not.toContain('data-field="path"');
  });

  it('drops the test result when the used path changes the executable the next test would start', async () => {
    const notInstalled: TestAgentRpcResult = {
      ok: false,
      reason: 'unusable',
      message: 'Claude Code is not installed: no claude command was found on the PATH the engine started with',
      stamp: { ...STAMP, model: null, effort: null },
    };
    const { setup } = form(fakeEngine(notInstalled));
    setup.shown();
    await send(setup, { field: 'agent', value: 'claude-code' });
    await send(setup, { action: 'test' });
    expect(setup.current.test).toEqual({ state: 'tested', result: notInstalled });
    expect(setupFormBody(setup.current)).toContain('no claude command was found on the PATH the engine started with');

    await send(setup, { action: 'usePath', fields: { path: '/opt/claude/bin/claude' } });
    expect(setup.current.test).toBeUndefined();
    const body = setupFormBody(setup.current);
    expect(body).toContain('Claude Code<small>2.1.296 · ready · the stored Claude subscription sign-in</small>');
    expect(body).not.toContain('no claude command was found');
  });

  it('warns when a workspace setting overrides the path the form writes, which still wins the probe', async () => {
    stub.workspaceConfiguration['second-look.claudeCodePath'] = '/broken/claude';
    const { setup } = form();
    setup.shown();
    await send(setup, { field: 'agent', value: 'claude-code' });
    await send(setup, { action: 'usePath', fields: { path: '/opt/claude/bin/claude' } });
    expect(stub.configurationUpdates).toEqual([{ key: 'second-look.claudeCodePath', value: '/opt/claude/bin/claude', target: ConfigurationTarget.Global }]);
    expect(stub.warningMessages).toEqual([
      'A workspace setting for second-look.claudeCodePath overrides the user setting just changed, so the choice takes no effect here. ' +
        'Remove it from the workspace settings to use the choice.',
    ]);
    expect(setupFormBody(setup.current)).toContain('Claude Code<small>not found</small>');
  });

  it('shows why the agents could not be probed', async () => {
    let redraws = 0;
    const setup = new SetupForm({
      engine: () => Promise.reject(new Error('the engine stopped')),
      globalState: stubContext().globalState as never,
      onChange: () => (redraws += 1),
    });
    setup.shown();
    await settle();
    expect(setup.current.probe).toEqual({ state: 'failed', message: 'the engine stopped' });
    expect(setupFormBody(setup.current)).toContain('The installed agents could not be checked: the engine stopped');
    expect(redraws).toBe(2);
  });

  it('opens the install page of an agent not found, outside the editor', async () => {
    const { setup } = form();
    await send(setup, { action: 'install', value: 'claude-code' });
    await send(setup, { action: 'install', value: 'https://example.com' });
    expect(stub.openedExternals).toEqual(['https://code.claude.com/docs/en/setup']);
  });
});

describe("the setup form's Jira row", () => {
  beforeEach(() => stub.reset());

  /** The Jira row's text, its tags dropped, as the reviewer reads it. */
  function rowText(jira: SetupView['jira'], draft?: SetupView['draft']): string {
    const body = setupFormBody(view({ jira, ...(draft !== undefined ? { draft } : {}) }));
    const row = body.slice(body.indexOf('<div class="jira"'));
    return row.replace(/<[^>]+>/g, ' ').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim();
  }
  const checked = (result: JiraProbeRpcResult, site = ''): SetupView['jira'] => ({ site, key: '', check: { state: 'checked', result } });

  it('shows each state of the check with its own plain message and next step', () => {
    expect(rowText({ site: '', key: '' })).toBe(
      'Jira Not checked yet. Check Jira asks Claude Code whether its Atlassian connection can read Jira; it fetches no ticket and stores no Jira login. Check Jira',
    );
    expect(rowText({ site: '', key: '', check: { state: 'checking' } })).toContain('Checking Claude Code’s Atlassian connection…');

    const connected = rowText(checked({ state: 'connected', route: 'connector', sites: [SITE] }));
    expect(connected).toContain('✓ Connected through the claude.ai Atlassian connector · site your-team.atlassian.net.');
    expect(connected).toContain('Type a ticket key and press Test to fetch it.');

    const login = rowText(checked({ state: 'needs-login', route: 'connector', detail: 'Claude Code reports the Atlassian connection needs a sign-in' }));
    expect(login).toContain('✕ Needs login: Claude Code reports the Atlassian connection needs a sign-in.');
    expect(login).toContain('Reconnect the Atlassian connector at claude.ai → Settings → Connectors, signed in to the Claude account this profile’s Claude Code uses');
    expect(login).not.toContain('Ticket key to test');
    const fallbackLogin = rowText(checked({ state: 'needs-login', route: 'fallback', detail: 'Claude Code reports the Atlassian connection needs a sign-in' }));
    expect(fallbackLogin).toContain('Sign Atlassian’s MCP server in again with claude mcp login atlassian, then check again.');

    const none = rowText(checked({ state: 'not-configured' }));
    expect(none).toContain('✕ Not configured: Claude Code has no Atlassian connection.');
    expect(none).toContain('Authorise the Atlassian connector at claude.ai → Settings → Connectors');
    expect(none).toContain(
      'Without the connector, add Atlassian’s own MCP server once with claude mcp add -s user --transport http atlassian https://mcp.atlassian.com/v2/mcp, sign it in with claude mcp login atlassian, then check again.',
    );

    const failed = rowText(checked({ state: 'failed', message: 'Claude Code did not finish within 120 seconds' }));
    expect(failed).toContain('✕ Jira could not be checked: Claude Code did not finish within 120 seconds Check again once Claude Code runs. Check again');
    expect(rowText({ site: '', key: '', check: { state: 'failed', message: 'the engine stopped' } })).toContain('✕ Jira could not be checked: the engine stopped');
  });

  it('names the sites found when the account reaches several and no setting picks one, and picks the one the setting names', () => {
    const several = checked({ state: 'connected', route: 'connector', sites: [SITE, OTHER_SITE] });
    const text = rowText(several);
    expect(text).toContain('The account reaches several Jira sites: your-team.atlassian.net, other-team.atlassian.net.');
    expect(text).toContain('Set second-look.jira.site to the one to read tickets from, then check again.');
    expect(text).toContain('Open the site setting');
    expect(text).not.toContain('Ticket key to test');

    expect(rowText({ ...several, site: 'https://other-team.atlassian.net/' })).toContain('· site other-team.atlassian.net.');
    expect(rowText({ ...several, site: 'third.atlassian.net' })).toContain(
      'second-look.jira.site names third.atlassian.net, which the account doesn’t reach. It reaches: your-team.atlassian.net, other-team.atlassian.net.',
    );
  });

  it('refuses a site setting that is not an atlassian.net host, before and after the check', () => {
    expect(rowText({ site: 'jira.example.com', key: '' })).toContain('The Jira site setting must be a Jira Cloud site such as your-team.atlassian.net, not "jira.example.com".');
    const after = rowText(checked({ state: 'connected', route: 'connector', sites: [SITE] }, 'your-team.atlassian.net.evil.com'));
    expect(after).toContain('The Jira site setting must be a Jira Cloud site');
    expect(after).toContain('Fix the second-look.jira.site setting, or empty it, then check again.');
    // No site is chosen from a refused setting, so nothing can be fetched.
    expect(after).not.toContain('Ticket key to test');
  });

  it('says Jira criteria need Claude Code when the agent is Pi, with nothing to check', () => {
    const text = rowText({ site: '', key: '' }, { agent: 'pi', model: '', other: false, effort: '', account: '', path: '' });
    expect(text).toBe('Jira Jira criteria need Claude Code: Pi has no MCP and runs offline, so a review on Pi reads no Jira ticket. Choose Claude Code above to connect Jira.');
  });

  it('checks the connection on Claude Code when Check Jira is pressed, and tests the key typed on the chosen site', async () => {
    stub.configuration['second-look.agent'] = 'claude-code';
    stub.configuration['second-look.agentModel'] = 'claude-sonnet-5-5';
    stub.configuration['second-look.claudeCodePath'] = '/opt/claude/bin/claude';
    const { setup, engine } = form(fakeEngine(undefined, { check: { state: 'connected', route: 'connector', sites: [SITE] } }));
    setup.open();
    await settle();
    expect(engine.jiraChecks).toEqual([]);

    await send(setup, { action: 'checkJira' });
    expect(engine.jiraChecks).toEqual([{ agent: 'claude-code', model: 'claude-sonnet-5-5', path: '/opt/claude/bin/claude' }]);
    expect(setup.current.jira.check).toEqual({ state: 'checked', result: { state: 'connected', route: 'connector', sites: [SITE] } });

    await send(setup, { action: 'testJira', fields: { jiraKey: 'not a key' } });
    expect(setup.current.jira.problem).toBe('Type a Jira ticket key such as ABC-123, not "not a key".');
    expect(engine.jiraTests).toEqual([]);

    await send(setup, { action: 'testJira', fields: { jiraKey: ' PORT-42 ' } });
    expect(engine.jiraTests).toEqual([{ agent: { agent: 'claude-code', model: 'claude-sonnet-5-5', path: '/opt/claude/bin/claude' }, route: 'connector', site: SITE, key: 'PORT-42' }]);
    expect(setupFormBody(setup.current)).toContain('<p class="note test" role="status">✓ PORT-42 · Retry the webhook</p>');
  });

  it("shows the test's plain failure, and escapes the ticket's own text", async () => {
    stub.configuration['second-look.agent'] = 'claude-code';
    const failing = form(fakeEngine(undefined, { test: { ok: false, message: 'Jira did not return PORT-9: Issue does not exist' } }));
    failing.setup.open();
    await send(failing.setup, { action: 'checkJira' });
    await send(failing.setup, { action: 'testJira', fields: { jiraKey: 'PORT-9' } });
    expect(setupFormBody(failing.setup.current)).toContain('✕ Jira did not return PORT-9: Issue does not exist');

    const hostile = form(fakeEngine(undefined, { test: { ok: true, key: 'PORT-1', summary: '<img src=x onerror=alert(1)>' } }));
    hostile.setup.open();
    await send(hostile.setup, { action: 'checkJira' });
    await send(hostile.setup, { action: 'testJira', fields: { jiraKey: 'PORT-1' } });
    const body = setupFormBody(hostile.setup.current);
    expect(body).toContain('✓ PORT-1 · &lt;img src=x onerror=alert(1)&gt;');
    expect(body).not.toContain('<img');
  });

  it('opens the form at its Jira row from Connect Jira and checks at once, scrolling to the row once per press', async () => {
    stub.configuration['second-look.agent'] = 'claude-code';
    stub.configuration['second-look.jira.site'] = 'your-team.atlassian.net';
    const { setup, engine } = form(fakeEngine(undefined, { check: { state: 'not-configured' } }));
    // An agent is set, so the form did not open by itself.
    expect(setup.current.open).toBe(false);

    await send(setup, { action: 'openJira' });
    expect(setup.current.open).toBe(true);
    expect(engine.jiraChecks).toHaveLength(1);
    expect(setup.current.jira.site).toBe('your-team.atlassian.net');
    expect(setupFormBody(setup.current)).toContain('<div class="jira" id="setup-jira-row" data-reveal="1">');
    expect(setupFormBody(setup.current)).toContain('✕ Not configured: Claude Code has no Atlassian connection.');
    await send(setup, { action: 'openJira' });
    expect(setup.current.jira.reveal).toBe(2);
  });

  it('runs no Jira check from Connect Jira under Pi, and opens the site setting from its link', async () => {
    const { setup, engine } = form();
    await send(setup, { action: 'openJira' });
    expect(engine.jiraChecks).toEqual([]);
    expect(setupFormBody(setup.current)).toContain('Jira criteria need Claude Code');

    await send(setup, { action: 'jiraSite' });
    expect(stub.executedCommands.at(-1)).toEqual({ id: 'workbench.action.openSettings', args: ['second-look.jira.site'] });
  });
});

describe('the first open, activated', () => {
  beforeEach(() => stub.reset());

  it("opens step 1's form by itself with no settings, and never again once seen", () => {
    const spawnEngine = (): never => {
      throw new Error('no engine here');
    };
    const sideBar = activate(stubContext() as never, { spawnEngine });
    expect(sideBarSteps(sideBar.current)[0]).toMatchObject({ number: 1, state: 'current', open: true });

    stub.reset();
    stub.globalState[SETUP_SEEN_KEY] = true;
    const later = activate(stubContext() as never, { spawnEngine });
    expect(sideBarSteps(later.current)[0]).toMatchObject({ number: 1, state: 'done', open: false });
  });
});
