import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type * as vscode from 'vscode';
import {
  ADD_COMMENT_COMMAND,
  COMMENT_ON_PART_COMMAND,
  DISCARD_COMMENT_COMMAND,
  OPEN_ALL_PARTS_COMMAND,
  OPEN_PART_COMMAND,
  REVIEW_COMMAND,
  REVIEW_TREE_VIEW,
  SUBMIT_REVIEW_COMMAND,
  activate,
} from '../../src/extension.js';
import { changeUri } from '../../src/change-copies.js';
import { mixedResult } from '../results.js';
import {
  Range,
  stub,
  stubContext,
  workspace,
  type StubTreeView,
  type StubWebviewPanel,
} from '../vscode-stub.js';

const FAKE_ENGINE = fileURLToPath(new URL('../fixtures/fake-engine.mjs', import.meta.url));
const PR_URL = 'https://github.com/example-org/example-repo/pull/42';
const TOKEN = 'ghp_test-token-do-not-print';

const workDir = mkdtempSync(join(tmpdir(), 'second-look-extension-'));

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
});

interface FakeEngineOptions {
  result?: unknown;
  error?: string;
  sendError?: string;
  logName: string;
  /** A stage notification to send before the answer, which then waits this long. */
  stage?: { running: string; timeoutMs: number; result: unknown };
  answerDelayMs?: number;
  /** How long the engine waits before answering sendReview. */
  sendDelayMs?: number;
}

function fakeEngine(options: FakeEngineOptions): ChildProcessWithoutNullStreams {
  return spawn(process.execPath, [FAKE_ENGINE], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      ...(options.result !== undefined
        ? { FAKE_ENGINE_RESULT: JSON.stringify(options.result) }
        : {}),
      ...(options.error !== undefined ? { FAKE_ENGINE_ERROR: options.error } : {}),
      ...(options.stage !== undefined ? { FAKE_ENGINE_STAGE: JSON.stringify(options.stage) } : {}),
      ...(options.answerDelayMs !== undefined
        ? { FAKE_ENGINE_ANSWER_DELAY_MS: String(options.answerDelayMs) }
        : {}),
      ...(options.sendError !== undefined
        ? { FAKE_ENGINE_SEND_ERROR: options.sendError }
        : {}),
      ...(options.sendDelayMs !== undefined
        ? { FAKE_ENGINE_SEND_DELAY_MS: String(options.sendDelayMs) }
        : {}),
      FAKE_ENGINE_LOG: join(workDir, options.logName),
    },
  });
}

/** The commands activating the companion registers. */
function registeredCommands(): Map<string, (...args: unknown[]) => unknown> {
  return new Map(stub.commands.map((command) => [command.id, command.handler]));
}

/** Activates the extension against a fake engine and returns its tree view. */
async function reviewWithFakeEngine(options: FakeEngineOptions): Promise<StubTreeView> {
  activate(stubContext() as unknown as vscode.ExtensionContext, {
    spawnEngine: () => fakeEngine(options),
  });
  expect([...registeredCommands().keys()]).toEqual([
    REVIEW_COMMAND,
    OPEN_PART_COMMAND,
    OPEN_ALL_PARTS_COMMAND,
    SUBMIT_REVIEW_COMMAND,
    ADD_COMMENT_COMMAND,
    COMMENT_ON_PART_COMMAND,
    DISCARD_COMMENT_COMMAND,
  ]);

  stub.inputBoxResult = PR_URL;
  stub.session = { accessToken: TOKEN };
  await registeredCommands().get(REVIEW_COMMAND)!() as Promise<void>;

  expect(stub.treeViews).toHaveLength(1);
  return stub.treeViews[0]!;
}

interface TestProvider {
  getChildren(node?: unknown): unknown[];
  getTreeItem(node: unknown): {
    label?: string;
    description?: string;
    tooltip?: string;
    contextValue?: string;
    command?: { command: string; title: string; arguments?: unknown[] };
  };
}

function providerOf(view: StubTreeView): TestProvider {
  return view.provider as TestProvider;
}

/** The tree's nodes, as the view renders them. */
function renderedTree(view: StubTreeView): { label: string; description?: string; tooltip?: string; contextValue?: string }[] {
  const provider = providerOf(view);
  const rendered: { label: string; description?: string; tooltip?: string; contextValue?: string }[] = [];
  for (const node of provider.getChildren()) {
    const item = provider.getTreeItem(node);
    rendered.push({
      label: item.label ?? '',
      description: item.description,
      tooltip: item.tooltip,
      contextValue: item.contextValue,
    });
    for (const child of provider.getChildren(node)) {
      const childItem = provider.getTreeItem(child);
      rendered.push({
        label: childItem.label ?? '',
        description: childItem.description,
        tooltip: childItem.tooltip,
        contextValue: childItem.contextValue,
      });
    }
  }
  return rendered;
}

/** The tree node with this label, the argument clicking it passes on. */
function partClick(
  view: StubTreeView,
  label: string,
): { command: string; arguments: unknown[] } | undefined {
  const provider = providerOf(view);
  for (const node of provider.getChildren()) {
    for (const child of provider.getChildren(node)) {
      const item = provider.getTreeItem(child);
      if (item.label === label && item.command !== undefined) {
        return { command: item.command.command, arguments: item.command.arguments ?? [] };
      }
    }
  }
  return undefined;
}

/** An editor the double can show, recording what the extension did to it. */
interface RecordingEditor {
  document: { uri: { toString(): string } };
  revealed: { start: number; end: number; type: number }[];
  decorated: { type: unknown; ranges: unknown[] }[];
  revealRange(range: unknown, type: number): void;
  setDecorations(type: unknown, ranges: unknown[]): void;
}

function editorFor(uri: { toString(): string }): RecordingEditor {
  const editor: RecordingEditor = {
    document: { uri },
    revealed: [],
    decorated: [],
    revealRange(range, type) {
      const r = range as { start: { line: number }; end: { line: number } };
      editor.revealed.push({ start: r.start.line, end: r.end.line, type });
    },
    setDecorations(type, ranges) {
      editor.decorated.push({ type, ranges });
    },
  };
  return editor;
}

