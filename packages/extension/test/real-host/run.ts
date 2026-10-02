import { deepStrictEqual, ok } from 'node:assert';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import * as vscode from 'vscode';
import { activate, REVIEW_COMMAND } from 'second-look-extension';
import { mixedResult } from '../results.js';

/**
 * The extension's real-host test: the same review run the stub-based
 * integration test drives, but inside a real VS Code, through the real
 * API — the real command registry, the real authentication API, real
 * tree items — and still against the fake engine fixture, a plain Node
 * child process, so nothing touches the network. Only CI runs it.
 */

const EXTENSION_ID = 'lbildzinkas.second-look-extension';
const PR_URL = 'https://github.com/example-org/example-repo/pull/42';
const TOKEN = 'ghp_real-host-test-token-do-not-print';
const TIMEOUT_MS = 120_000;

// Resolved through the workspace link, so it holds wherever this module
// runs from.
const require = createRequire(import.meta.url);
const EXTENSION_ROOT = dirname(require.resolve('second-look-extension/package.json'));
const FAKE_ENGINE = join(EXTENSION_ROOT, 'test', 'fixtures', 'fake-engine.mjs');

/** A tree node as the view renders it. */
interface Rendered {
  label: string;
  description?: string;
  tooltip?: string;
  contextValue?: string;
}

interface EngineRequest {
  method: string;
  params?: { url?: string; token?: string };
}

function withTimeout<T>(work: PromiseLike<T>, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    work,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`timed out waiting for ${what}`)), TIMEOUT_MS);
    }),
  ]).finally(() => clearTimeout(timer));
}

function labelOf(item: vscode.TreeItem): string {
  const label = item.label;
  return typeof label === 'string' ? label : label?.label ?? '';
}

async function renderedItem<T>(
  provider: vscode.TreeDataProvider<T>,
  node: T,
): Promise<Rendered> {
  const item = await provider.getTreeItem(node);
  const rendered: Rendered = { label: labelOf(item) };
  if (typeof item.description === 'string') rendered.description = item.description;
  if (typeof item.tooltip === 'string') rendered.tooltip = item.tooltip;
  if (item.contextValue !== undefined) rendered.contextValue = item.contextValue;
  return rendered;
}

/** The tree's nodes, in the order the view renders them. */
async function renderedTree<T>(provider: vscode.TreeDataProvider<T>): Promise<Rendered[]> {
  const rendered: Rendered[] = [];
  for (const node of (await provider.getChildren()) ?? []) {
    rendered.push(await renderedItem(provider, node));
    for (const child of (await provider.getChildren(node)) ?? []) {
      rendered.push(await renderedItem(provider, child));
    }
  }
  return rendered;
}

/** Starts the fake engine as its own process, logging what reaches it. */
function fakeEngine(logPath: string): ChildProcessWithoutNullStreams {
  return spawn(process.execPath, [FAKE_ENGINE], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      FAKE_ENGINE_RESULT: JSON.stringify(mixedResult()),
      FAKE_ENGINE_LOG: logPath,
    },
  });
}

const EXPECTED_TREE: Rendered[] = [
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
];

export async function run(): Promise<void> {
  const workDir = mkdtempSync(join(tmpdir(), 'second-look-real-host-'));
  const sessionsRequested: (readonly string[] | undefined)[] = [];
  const sessionChanges =
    new vscode.EventEmitter<vscode.AuthenticationProviderAuthenticationSessionsChangeEvent>();
  const session: vscode.AuthenticationSession = {
    id: 'second-look-real-host-session',
    accessToken: TOKEN,
    account: { id: 'second-look-real-host', label: 'Second Look real-host test' },
    scopes: ['repo'],
  };
  const auth = vscode.authentication.registerAuthenticationProvider('github', 'GitHub', {
    onDidChangeSessions: sessionChanges.event,
    getSessions(scopes) {
      sessionsRequested.push(scopes === undefined ? undefined : [...scopes]);
      return Promise.resolve(scopes?.includes('repo') === true ? [session] : []);
    },
    createSession(scopes) {
      return Promise.resolve({ ...session, scopes: [...scopes] });
    },
    removeSession() {
      return Promise.resolve();
    },
  });

  try {
    // The editor activates the extension on its own terms first, so the
    // activation below is the one whose review the command runs: same
    // module, real API, with the engine swapped for the fake engine.
    const extension = vscode.extensions.getExtension(EXTENSION_ID);
    ok(extension, `the ${EXTENSION_ID} extension is not installed in the development host`);
    if (!extension.isActive) {
      await withTimeout(extension.activate(), `activation of ${EXTENSION_ID}`);
    }

    const subscriptions: { dispose(): unknown }[] = [];
    const provider = activate({ subscriptions } as vscode.ExtensionContext, {
      spawnEngine: () => fakeEngine(join(workDir, 'engine.log')),
    });

    deepStrictEqual(await renderedTree(provider), [
      {
        label: 'Review a pull request to see its parts here, ranked by importance.',
        contextValue: 'part',
      },
    ]);

    await withTimeout(
      vscode.commands.executeCommand(REVIEW_COMMAND, PR_URL),
      'the review command',
    );

    deepStrictEqual(await renderedTree(provider), EXPECTED_TREE);

    ok(
      sessionsRequested.some((scopes) => scopes?.includes('repo') === true),
      'the GitHub session came through the real authentication API',
    );
    const requests = readFileSync(join(workDir, 'engine.log'), 'utf8')
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => JSON.parse(line) as EngineRequest);
    deepStrictEqual(requests.length, 2);
    ok(requests[0] && requests[0].method === 'initialize');
    ok(requests[1] && requests[1].method === 'review');
    deepStrictEqual(requests[1]?.params, { url: PR_URL, token: TOKEN });
  } finally {
    auth.dispose();
    sessionChanges.dispose();
    rmSync(workDir, { recursive: true, force: true });
  }
}
