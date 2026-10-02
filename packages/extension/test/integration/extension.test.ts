import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type * as vscode from 'vscode';
import {
  OPEN_ALL_PARTS_COMMAND,
  OPEN_PART_COMMAND,
  REVIEW_COMMAND,
  REVIEW_TREE_VIEW,
  activate,
} from '../../src/extension.js';
import { changeUri } from '../../src/change-copies.js';
import { mixedResult } from '../results.js';
import { stub, stubContext, workspace, type StubTreeView } from '../vscode-stub.js';

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
  logName: string;
  /** A stage notification to send before the answer, which then waits this long. */
  stage?: { running: string; timeoutMs: number; result: unknown };
  answerDelayMs?: number;
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
    ]);
    expect(stub.treeViews.map((view) => view.id)).toEqual([REVIEW_TREE_VIEW]);
    expect(stub.fileSystemProviders.map((entry) => entry.scheme)).toEqual(['second-look-change']);
    expect(stub.fileSystemProviders[0]!.options?.isReadonly).toBeInstanceOf(Object);
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
        tooltip: 'new code\n2 callers\nno tests before this pull request',
        contextValue: 'part',
      },
      { label: 'Worth reviewing', tooltip: 'The parts worth a careful read.' },
      {
        label: 'src/settings.ts',
        description: 'Changed code that the retry policy reads.',
        tooltip: 'changed code',
        contextValue: 'part',
      },
      { label: 'Context', tooltip: 'The parts that only give background to the change.' },
      {
        label: 'CHANGELOG.md',
        description: 'Release note only.',
        tooltip: 'documentation only',
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