beforeEach(() => {
  stub.reset();
});

describe('activating the companion', () => {
  it('registers the review commands and the review tree, and serves the change read-only', () => {
    activate(stubContext() as unknown as vscode.ExtensionContext, {
      spawnEngine: () => {
        throw new Error('no review ran');
      },
    });

    expect(stub.commands.map((command) => command.id)).toEqual([
      REVIEW_COMMAND,
      OPEN_PART_COMMAND,
      OPEN_ALL_PARTS_COMMAND,
      SUBMIT_REVIEW_COMMAND,
      ADD_COMMENT_COMMAND,
      COMMENT_ON_PART_COMMAND,
      DISCARD_COMMENT_COMMAND,
    ]);
    expect(stub.treeViews.map((view) => view.id)).toEqual([REVIEW_TREE_VIEW]);
    expect(stub.fileSystemProviders.map((entry) => entry.scheme)).toEqual(['second-look-change']);
    expect(stub.fileSystemProviders[0]!.options?.isReadonly).toBeInstanceOf(Object);
    expect(stub.commentControllers.map((controller) => controller.id)).toEqual(['second-look']);
  });

  it('shows the placeholder before any review ran, with nothing to open', () => {
    activate(stubContext() as unknown as vscode.ExtensionContext, {
      spawnEngine: () => {
        throw new Error('no review ran');
      },
    });

    const provider = providerOf(stub.treeViews[0]!);
    const placeholder = provider.getChildren()[0]!;
    expect(provider.getTreeItem(placeholder).label).toBe(
      'Review a pull request to see its parts here, ranked by importance.',
    );
    expect(provider.getTreeItem(placeholder).command).toBeUndefined();
  });
});

describe('the review command, end to end against a fake engine', () => {
  it('signs in with VS Code, passes the token per request, and fills the ranked tree', async () => {
    const view = await reviewWithFakeEngine({ result: mixedResult(), logName: 'happy.log' });

    // Progress showed while the engine worked, and the sign-in is the
    // editor's own GitHub session.
    expect(stub.progressTitles).toEqual(['Reading the pull request…']);
    expect(stub.sessionRequests).toEqual([
      { id: 'github', scopes: ['repo'], createIfNone: true },
    ]);

    // The tree shows the importance groups in order, the reason beside
    // each part, the signals in its tooltip, and the noise last.
    expect(renderedTree(view)).toEqual([
      { label: 'Must review', tooltip: 'The parts to read first.' },
      {
        label: 'src/retry.py',
        description: 'New code the send path now runs on every delivery.',
        tooltip: 'new code\n2 callers\nno tests before this pull request\nPlain ranking',
        contextValue: 'part',
      },
      { label: 'Worth reviewing', tooltip: 'The parts worth a careful read.' },
      {
        label: 'src/settings.ts',
        description: 'Changed code that the retry policy reads.',
        tooltip: 'changed code\nPlain ranking',
        contextValue: 'part',
      },
      { label: 'Context', tooltip: 'The parts that only give background to the change.' },
      {
        label: 'CHANGELOG.md',
        description: 'Release note only.',
        tooltip: 'documentation only\nPlain ranking',
        contextValue: 'part',
      },
      { label: 'Not ranked yet', tooltip: 'The engine has not ranked these parts yet.' },
      { label: 'src/legacy.ts', contextValue: 'part' },
      {
        label: '__tests__/retry.test.ts.snap',
        tooltip: 'snapshot · claimed — Only known snapshot names are matched.',
        contextValue: 'part',
      },
      {
        label: 'Noise',
        tooltip:
          'Changes that need no careful reading; the label says whether it was confirmed or only claimed.',
      },
      {
        label: 'uv.lock',
        description: 'lockfile · claimed',
        tooltip: 'Only known lockfile names are matched.',
        contextValue: 'noise',
      },
      {
        label: 'transport.py',
        description: 'moved or renamed · confirmed',
        tooltip: 'Identical content proves only the move.',
        contextValue: 'noise',
      },
    ]);
    expect(view.revealed).toHaveLength(1);
    expect(stub.errorMessages).toEqual([]);

    // The engine, a separate process, got the handshake first and then
    // the URL and the token from the sign-in, with nothing stored.
    const requests = readFileSync(join(workDir, 'happy.log'), 'utf8')
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => JSON.parse(line) as { method: string; params: { url?: string; token?: string } });
    expect(requests[0]).toMatchObject({ method: 'initialize' });
    expect(requests[1]).toMatchObject({
      method: 'review',
      params: { url: PR_URL, token: TOKEN },
    });
  });

  it('reads an engine failure as a plain message', async () => {
    const view = await reviewWithFakeEngine({
      error: 'GitHub is down',
      logName: 'error.log',
    });

    expect(stub.errorMessages).toEqual(['GitHub is down']);
    expect(renderedTree(view)).toEqual([
      {
        label: 'Review a pull request to see its parts here, ranked by importance.',
        contextValue: 'part',
      },
    ]);
  });

  it('does nothing without a pull request URL', async () => {
    activate(stubContext() as unknown as vscode.ExtensionContext, {
      spawnEngine: () => fakeEngine({ result: mixedResult(), logName: 'dismissed.log' }),
    });
    stub.inputBoxResult = undefined;
    stub.session = { accessToken: TOKEN };

    await registeredCommands().get(REVIEW_COMMAND)!() as Promise<void>;

    expect(stub.sessionRequests).toEqual([]);
    expect(stub.progressTitles).toEqual([]);
    expect(renderedTree(stub.treeViews[0]!)).toEqual([
      {
        label: 'Review a pull request to see its parts here, ranked by importance.',
        contextValue: 'part',
      },
    ]);
  });

  it('asks again later when the reviewer is not signed in', async () => {
    activate(stubContext() as unknown as vscode.ExtensionContext, {
      spawnEngine: () => fakeEngine({ result: mixedResult(), logName: 'no-session.log' }),
    });
    stub.inputBoxResult = PR_URL;
    stub.session = undefined;

    await registeredCommands().get(REVIEW_COMMAND)!() as Promise<void>;

    expect(stub.warningMessages).toEqual(['Sign in to GitHub to review a pull request.']);
    expect(stub.progressTitles).toEqual([]);
  });

  it('shows the plain sign-in message when the reviewer cancels the GitHub sign-in', async () => {
    activate(stubContext() as unknown as vscode.ExtensionContext, {
      spawnEngine: () => fakeEngine({ result: mixedResult(), logName: 'cancelled-sign-in.log' }),
    });
    stub.inputBoxResult = PR_URL;
    stub.cancelSignIn = true;

    await registeredCommands().get(REVIEW_COMMAND)!() as Promise<void>;

    expect(stub.warningMessages).toEqual(['Sign in to GitHub to review a pull request.']);
    expect(stub.progressTitles).toEqual([]);
  });
});

