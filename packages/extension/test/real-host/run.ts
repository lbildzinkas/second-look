import { deepStrictEqual, ok } from 'node:assert';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import * as vscode from 'vscode';
import {
  ADD_COMMENT_COMMAND,
  CHANGE_SCHEME,
  OPEN_ALL_PARTS_COMMAND,
  OPEN_PART_COMMAND,
  REVIEW_COMMAND,
  SUBMIT_REVIEW_COMMAND,
} from 'second-look-extension';
import { mixedResult } from '../results.js';

/**
 * The extension's real-host test: the same review run the stub-based
 * integration test drives, but inside a real VS Code, through the real
 * API — the real activation, the real command registry, the real
 * authentication API, real tree items — and still against the fake
 * engine fixture, a plain Node child process, so nothing touches the
 * network. Only CI runs it.
 *
 * The editor activates the extension exactly once, on its own terms, and
 * the registry rejects registering the review command a second time, so
 * this test rides that one activation: it reads the tree through the data
 * provider the activation exported and substitutes the fake engine for
 * the real one through the environment, which the extension host already
 * passes to the engine child process it spawns.
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
  params?: {
    url?: string;
    token?: string;
    agent?: { agent?: string; model?: string; effort?: string; account?: string };
    criteriaHeading?: string;
  };
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

/** Polls until a probe finds what it waits for, or the test times out. */
async function waitFor<T>(what: string, probe: () => T | undefined): Promise<T> {
  const deadline = Date.now() + TIMEOUT_MS;
  for (;;) {
    const found = probe();
    if (found !== undefined) return found;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/** Writes one file of a copy, creating its folders. */
function plantCopyFile(copyDir: string, path: string, content: string): void {
  const absolute = join(copyDir, path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, content);
}

/** The pull request's base copy, as the engine's cache would hold it. */
const BASE_FILES: Record<string, string> = {
  'src/retry.py': [
    '# sending the webhook payload',
    'def send(payload):',
    '    url = settings.endpoint',
    '    response = post(url, payload)',
    '    if response.status >= 500:',
    '        raise SendError(response)',
    '    return response',
    '',
  ].join('\n'),
  'src/settings.ts': 'export const attempts = 3;\n',
  'CHANGELOG.md': '# Changelog\n',
  'src/legacy.ts': 'export function legacy(): void {}\n',
  '__tests__/retry.test.ts.snap': 'snapshot of the retry output\n',
  'uv.lock': 'lockfile-content\n',
  'transport.py': 'def deliver(payload):\n    pass\n',
};

/** The head copy: the retry part grew, everything else is the base. */
const HEAD_FILES: Record<string, string> = {
  ...BASE_FILES,
  'src/retry.py': [
    '# sending the webhook payload',
    'def send(payload):',
    '    url = settings.endpoint',
    '    for attempt in retry.attempts():',
    '        try:',
    '            response = post(url, payload)',
    '        except TransientError:',
    '            continue',
    '        if response.status >= 500:',
    '            raise SendError(response)',
    '        return response',
    '    raise SendError("no attempt succeeded")',
    '',
    'def sign(payload):',
    '    return hmac(payload, settings.secret)',
    '',
  ].join('\n'),
};

const EXPECTED_TREE: Rendered[] = [
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
    // The copies the engine's cache would hold, planted as real files so
    // the diff editor reads real content through the companion's
    // read-only file system.
    const baseDir = join(workDir, 'base');
    const headDir = join(workDir, 'head');
    for (const [path, content] of Object.entries(BASE_FILES)) {
      plantCopyFile(baseDir, path, content);
    }
    for (const [path, content] of Object.entries(HEAD_FILES)) {
      plantCopyFile(headDir, path, content);
    }

    // The fake engine takes the real engine's place: the companion's own
    // spawn starts whatever SECOND_LOOK_ENGINE_ENTRY names, and the
    // fixture reads its result and its log path from this environment.
    const review = mixedResult({ base: baseDir, head: headDir });
    process.env['SECOND_LOOK_ENGINE_ENTRY'] = FAKE_ENGINE;
    process.env['FAKE_ENGINE_RESULT'] = JSON.stringify(review);
    process.env['FAKE_ENGINE_LOG'] = join(workDir, 'engine.log');

    // One activation, the editor's own: already happened or forced here,
    // either way the review command is registered exactly once.
    const extension = vscode.extensions.getExtension(EXTENSION_ID);
    ok(extension, `the ${EXTENSION_ID} extension is not installed in the development host`);
    await withTimeout(extension.activate(), `activation of ${EXTENSION_ID}`);

    // The activation exported the review tree's data provider, the tree
    // the command fills.
    const provider = extension.exports as vscode.TreeDataProvider<unknown> | undefined;
    ok(
      provider !== undefined &&
        typeof provider.getChildren === 'function' &&
        typeof provider.getTreeItem === 'function',
      `the ${EXTENSION_ID} activation did not export the review tree's data provider`,
    );

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
    deepStrictEqual(requests.length, 3);
    ok(requests[0] && requests[0].method === 'initialize');
    ok(requests[1] && requests[1].method === 'review');
    // The request carries the agent choice and the criteria heading the
    // settings read — their defaults in this clean editor — beside the URL
    // and the token, so the engine runs every agent pass with it and reads
    // the criteria checklist under the configured heading.
    deepStrictEqual(requests[1]?.params, {
      url: PR_URL,
      token: TOKEN,
      agent: { agent: 'pi', model: '', effort: '', account: '' },
      criteriaHeading: 'Acceptance criteria',
    });
    // The review's marks are read from the engine's local store as soon
    // as the review is under way, so the tree can show what the reviewer
    // had already marked — the round trip's third and last request, and
    // nothing else reaches the engine.
    ok(requests[2] && requests[2].method === 'reviewedMarks');
    deepStrictEqual(requests[2]?.params, { url: PR_URL });

    // Reading a part: clicking it opens the multi-file diff with exactly
    // its files, read-only from the cached copies, scrolled to the part's
    // first hunk.
    const sections = (await provider.getChildren()) as unknown as {
      parts?: { label: string; part?: { path: string } }[];
    }[];
    const retry = sections
      .flatMap((section) => section.parts ?? [])
      .find((row) => row.label === 'src/retry.py')?.part;
    ok(retry, 'the tree row for src/retry.py carries its part');

    await withTimeout(
      vscode.commands.executeCommand(OPEN_PART_COMMAND, retry),
      'the open-part command',
    );

    const retryHead = await withTimeout(
      waitFor(
        'the diff editor for src/retry.py',
        () =>
          vscode.window.visibleTextEditors.find(
            (editor) =>
              editor.document.uri.scheme === CHANGE_SCHEME &&
              editor.document.uri.authority === 'head' &&
              editor.document.uri.path.endsWith('/src/retry.py'),
          ),
      ),
      'the diff editor for src/retry.py',
    );

    // The editor scrolled to the part's first hunk, which starts at the
    // third line of the head side.
    await withTimeout(
      waitFor('the diff scrolled to the first hunk', () => {
        const visible = retryHead.visibleRanges[0];
        return visible !== undefined &&
          visible.start.line <= 2 &&
          2 <= visible.end.line
          ? true
          : undefined;
      }),
      'the diff scrolled to the first hunk',
    );

    // The copies serve the pull request's content, read-only: the head
    // side holds the new retry logic, the base side the old one, and a
    // write is refused.
    const changeFile = (side: 'base' | 'head', path: string) =>
      vscode.Uri.from({
        scheme: CHANGE_SCHEME,
        authority: side,
        path: `/${review.copies[side].commit}/${path}`,
      });
    const headContent = await vscode.workspace.fs.readFile(changeFile('head', 'src/retry.py'));
    const baseContent = await vscode.workspace.fs.readFile(changeFile('base', 'src/retry.py'));
    deepStrictEqual(new TextDecoder().decode(headContent), HEAD_FILES['src/retry.py']!);
    deepStrictEqual(new TextDecoder().decode(baseContent), BASE_FILES['src/retry.py']!);
    await vscode.workspace.fs
      .writeFile(retryHead.document.uri, new TextEncoder().encode('edited'))
      .then(
        () => {
          throw new Error('writing a cached copy was not refused');
        },
        () => undefined,
      );

    // The whole change opens in one multi-file diff, in the tree's order.
    // The host names a multi-file diff editor's tab after its title plus the
    // number of files it holds, so the label settling on every part's count
    // is the whole change reading as one diff.
    const wholeChangeTab = `Retry failed webhook sends (#42) (${review.parts.length} files)`;
    await withTimeout(
      vscode.commands.executeCommand(OPEN_ALL_PARTS_COMMAND),
      'the open-all-parts command',
    );
    await withTimeout(
      waitFor('the whole-change diff editor tab', () =>
        vscode.window.tabGroups.all
          .flatMap((group) => group.tabs)
          .some((tab) => tab.label === wholeChangeTab)
          ? true
          : undefined,
      ),
      'the whole-change diff editor tab',
    );

    // Writing a comment: the thread the editor would raise on a line of
    // the diff, with the text submitted into it, becomes one pending
    // comment.
    const thread = {
      uri: retryHead.document.uri,
      range: new vscode.Range(4, 0, 4, 0),
      comments: [],
      canReply: true,
      collapsibleState: vscode.CommentThreadCollapsibleState.Expanded,
      dispose: (): void => undefined,
    } as unknown as vscode.CommentThread;
    await withTimeout(
      vscode.commands.executeCommand(ADD_COMMENT_COMMAND, {
        thread,
        text: 'this retry loop needs a cap',
      }),
      'the add-comment command',
    );
    ok(thread.comments.length === 1, 'the comment shows in its thread');
    const withPending = await renderedTree(provider);
    deepStrictEqual(withPending[0], {
      label: 'Pending review',
      tooltip: 'The comments you wrote, sent to GitHub as one review on submit.',
    });
    deepStrictEqual(withPending[1], {
      label: 'src/retry.py:5',
      description: 'this retry loop needs a cap',
      tooltip: 'this retry loop needs a cap',
      contextValue: 'comment',
    });

    // The Send review page opens in the editor: the submit command
    // carries no completed review, so the page is how this review would
    // be sent, and nothing is sent by opening it.
    await withTimeout(
      vscode.commands.executeCommand(SUBMIT_REVIEW_COMMAND),
      'the submit-review command',
    );
    await withTimeout(
      waitFor('the send-review page tab', () =>
        vscode.window.tabGroups.all
          .flatMap((group) => group.tabs)
          .some((tab) => tab.label === 'Send review')
          ? true
          : undefined,
      ),
      'the send-review page tab',
    );

    // Sending: a test cannot press the page's own button, so the command
    // is handed the completed review — the submit kind and the overall
    // comment — and sends it at once. The engine receives one send with
    // the gathered comment, and the pending review empties again.
    await withTimeout(
      vscode.commands.executeCommand(SUBMIT_REVIEW_COMMAND, 'comment', 'Sent by the real-host test.'),
      'the submit-review command',
    );
    const sent = await waitFor('the send request in the engine log', () => {
      const logged = readFileSync(join(workDir, 'engine.log'), 'utf8')
        .split('\n')
        .filter((line) => line !== '')
        .map((line) => JSON.parse(line) as EngineRequest);
      return logged.find((request) => request.method === 'sendReview');
    });
    // The log holds the whole JSON-RPC envelope, id and all, so what the
    // send pins is the params the engine received.
    deepStrictEqual(sent.params, {
      url: PR_URL,
      token: TOKEN,
      review: {
        submit: 'comment',
        body: 'Sent by the real-host test.',
        comments: [
          {
            kind: 'line',
            path: 'src/retry.py',
            side: 'head',
            line: 5,
            body: 'this retry loop needs a cap',
          },
        ],
      },
    });
    deepStrictEqual(await renderedTree(provider), EXPECTED_TREE);
  } finally {
    delete process.env['SECOND_LOOK_ENGINE_ENTRY'];
    delete process.env['FAKE_ENGINE_RESULT'];
    delete process.env['FAKE_ENGINE_LOG'];
    auth.dispose();
    sessionChanges.dispose();
    rmSync(workDir, { recursive: true, force: true });
  }
}
