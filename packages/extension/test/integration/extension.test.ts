import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type * as vscode from 'vscode';
import { REVIEW_COMMAND, REVIEW_TREE_VIEW, activate } from '../../src/extension.js';
import { mixedResult } from '../results.js';
import { stub, stubContext, type StubTreeView } from '../vscode-stub.js';

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
      FAKE_ENGINE_LOG: join(workDir, options.logName),
    },
  });
}

/** Activates the extension against a fake engine and returns its tree view. */
async function reviewWithFakeEngine(options: FakeEngineOptions): Promise<StubTreeView> {
  activate(stubContext() as unknown as vscode.ExtensionContext, {
    spawnEngine: () => fakeEngine(options),
  });
  expect(stub.commands).toHaveLength(1);
  expect(stub.commands[0]!.id).toBe(REVIEW_COMMAND);

  stub.inputBoxResult = PR_URL;
  stub.session = { accessToken: TOKEN };
  await stub.commands[0]!.handler() as Promise<void>;

  expect(stub.treeViews).toHaveLength(1);
  return stub.treeViews[0]!;
}

/** The tree's nodes, as the view renders them. */
function renderedTree(view: StubTreeView): { label: string; description?: string; tooltip?: string; contextValue?: string }[] {
  const provider = view.provider as {
    getChildren(node?: unknown): unknown[];
    getTreeItem(node: unknown): { label?: string; description?: string; tooltip?: string; contextValue?: string };
  };
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

beforeEach(() => {
  stub.reset();
});

describe('activating the companion', () => {
  it('registers the review command and the review tree', () => {
    activate(stubContext() as unknown as vscode.ExtensionContext, {
      spawnEngine: () => {
        throw new Error('no review ran');
      },
    });

    expect(stub.commands.map((command) => command.id)).toEqual([REVIEW_COMMAND]);
    expect(stub.treeViews.map((view) => view.id)).toEqual([REVIEW_TREE_VIEW]);
  });

  it('shows the placeholder before any review ran', () => {
    activate(stubContext() as unknown as vscode.ExtensionContext, {
      spawnEngine: () => {
        throw new Error('no review ran');
      },
    });

    expect(renderedTree(stub.treeViews[0]!)).toEqual([
      {
        label: 'Review a pull request to see its parts here, ranked by importance.',
        contextValue: 'part',
      },
    ]);
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

    await stub.commands[0]!.handler() as Promise<void>;

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

    await stub.commands[0]!.handler() as Promise<void>;

    expect(stub.warningMessages).toEqual(['Sign in to GitHub to review a pull request.']);
    expect(stub.progressTitles).toEqual([]);
  });

  it('shows the plain sign-in message when the reviewer cancels the GitHub sign-in', async () => {
    activate(stubContext() as unknown as vscode.ExtensionContext, {
      spawnEngine: () => fakeEngine({ result: mixedResult(), logName: 'cancelled-sign-in.log' }),
    });
    stub.inputBoxResult = PR_URL;
    stub.cancelSignIn = true;

    await stub.commands[0]!.handler() as Promise<void>;

    expect(stub.warningMessages).toEqual(['Sign in to GitHub to review a pull request.']);
    expect(stub.progressTitles).toEqual([]);
  });
});