/** Waits until the condition holds, checking every few milliseconds. */
async function until(what: string, condition: () => boolean): Promise<void> {
  for (let waited = 0; !condition(); waited += 10) {
    if (waited > 5_000) throw new Error(`timed out waiting for ${what}`);
    await new Promise((done) => setTimeout(done, 10));
  }
}

describe('a review arriving in stages', () => {
  it('shows the plain tree first, names the running stage, then regroups in place keeping the selected part', async () => {
    const plain = mixedResult();
    const [retry, settings, ...rest] = plain.parts;
    const { name: _name, signals: _signals, rank: _rank, ...settingsFile } = settings!;
    const grouped = {
      ...plain,
      parts: [
        { ...retry!, name: 'send, with the retry settings it reads', origin: 'agent', otherFiles: [settingsFile] },
        ...rest,
      ],
      grouping: {
        by: 'agent',
        agent: {
          promptVersion: '1',
          outcome: 'grouped',
          detail: 'every hunk was placed by the agent',
          leftOut: 0,
          stamp: { agent: 'pi', agentVersion: '0.86.1', model: 'zai/glm-4.6', effort: null, runAt: '2026-10-02T00:00:00.000Z' },
        },
      },
    };
    activate(stubContext() as unknown as vscode.ExtensionContext, {
      spawnEngine: () =>
        fakeEngine({
          result: grouped,
          stage: { running: 'grouping related hunks with pi', timeoutMs: 60_000, result: plain },
          answerDelayMs: 500,
          logName: 'staged.log',
        }),
    });
    stub.inputBoxResult = PR_URL;
    stub.session = { accessToken: TOKEN };
    const reviewed = registeredCommands().get(REVIEW_COMMAND)!() as Promise<void>;
    const view = stub.treeViews[0]!;

    // The plain tree shows before any agent result, with the stage named.
    await until('the plain tree', () => partClick(view, 'src/settings.ts') !== undefined);
    expect(view.message).toBe('Plain parts shown; grouping related hunks with pi…');
    expect(view.revealed).toHaveLength(1);

    // The reviewer is on the settings part when the agent's parts arrive.
    const provider = providerOf(view);
    const settingsNode = provider
      .getChildren()
      .flatMap((section) => provider.getChildren(section))
      .find((node) => provider.getTreeItem(node).label === 'src/settings.ts');
    view.selection = [settingsNode];
    await reviewed;

    expect(renderedTree(view).map((node) => node.label)).toContain('send, with the retry settings it reads');
    expect(renderedTree(view).map((node) => node.label)).not.toContain('src/settings.ts');
    expect(view.message).toBe(
      'Grouped by pi · zai/glm-4.6 (grouping prompt v1): every hunk was placed by the agent.',
    );
    // The part now holding the settings change is selected, without taking focus.
    expect(view.revealed).toHaveLength(2);
    expect(view.revealed[1]!.options).toEqual({ select: true, focus: false });
    expect(provider.getTreeItem(view.selection[0]).label).toBe('send, with the retry settings it reads');
    expect(stub.errorMessages).toEqual([]);

    // Clicking the regrouped part opens both of its files.
    const click = partClick(view, 'send, with the retry settings it reads')!;
    await registeredCommands().get(click.command)!(...click.arguments);
    const base = (path: string) => changeUri('base', plain.copies.base.commit, path);
    const head = (path: string) => changeUri('head', plain.copies.head.commit, path);
    expect(stub.executedCommands).toEqual([
      {
        id: 'vscode.changes',
        args: [
          'send, with the retry settings it reads',
          [
            [head('src/retry.py'), base('src/retry.py'), head('src/retry.py')],
            [head('src/settings.ts'), base('src/settings.ts'), head('src/settings.ts')],
          ],
        ],
      },
    ]);
  });
});

describe('the agent ranking arriving', () => {
  it('re-ranks the tree in place, and the tooltip names the cited signals and the agent ranking', async () => {
    const plain = mixedResult();
    const [retry, settings, ...rest] = plain.parts;
    const stamp = { agent: 'pi', agentVersion: '0.86.1', model: 'zai/glm-4.6', effort: null, runAt: '2026-10-04T00:00:00.000Z' };
    const ranked = {
      ...plain,
      parts: [
        { ...settings!, rank: { importance: 'must review', reason: 'changes the retry limit every caller reads', signals: ['changed code'] } },
        { ...retry!, rank: { importance: 'worth reviewing', reason: 'new loop around an unchanged send', signals: ['new code'] } },
        ...rest,
      ],
      ranking: {
        by: 'agent',
        agent: { promptVersion: '1', outcome: 'ranked', detail: 'the validator accepted the ranking of 4 parts', stamp },
      },
    };
    activate(stubContext() as unknown as vscode.ExtensionContext, {
      spawnEngine: () =>
        fakeEngine({
          result: ranked,
          stage: { running: 'ranking the parts with pi', timeoutMs: 60_000, result: plain },
          answerDelayMs: 500,
          logName: 'ranked.log',
        }),
    });
    stub.inputBoxResult = PR_URL;
    stub.session = { accessToken: TOKEN };
    const reviewed = registeredCommands().get(REVIEW_COMMAND)!() as Promise<void>;
    const view = stub.treeViews[0]!;

    await until('the plain tree', () => partClick(view, 'src/settings.ts') !== undefined);
    expect(view.message).toBe('Plain parts shown; ranking the parts with pi…');
    expect(renderedTree(view)[1]).toMatchObject({ label: 'src/retry.py' });
    await reviewed;

    expect(renderedTree(view).slice(0, 4)).toEqual([
      { label: 'Must review', tooltip: 'The parts to read first.' },
      {
        label: 'src/settings.ts',
        description: 'changes the retry limit every caller reads',
        tooltip: 'changed code\nAgent ranking: pi · zai/glm-4.6 (ranking prompt v1)',
        contextValue: 'part',
      },
      { label: 'Worth reviewing', tooltip: 'The parts worth a careful read.' },
      {
        label: 'src/retry.py',
        description: 'new loop around an unchanged send',
        tooltip: 'new code\nAgent ranking: pi · zai/glm-4.6 (ranking prompt v1)',
        contextValue: 'part',
      },
    ]);
    expect(view.message).toBe('Ranked by pi · zai/glm-4.6 (ranking prompt v1): the validator accepted the ranking of 4 parts.');
    expect(stub.errorMessages).toEqual([]);
  });
});

