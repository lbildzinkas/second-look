import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import { ConfigurationTarget, QuickPickItemKind, stub, stubContext } from './vscode-stub.js';
import { activate } from '../src/extension.js';
import { chooseAgent } from '../src/agent-picker.js';
import { AgentStatusBar } from '../src/agent-status.js';
import { CHOOSE_AGENT_COMMAND, OPEN_REVIEW_CONTAINER_COMMAND } from '../src/commands.js';

interface Item {
  label: string;
  description?: string;
  detail?: string;
  kind?: number;
}

/** Answers each quick pick in turn with the item whose label is the next one given; past the last, dismisses. */
function pick(...labels: string[]): (items: unknown[]) => unknown {
  const queue = [...labels];
  return (items) => {
    const label = queue.shift();
    if (label === undefined) return undefined;
    const item = (items as Item[]).find((each) => each.label === label || each.label.endsWith(` ${label}`));
    if (item === undefined) throw new Error(`no item "${label}" in ${JSON.stringify(items)}`);
    return item;
  };
}

function items(index: number): Item[] {
  return stub.quickPicks[index]!.items as Item[];
}

describe('the agent quick pick', () => {
  beforeEach(() => stub.reset());

  it('summarises the agent, model with its tested effort, effort and account label, then the setup in the side bar', async () => {
    stub.configuration = {
      'second-look.agent': 'claude-code',
      'second-look.agentModel': 'claude-sonnet-5-5',
      'second-look.agentEffort': 'high',
      'second-look.agentAccount': 'Claude Max (work)',
    };
    await chooseAgent();
    expect(stub.quickPicks[0]!.title).toBe('Second Look: Choose agent and model');
    expect(items(0).map(({ label, description }) => ({ label, description }))).toEqual([
      { label: '$(hubot) Agent', description: 'Claude Code' },
      { label: '$(sparkle) Model', description: 'claude-sonnet-5-5 · $(pass) tested at high' },
      { label: '$(dashboard) Effort', description: 'high' },
      { label: '$(account) Account label', description: 'Claude Max (work)' },
      { label: '', description: undefined },
      { label: '$(layout-sidebar-left) Open the setup in the side bar', description: undefined },
    ]);
    expect(items(0)[4]!.kind).toBe(QuickPickItemKind.Separator);
    expect(items(0).every((item) => item.detail === undefined)).toBe(true);
    // Dismissed: nothing written.
    expect(stub.configurationUpdates).toEqual([]);
  });

  it('names each default before any choice', async () => {
    await chooseAgent();
    expect(items(0).slice(0, 4).map((item) => item.description)).toEqual(['Pi', 'default model', 'default effort', 'none']);
  });

  it('changes the model in the user settings, offering the tested models first, and the status bar shows the beaker for an untested one', async () => {
    stub.configuration = { 'second-look.agent': 'claude-code' };
    const bar = new AgentStatusBar({});
    bar.refresh();
    stub.quickPickResult = pick('Model', 'Other…');
    stub.inputBoxResult = ' claude-opus-5-5 ';
    await chooseAgent();
    expect(items(1).map(({ label, description }) => ({ label, description }))).toEqual([
      { label: 'claude-sonnet-5-5', description: '$(pass) tested at high' },
      { label: 'Default model', description: "Claude Code's own default · in use" },
      { label: 'Other…', description: 'type the model in the agent’s own naming' },
    ]);
    expect(stub.configurationUpdates).toEqual([{ key: 'second-look.agentModel', value: 'claude-opus-5-5', target: ConfigurationTarget.Global }]);
    expect(stub.statusBarItems[0]!.text).toBe('$(beaker) Second Look: Claude Code · claude-opus-5-5 · default effort');
    bar.dispose();
  });

  it('marks the untested model in use among the models', async () => {
    stub.configuration = { 'second-look.agent': 'claude-code', 'second-look.agentModel': 'sonnet' };
    stub.quickPickResult = pick('Model', 'claude-sonnet-5-5');
    await chooseAgent();
    expect(items(1).map((item) => item.label)).toEqual(['claude-sonnet-5-5', 'sonnet', 'Default model', 'Other…']);
    expect(items(1)[1]!.description).toBe('in use');
    expect(stub.configurationUpdates).toEqual([{ key: 'second-look.agentModel', value: 'claude-sonnet-5-5', target: ConfigurationTarget.Global }]);
  });

  it('continues from a new agent to its model and effort, writing each to the user settings', async () => {
    stub.quickPickResult = pick('Agent', 'Claude Code', 'claude-sonnet-5-5', 'high');
    await chooseAgent();
    expect(items(1).map((item) => item.label)).toEqual(['Pi', 'Claude Code']);
    expect(items(1)[0]!.description).toBe('in use');
    // Pi's model is not Claude Code's, so none is marked in use.
    expect(items(2).some((item) => item.description?.includes('in use'))).toBe(false);
    expect(items(3).map((item) => item.label)).toEqual(['Default effort', 'low', 'medium', 'high', 'xhigh', 'max']);
    expect(items(3).find((item) => item.label === 'high')!.description).toBe('$(pass) tested with this model');
    expect(stub.configurationUpdates).toEqual([
      { key: 'second-look.agent', value: 'claude-code', target: ConfigurationTarget.Global },
      { key: 'second-look.agentModel', value: 'claude-sonnet-5-5', target: ConfigurationTarget.Global },
      { key: 'second-look.agentEffort', value: 'high', target: ConfigurationTarget.Global },
    ]);
  });

  it('stops after the agent when the model pick is dismissed', async () => {
    stub.quickPickResult = pick('Agent', 'Claude Code');
    await chooseAgent();
    expect(stub.quickPicks).toHaveLength(3);
    expect(stub.configurationUpdates.map((update) => update.key)).toEqual(['second-look.agent']);
  });

  it("changes the effort among the agent's levels, the default one included", async () => {
    stub.configuration = { 'second-look.agentModel': 'zai-coding-cn/glm-5.3', 'second-look.agentEffort': 'high' };
    stub.quickPickResult = pick('Effort', 'Default effort');
    await chooseAgent();
    expect(items(1).map((item) => item.label)).toEqual(['Default effort', 'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
    expect(items(1)[0]!.description).toBe('$(pass) tested with this model');
    expect(items(1).find((item) => item.label === 'high')!.description).toBe('in use');
    expect(stub.configurationUpdates).toEqual([{ key: 'second-look.agentEffort', value: '', target: ConfigurationTarget.Global }]);
  });

  it('edits the account label, and a dismissed box changes nothing', async () => {
    stub.configuration = { 'second-look.agentAccount': 'old' };
    stub.quickPickResult = pick('Account label');
    await chooseAgent();
    expect(stub.inputBoxes[0]!.value).toBe('old');
    expect(stub.configurationUpdates).toEqual([]);

    stub.quickPickResult = pick('Account label');
    stub.inputBoxResult = ' Pi personal key ';
    await chooseAgent();
    expect(stub.configurationUpdates).toEqual([{ key: 'second-look.agentAccount', value: 'Pi personal key', target: ConfigurationTarget.Global }]);
  });

  it('marks a value a workspace setting overrides, and warns when the edit it overrides is written', async () => {
    stub.workspaceConfiguration = { 'second-look.agentModel': 'sonnet' };
    stub.quickPickResult = pick('Model', 'zai-coding-cn/glm-5.3');
    await chooseAgent();
    expect(items(0)[1]!.detail).toContain('Set in the workspace settings, which override the user settings');
    expect(items(0)[0]!.detail).toBeUndefined();
    expect(stub.configurationUpdates).toEqual([{ key: 'second-look.agentModel', value: 'zai-coding-cn/glm-5.3', target: ConfigurationTarget.Global }]);
    expect(stub.warningMessages.filter((message) => message.includes('workspace setting'))).toEqual([
      'A workspace setting for second-look.agentModel overrides the user setting just changed, so the choice takes no effect here. ' +
        'Remove it from the workspace settings to use the choice.',
    ]);
  });

  it('opens the setup in the side bar', async () => {
    stub.quickPickResult = pick('Open the setup in the side bar');
    await chooseAgent();
    expect(stub.executedCommands).toEqual([{ id: OPEN_REVIEW_CONTAINER_COMMAND, args: [] }]);
    expect(stub.configurationUpdates).toEqual([]);
  });

  it('is the command activate registers, which the manifest names "Choose agent and model"', async () => {
    activate(stubContext() as never, {});
    const command = stub.commands.find((each) => each.id === CHOOSE_AGENT_COMMAND);
    expect(command).toBeDefined();
    await command!.handler();
    expect(stub.quickPicks[0]!.title).toBe('Second Look: Choose agent and model');
    const manifest = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8')) as {
      contributes: { commands: { command: string; title: string; category: string }[] };
    };
    expect(manifest.contributes.commands).toContainEqual({ command: CHOOSE_AGENT_COMMAND, title: 'Choose agent and model', category: 'Second Look' });
  });
});