describe('reading a part in the multi-file diff', () => {
  const copies = () => mixedResult().copies;
  const base = (path: string) => changeUri('base', copies().base.commit, path);
  const head = (path: string) => changeUri('head', copies().head.commit, path);

  /** Clicks the tree row for a part, the way selecting it does. */
  async function clickPart(view: StubTreeView, label: string): Promise<void> {
    const click = partClick(view, label);
    expect(click?.command).toBe(OPEN_PART_COMMAND);
    await registeredCommands().get(OPEN_PART_COMMAND)!(...(click?.arguments ?? [])) as Promise<void>;
  }

  it('opens a clicked part with exactly its files, base left and head right', async () => {
    const view = await reviewWithFakeEngine({ result: mixedResult(), logName: 'open-part.log' });

    await clickPart(view, 'src/retry.py');

    expect(stub.executedCommands).toEqual([
      {
        id: 'vscode.changes',
        args: [
          'src/retry.py',
          [[head('src/retry.py'), base('src/retry.py'), head('src/retry.py')]],
        ],
      },
    ]);
  });

  it('scrolls to the part first hunk and marks its lines once the diff shows them', async () => {
    const view = await reviewWithFakeEngine({ result: mixedResult(), logName: 'marking.log' });

    await clickPart(view, 'src/retry.py');
    const modified = editorFor(head('src/retry.py'));
    const original = editorFor(base('src/retry.py'));
    stub.fireVisibleTextEditors([modified, original]);

    expect(modified.revealed).toEqual([{ start: 2, end: 12, type: 1 }]);
    expect(modified.decorated).toEqual([
      {
        type: stub.decorationTypes[0],
        ranges: [{ start: { line: 4, character: 0 }, end: { line: 10, character: Number.MAX_SAFE_INTEGER } }],
      },
    ]);
    expect(original.decorated).toEqual([
      {
        type: stub.decorationTypes[0],
        ranges: [{ start: { line: 4, character: 0 }, end: { line: 5, character: Number.MAX_SAFE_INTEGER } }],
      },
    ]);
    expect(original.revealed).toEqual([]);
  });

  it('replaces an earlier part marks with the next click', async () => {
    const view = await reviewWithFakeEngine({ result: mixedResult(), logName: 're-mark.log' });

    await clickPart(view, 'src/retry.py');
    const earlier = editorFor(head('src/retry.py'));
    stub.fireVisibleTextEditors([earlier]);
    expect(earlier.decorated).toHaveLength(1);

    await clickPart(view, 'src/settings.ts');
    expect(earlier.decorated).toHaveLength(2); // cleared, then left alone
    expect(earlier.decorated[1]).toEqual({ type: stub.decorationTypes[0], ranges: [] });

    const next = editorFor(head('src/settings.ts'));
    stub.fireVisibleTextEditors([earlier, next]);
    expect(next.decorated).toEqual([]); // settings has no hunks in the fixture
    expect(stub.executedCommands.at(-1)).toEqual({
      id: 'vscode.changes',
      args: [
        'src/settings.ts',
        [[head('src/settings.ts'), base('src/settings.ts'), head('src/settings.ts')]],
      ],
    });
  });

  it('serves the cached base and head content read-only, and refuses writes', async () => {
    await reviewWithFakeEngine({ result: mixedResult(), logName: 'read-only.log' });
    const content = new TextEncoder().encode('cached head content\n');
    stub.files.set(`${copies().head.path}/src/retry.py`, content);

    await expect(workspace.fs.readFile(head('src/retry.py'))).resolves.toEqual(content);
    await expect(
      workspace.fs.writeFile(head('src/retry.py'), new TextEncoder().encode('edited')),
    ).rejects.toThrow('the base and head copies are read-only');
  });

  it('opens the whole change in one multi-file diff, in the tree order with the noise last', async () => {
    const view = await reviewWithFakeEngine({ result: mixedResult(), logName: 'open-all.log' });
    expect(partClick(view, 'uv.lock')?.command).toBe(OPEN_PART_COMMAND);

    await registeredCommands().get(OPEN_ALL_PARTS_COMMAND)!() as Promise<void>;

    expect(stub.executedCommands).toEqual([
      {
        id: 'vscode.changes',
        args: [
          'Retry failed webhook sends (#42)',
          [
            [head('src/retry.py'), base('src/retry.py'), head('src/retry.py')],
            [head('src/settings.ts'), base('src/settings.ts'), head('src/settings.ts')],
            [head('CHANGELOG.md'), base('CHANGELOG.md'), head('CHANGELOG.md')],
            [head('src/legacy.ts'), base('src/legacy.ts'), head('src/legacy.ts')],
            [head('__tests__/retry.test.ts.snap'), base('__tests__/retry.test.ts.snap'), head('__tests__/retry.test.ts.snap')],
            [head('uv.lock'), base('uv.lock'), head('uv.lock')],
            [head('transport.py'), base('transport.py'), head('transport.py')],
          ],
        ],
      },
    ]);

    // The first part in order is the one the editor scrolls and marks.
    const modified = editorFor(head('src/retry.py'));
    stub.fireVisibleTextEditors([modified]);
    expect(modified.revealed).toEqual([{ start: 2, end: 12, type: 1 }]);
  });

  it('asks for a review before opening all parts when none ran yet', async () => {
    activate(stubContext() as unknown as vscode.ExtensionContext, {
      spawnEngine: () => {
        throw new Error('no review ran');
      },
    });

    await registeredCommands().get(OPEN_ALL_PARTS_COMMAND)!() as Promise<void>;

    expect(stub.warningMessages).toEqual([
      'Review a pull request first, then open all its parts in order.',
    ]);
    expect(stub.executedCommands).toEqual([]);
  });
});
describe('the pending review and sending it', () => {
  const copies = () => mixedResult().copies;
  const head = (path: string) => changeUri('head', copies().head.commit, path);
  const base = (path: string) => changeUri('base', copies().base.commit, path);
  const SENT_URL = 'https://github.com/example-org/example-repo/pull/42#pullrequestreview-4242';

  /** The requests the fake engine logged, as JSON values. */
  function engineRequests(logName: string): { method: string; params?: Record<string, unknown> }[] {
    return readFileSync(join(workDir, logName), 'utf8')
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => JSON.parse(line) as { method: string; params?: Record<string, unknown> });
  }

  /** Awaits what a page's submit finishes asynchronously, polling for it. */
  async function eventually<T>(what: string, probe: () => T | undefined): Promise<T> {
    const deadline = Date.now() + 5_000;
    for (;;) {
      const found = probe();
      if (found !== undefined) {
        return found;
      }
      if (Date.now() > deadline) {
        throw new Error(`timed out waiting for ${what}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  /** The Send review page the submit command opened. */
  function sendPage(): StubWebviewPanel {
    const panel = stub.webviewPanels[0];
    expect(panel).toBeDefined();
    return panel!;
  }

  /** A move on the page, the way its own script reports it. */
  function drive(page: StubWebviewPanel, message: unknown): void {
    page.webview.receive(message);
  }

  it('gathers a line and a part comment, and sends them as one review from the page', async () => {
    const view = await reviewWithFakeEngine({ result: mixedResult(), logName: 'send.log' });
    const sessionRequestsBefore = stub.sessionRequests.length;

    // A line comment, written in a thread on the head side of the diff.
    const line = stub.commentControllers[0]!.createCommentThread(head('src/retry.py'), new Range(4, 0, 4, 0), []);
    await registeredCommands().get(ADD_COMMENT_COMMAND)!({ thread: line, text: 'this retry loop needs a cap' });
    // A part comment, started from the tree's part.
    const click = partClick(view, 'src/retry.py');
    await registeredCommands().get(COMMENT_ON_PART_COMMAND)!(...(click?.arguments ?? []));
    const partThread = stub.commentControllers[0]!.threads.at(-1)!;
    await registeredCommands().get(ADD_COMMENT_COMMAND)!({ thread: partThread, text: 'the loop reads well overall' });

    // The pending review gathers in its own tree section, above the parts,
    // and nothing has asked for the write yet: no engine send, no session.
    expect(renderedTree(view).slice(0, 3)).toEqual([
      {
        label: 'Pending review',
        tooltip: 'The comments you wrote, sent to GitHub as one review on submit.',
      },
      { label: 'src/retry.py:5', description: 'this retry loop needs a cap', tooltip: 'this retry loop needs a cap', contextValue: 'comment' },
      { label: 'src/retry.py (part)', description: 'the loop reads well overall', tooltip: 'the loop reads well overall', contextValue: 'comment' },
    ]);
    expect(engineRequests('send.log').map((request) => request.method)).toEqual(['initialize', 'review']);
    expect(stub.sessionRequests).toHaveLength(sessionRequestsBefore);

    // Submit review… opens the Send review page: both comments together,
    // each with where it points, still nothing sent.
    await registeredCommands().get(SUBMIT_REVIEW_COMMAND)!() as Promise<void>;
    const page = sendPage();
    expect(page.title).toBe('Send review');
    expect(page.webview.posted.at(-1)).toEqual({
      type: 'state',
      drafts: [
        { id: 1, where: 'src/retry.py:5', body: 'this retry loop needs a cap' },
        { id: 2, where: 'src/retry.py (part)', body: 'the loop reads well overall' },
      ],
      body: '',
      submit: 'comment',
      sending: false,
    });

    // The reviewer edits one comment on the page, writes the overall
    // comment, picks how to submit, and presses Submit.
    drive(page, { type: 'edit', id: 1, body: 'this retry loop needs a cap — and a test' });
    drive(page, { type: 'body', body: 'One deliberate pass.' });
    drive(page, { type: 'kind', submit: 'comment' });
    stub.informationChoice = 'Open on GitHub';
    drive(page, { type: 'submit' });

    // The write permission was asked for at send time only, and the engine
    // got one sendReview: the kind, the overall comment, both comments,
    // the line one as edited on the page.
    await eventually('the review to be sent', () =>
      stub.informationMessages[0] !== undefined ? true : undefined,
    );
    expect(stub.sessionRequests).toHaveLength(sessionRequestsBefore + 1);
    expect(stub.sessionRequests.at(-1)).toEqual({ id: 'github', scopes: ['repo'], createIfNone: true });
    const requests = engineRequests('send.log');
    expect(requests.at(-1)).toMatchObject({
      method: 'sendReview',
      params: {
        url: PR_URL,
        token: TOKEN,
        review: {
          submit: 'comment',
          body: 'One deliberate pass.',
          comments: [
            { kind: 'line', path: 'src/retry.py', side: 'head', line: 5, body: 'this retry loop needs a cap — and a test' },
            { kind: 'part', path: 'src/retry.py', body: 'the loop reads well overall' },
          ],
        },
      },
    });
    // The review's link shows, the page closes with the review that went,
    // and the pending review is empty again.
    expect(stub.informationMessages).toEqual([`Review sent: ${SENT_URL}`]);
    expect(stub.openedExternals).toEqual([SENT_URL]);
    expect(stub.webviewPanels).toHaveLength(0);
    expect(renderedTree(view)[0]).toEqual({ label: 'Must review', tooltip: 'The parts to read first.' });
    expect(stub.commentControllers[0]!.threads).toHaveLength(0);
  });

  it('drops a comment on the page instead of sending it', async () => {
    await reviewWithFakeEngine({ result: mixedResult(), logName: 'drop-on-page.log' });
    const line = stub.commentControllers[0]!.createCommentThread(head('src/retry.py'), new Range(4, 0, 4, 0), []);
    await registeredCommands().get(ADD_COMMENT_COMMAND)!({ thread: line, text: 'reconsidered' });

    await registeredCommands().get(SUBMIT_REVIEW_COMMAND)!() as Promise<void>;
    const page = sendPage();
    drive(page, { type: 'discard', id: 1 });
    drive(page, { type: 'body', body: 'Only the overall comment.' });
    drive(page, { type: 'submit' });
    await eventually('the review to be sent', () =>
      stub.informationMessages[0] !== undefined ? true : undefined,
    );

    const sent = engineRequests('drop-on-page.log').find((request) => request.method === 'sendReview');
    expect(sent?.params?.['review']).toMatchObject({
      submit: 'comment',
      body: 'Only the overall comment.',
      comments: [],
    });
    expect(stub.commentControllers[0]!.threads).not.toContain(line);
  });

  it('keeps the send as pressed: moves from the diff during it change nothing', async () => {
    const view = await reviewWithFakeEngine({
      result: mixedResult(),
      logName: 'seal-during-send.log',
      sendDelayMs: 500,
    });
    const line = stub.commentControllers[0]!.createCommentThread(head('src/retry.py'), new Range(4, 0, 4, 0), []);
    await registeredCommands().get(ADD_COMMENT_COMMAND)!({ thread: line, text: 'sent as pressed' });
    await registeredCommands().get(SUBMIT_REVIEW_COMMAND)!() as Promise<void>;
    drive(sendPage(), { type: 'submit' });
    await eventually('the write to be under way', () =>
      engineRequests('seal-during-send.log').some((request) => request.method === 'sendReview')
        ? true
        : undefined,
    );

    // The diff editor's own moves run while the one write is under way:
    // the gathered thread stays gathered, and a comment written meanwhile
    // is not taken into the review being sent.
    await registeredCommands().get(DISCARD_COMMENT_COMMAND)!(line);
    const late = stub.commentControllers[0]!.createCommentThread(head('src/retry.py'), new Range(6, 0, 6, 0), []);
    await registeredCommands().get(ADD_COMMENT_COMMAND)!({ thread: late, text: 'written too late' });

    expect(renderedTree(view).slice(0, 2)).toEqual([
      {
        label: 'Pending review',
        tooltip: 'The comments you wrote, sent to GitHub as one review on submit.',
      },
      { label: 'src/retry.py:5', description: 'sent as pressed', tooltip: 'sent as pressed', contextValue: 'comment' },
    ]);
    expect(stub.commentControllers[0]!.threads).toContain(late);
    expect(stub.warningMessages).toEqual([
      'The review is being sent: try again once it finishes.',
      'The review is being sent: try again once it finishes.',
    ]);

    await eventually('the review to be sent', () =>
      stub.informationMessages[0] !== undefined ? true : undefined,
    );
    const sent = engineRequests('seal-during-send.log').find((request) => request.method === 'sendReview');
    expect(sent?.params?.['review']).toMatchObject({
      submit: 'comment',
      comments: [
        { kind: 'line', path: 'src/retry.py', side: 'head', line: 5, body: 'sent as pressed' },
      ],
    });
    // The late comment was neither sent nor destroyed by the send that
    // emptied the gathering.
    expect(stub.commentControllers[0]!.threads).toContain(late);
    expect(stub.commentControllers[0]!.threads).not.toContain(line);
    expect(renderedTree(view)[0]).toEqual({ label: 'Must review', tooltip: 'The parts to read first.' });
  });

  it('starts a part comment from the context menu, which passes the tree element', async () => {
    const view = await reviewWithFakeEngine({ result: mixedResult(), logName: 'context-part.log' });

    // The view's context menu hands the command the tree's element — the
    // node carrying the part — rather than the part itself.
    const provider = providerOf(view);
    const node = provider
      .getChildren()
      .flatMap((section) => provider.getChildren(section))
      .find((child) => provider.getTreeItem(child).label === 'src/retry.py');
    await registeredCommands().get(COMMENT_ON_PART_COMMAND)!(node);

    const thread = stub.commentControllers[0]!.threads.at(-1)!;
    expect(thread.uri.toString()).toBe(head('src/retry.py').toString());
    expect(thread.label).toBe('src/retry.py (part)');

    await registeredCommands().get(ADD_COMMENT_COMMAND)!({ thread, text: 'written from the context menu' });
    await registeredCommands().get(SUBMIT_REVIEW_COMMAND)!() as Promise<void>;
    drive(sendPage(), { type: 'submit' });
    await eventually('the review to be sent', () =>
      stub.informationMessages[0] !== undefined ? true : undefined,
    );

    const sent = engineRequests('context-part.log').find((request) => request.method === 'sendReview');
    expect(sent?.params?.['review']).toMatchObject({
      submit: 'comment',
      comments: [{ kind: 'part', path: 'src/retry.py', body: 'written from the context menu' }],
    });
  });

  it('keeps every comment when the send fails', async () => {
    const view = await reviewWithFakeEngine({
      result: mixedResult(),
      sendError: 'GitHub is down',
      logName: 'send-fails.log',
    });

    const thread = stub.commentControllers[0]!.createCommentThread(head('src/retry.py'), new Range(4, 0, 4, 0), []);
    await registeredCommands().get(ADD_COMMENT_COMMAND)!({ thread, text: 'kept after the failure' });
    await registeredCommands().get(SUBMIT_REVIEW_COMMAND)!() as Promise<void>;
    const page = sendPage();
    drive(page, { type: 'body', body: 'tries to send' });
    drive(page, { type: 'submit' });

    await eventually('the failed send to settle', () =>
      stub.errorMessages[0] !== undefined ? true : undefined,
    );

    expect(stub.errorMessages).toEqual(['GitHub is down']);
    expect(stub.webviewPanels).toContain(page); // The page stays for another try.
    expect(renderedTree(view)[1]).toMatchObject({ label: 'src/retry.py:5' });
    expect(stub.commentControllers[0]!.threads).toContain(thread);
    // The failed send still asked for nothing but the one write attempt.
    expect(stub.progressTitles.at(-1)).toBe('Sending the review…');
  });

  it('submits each of the three kinds, one write each', async () => {
    for (const submit of ['comment', 'approve', 'request changes'] as const) {
      stub.reset();
      await reviewWithFakeEngine({ result: mixedResult(), logName: `kind-${submit}.log` });
      const thread = stub.commentControllers[0]!.createCommentThread(
        head('src/retry.py'),
        new Range(4, 0, 4, 0),
        [],
      );
      await registeredCommands().get(ADD_COMMENT_COMMAND)!({ thread, text: 'goes with the review' });
      await registeredCommands().get(SUBMIT_REVIEW_COMMAND)!() as Promise<void>;
      drive(sendPage(), { type: 'kind', submit });
      drive(sendPage(), { type: 'submit' });
      await eventually('the review to be sent', () =>
        stub.informationMessages[0] !== undefined ? true : undefined,
      );

      const sent = engineRequests(`kind-${submit}.log`).find((request) => request.method === 'sendReview');
      expect(sent?.params?.['review']).toMatchObject({
        submit,
        comments: [{ kind: 'line', path: 'src/retry.py', side: 'head', line: 5 }],
      });
      expect(stub.errorMessages).toEqual([]);
      expect(stub.informationMessages).toHaveLength(1);
    }
  });

  it('opens the page when the tree title button forwards the view context', async () => {
    await reviewWithFakeEngine({ result: mixedResult(), logName: 'title-button.log' });
    const thread = stub.commentControllers[0]!.createCommentThread(
      head('src/retry.py'),
      new Range(4, 0, 4, 0),
      [],
    );
    await registeredCommands().get(ADD_COMMENT_COMMAND)!({ thread, text: 'sent from the title button' });

    // The rocket button in the tree's title runs the command with the
    // view-pane context object as its first argument; that is no completed
    // review, so the Send review page opens, and submitting from it sends.
    await registeredCommands().get(SUBMIT_REVIEW_COMMAND)!({
      $treeViewId: 'second-look.reviewTree',
      $focusedTreeItem: true,
      $selectedTreeItems: true,
    }) as Promise<void>;
    const page = sendPage();
    drive(page, { type: 'kind', submit: 'approve' });
    drive(page, { type: 'submit' });
    await eventually('the review to be sent', () =>
      stub.informationMessages[0] !== undefined ? true : undefined,
    );

    const sent = engineRequests('title-button.log').find((request) => request.method === 'sendReview');
    expect(sent?.params?.['review']).toMatchObject({
      submit: 'approve',
      comments: [{ kind: 'line', path: 'src/retry.py', side: 'head', line: 5, body: 'sent from the title button' }],
    });
    expect(stub.errorMessages).toEqual([]);
  });

  it('sends directly when the command carries a completed review, the way the real-host test drives it', async () => {
    await reviewWithFakeEngine({ result: mixedResult(), logName: 'completed-review.log' });
    const thread = stub.commentControllers[0]!.createCommentThread(
      head('src/retry.py'),
      new Range(4, 0, 4, 0),
      [],
    );
    await registeredCommands().get(ADD_COMMENT_COMMAND)!({ thread, text: 'sent without the page' });

    // A test cannot press the page's own button, so it hands the command a
    // completed review: a genuine submit kind and a body string send at
    // once, with no page opened.
    await registeredCommands().get(SUBMIT_REVIEW_COMMAND)!('comment', '') as Promise<void>;

    const sent = engineRequests('completed-review.log').find((request) => request.method === 'sendReview');
    expect(sent?.params?.['review']).toMatchObject({
      submit: 'comment',
      comments: [{ kind: 'line', path: 'src/retry.py', side: 'head', line: 5, body: 'sent without the page' }],
    });
    expect(stub.webviewPanels).toHaveLength(0);
    expect(stub.informationMessages).toHaveLength(1);
  });

  it('sends nothing when the reviewer closes the page without submitting', async () => {
    await reviewWithFakeEngine({ result: mixedResult(), logName: 'closed-page.log' });
    const thread = stub.commentControllers[0]!.createCommentThread(
      head('src/retry.py'),
      new Range(4, 0, 4, 0),
      [],
    );
    await registeredCommands().get(ADD_COMMENT_COMMAND)!({ thread, text: 'kept for later' });

    await registeredCommands().get(SUBMIT_REVIEW_COMMAND)!() as Promise<void>;
    const page = sendPage();
    drive(page, { type: 'body', body: 'written but not sent' });
    page.dispose(); // The reviewer closes the page's tab.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(engineRequests('closed-page.log').map((request) => request.method)).toEqual(['initialize', 'review']);
    expect(stub.sessionRequests).toHaveLength(1); // Only the review's own.
    expect(stub.progressTitles).toHaveLength(1);
    expect(stub.commentControllers[0]!.threads).toContain(thread);
  });

  it('asks for a review before submitting when none ran yet', async () => {
    activate(stubContext() as unknown as vscode.ExtensionContext, {
      spawnEngine: () => {
        throw new Error('no review ran');
      },
    });

    await registeredCommands().get(SUBMIT_REVIEW_COMMAND)!() as Promise<void>;

    expect(stub.warningMessages).toEqual([
      'Review a pull request first, then write comments and submit them.',
    ]);
    expect(stub.sessionRequests).toEqual([]);
  });

  it('refuses to send a comment review with nothing in it', async () => {
    await reviewWithFakeEngine({ result: mixedResult(), logName: 'empty-send.log' });
    await registeredCommands().get(SUBMIT_REVIEW_COMMAND)!() as Promise<void>;
    drive(sendPage(), { type: 'submit' });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(stub.warningMessages).toEqual([
      'Nothing to send yet: write a comment or an overall comment, or approve.',
    ]);
    expect(engineRequests('empty-send.log').map((request) => request.method)).toEqual(['initialize', 'review']);
  });

  it('refuses an empty request-changes review; an empty approve still sends', async () => {
    await reviewWithFakeEngine({ result: mixedResult(), logName: 'empty-request-changes.log' });
    await registeredCommands().get(SUBMIT_REVIEW_COMMAND)!() as Promise<void>;
    const page = sendPage();
    drive(page, { type: 'kind', submit: 'request changes' });
    drive(page, { type: 'submit' });
    await eventually('the refusal to show', () =>
      stub.warningMessages[0] !== undefined ? true : undefined,
    );

    expect(stub.warningMessages).toEqual([
      'Nothing to send yet: write a comment or an overall comment, or approve.',
    ]);
    expect(engineRequests('empty-request-changes.log').map((request) => request.method)).toEqual(['initialize', 'review']);
    expect(stub.webviewPanels).toContain(page); // The page keeps the choice.

    drive(page, { type: 'kind', submit: 'approve' });
    drive(page, { type: 'submit' });
    await eventually('the review to be sent', () =>
      stub.informationMessages[0] !== undefined ? true : undefined,
    );

    const sent = engineRequests('empty-request-changes.log').find((request) => request.method === 'sendReview');
    expect(sent?.params?.['review']).toMatchObject({ submit: 'approve', comments: [] });
    expect(stub.warningMessages).toHaveLength(1);
  });

  it('refuses a send while one comment on the page is empty', async () => {
    await reviewWithFakeEngine({ result: mixedResult(), logName: 'blank-comment.log' });
    const thread = stub.commentControllers[0]!.createCommentThread(head('src/retry.py'), new Range(4, 0, 4, 0), []);
    await registeredCommands().get(ADD_COMMENT_COMMAND)!({ thread, text: 'blanked on the page' });
    await registeredCommands().get(SUBMIT_REVIEW_COMMAND)!() as Promise<void>;
    const page = sendPage();
    drive(page, { type: 'edit', id: 1, body: '' });
    drive(page, { type: 'body', body: 'not enough by itself for a request' });
    drive(page, { type: 'kind', submit: 'request changes' });
    drive(page, { type: 'submit' });
    await eventually('the refusal to show', () =>
      stub.warningMessages[0] !== undefined ? true : undefined,
    );

    expect(stub.warningMessages).toEqual([
      'One comment is empty: write it or drop it before sending.',
    ]);
    expect(engineRequests('blank-comment.log').map((request) => request.method)).toEqual(['initialize', 'review']);
    expect(stub.commentControllers[0]!.threads).toContain(thread);
  });

  it('keeps the comments when the reviewer is not signed in at send time', async () => {
    const view = await reviewWithFakeEngine({ result: mixedResult(), logName: 'no-sign-in-send.log' });
    stub.session = undefined;
    const thread = stub.commentControllers[0]!.createCommentThread(head('src/retry.py'), new Range(4, 0, 4, 0), []);
    await registeredCommands().get(ADD_COMMENT_COMMAND)!({ thread, text: 'waits for sign-in' });
    await registeredCommands().get(SUBMIT_REVIEW_COMMAND)!() as Promise<void>;
    drive(sendPage(), { type: 'kind', submit: 'approve' });
    drive(sendPage(), { type: 'submit' });
    await eventually('the warning to show', () =>
      stub.warningMessages[0] !== undefined ? true : undefined,
    );

    expect(stub.warningMessages).toEqual(['Sign in to GitHub to send the review.']);
    expect(renderedTree(view)[1]).toMatchObject({ label: 'src/retry.py:5' });
    expect(engineRequests('no-sign-in-send.log').map((request) => request.method)).toEqual(['initialize', 'review']);
  });

  it('closes the page when a new review starts', async () => {
    await reviewWithFakeEngine({ result: mixedResult(), logName: 'new-review-page.log' });
    const thread = stub.commentControllers[0]!.createCommentThread(head('src/retry.py'), new Range(4, 0, 4, 0), []);
    await registeredCommands().get(ADD_COMMENT_COMMAND)!({ thread, text: 'from the earlier review' });
    await registeredCommands().get(SUBMIT_REVIEW_COMMAND)!() as Promise<void>;
    expect(stub.webviewPanels).toHaveLength(1);

    // A new review's first result closes the page of the review it ended.
    stub.inputBoxResult = PR_URL;
    await registeredCommands().get(REVIEW_COMMAND)!() as Promise<void>;

    expect(stub.webviewPanels).toHaveLength(0);
    expect(stub.commentControllers[0]!.threads).not.toContain(thread);
    expect(engineRequests('new-review-page.log').map((request) => request.method)).toEqual([
      'initialize',
      'review',
      'review',
    ]);
  });

  it('discards one pending comment, base side included', async () => {
    const view = await reviewWithFakeEngine({ result: mixedResult(), logName: 'discard.log' });
    const onHead = stub.commentControllers[0]!.createCommentThread(head('src/retry.py'), new Range(4, 0, 4, 0), []);
    await registeredCommands().get(ADD_COMMENT_COMMAND)!({ thread: onHead, text: 'stays' });
    const onBase = stub.commentControllers[0]!.createCommentThread(base('src/retry.py'), new Range(3, 0, 3, 0), []);
    await registeredCommands().get(ADD_COMMENT_COMMAND)!({ thread: onBase, text: 'goes' });

    // The base-side comment targets the same file's base side.
    expect(renderedTree(view)[2]).toMatchObject({ label: 'src/retry.py:4' });

    await registeredCommands().get(DISCARD_COMMENT_COMMAND)!(onBase);

    expect(renderedTree(view).slice(0, 2)).toEqual([
      { label: 'Pending review', tooltip: 'The comments you wrote, sent to GitHub as one review on submit.' },
      { label: 'src/retry.py:5', description: 'stays', tooltip: 'stays', contextValue: 'comment' },
    ]);
    expect(stub.commentControllers[0]!.threads).not.toContain(onBase);
  });
});
