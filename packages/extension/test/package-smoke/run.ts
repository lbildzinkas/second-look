import { deepStrictEqual, ok } from 'node:assert';
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import * as vscode from 'vscode';
import { ENGINE_PROTOCOL_VERSION, INITIALIZE_METHOD, LANGUAGES } from '@second-look/engine';
import { REVIEW_COMMAND } from 'second-look-extension';
import { mixedResult } from '../results.js';

/**
 * The package smoke test: the packaged extension, installed from its
 * .vsix file into a clean, downloaded editor, must activate and run one
 * review end to end — and the engine and WASM grammars the package
 * carries must be there and the bundled engine must answer the protocol
 * handshake. The review itself runs against the fake engine fixture, so
 * nothing touches the network; the bundled engine is proven by its own
 * handshake. Only CI runs this, on macOS, Linux and Windows.
 */

const EXTENSION_ID = 'lbildzinkas.second-look-extension';
const PR_URL = 'https://github.com/example-org/example-repo/pull/42';
const TOKEN = 'ghp_package-smoke-token-do-not-print';
const TIMEOUT_MS = 120_000;

// Resolved through the workspace link, so it holds wherever this module
// runs from.
const require = createRequire(import.meta.url);
const EXTENSION_ROOT = dirname(require.resolve('second-look-extension/package.json'));
const FAKE_ENGINE = join(EXTENSION_ROOT, 'test', 'fixtures', 'fake-engine.mjs');

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

/** The tree's row labels, in the order the view renders them. */
async function renderedLabels(provider: vscode.TreeDataProvider<unknown>): Promise<string[]> {
  const labels: string[] = [];
  for (const node of (await provider.getChildren()) ?? []) {
    labels.push(labelOf(await provider.getTreeItem(node)));
    for (const child of (await provider.getChildren(node)) ?? []) {
      labels.push(labelOf(await provider.getTreeItem(child)));
    }
  }
  return labels;
}

/** One line the JSON-RPC engine sent back, as the client reads it. */
interface EngineAnswer {
  result?: { protocolVersion?: unknown };
}

/** Starts the engine the package carries and returns its first answer. */
async function packagedEngineHandshake(
  engineDist: string,
): Promise<EngineAnswer> {
  // The companion's own spawn starts the editor's binary as Node; the
  // same flag makes the packaged engine run here.
  const engine: ChildProcessWithoutNullStreams = spawn(
    process.execPath,
    [join(engineDist, 'main.js'), 'serve'],
    { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['pipe', 'pipe', 'pipe'] },
  );
  try {
    const lines = createInterface({ input: engine.stdout });
    const firstLine = new Promise<string>((resolve) => lines.once('line', resolve));
    engine.stdin.write(
      `${JSON.stringify({
        jsonrpc: '2.0' as const,
        id: 1,
        method: INITIALIZE_METHOD,
        params: { protocolVersion: ENGINE_PROTOCOL_VERSION },
      })}\n`,
    );
    return JSON.parse(await withTimeout(firstLine, 'the packaged engine handshake')) as EngineAnswer;
  } finally {
    engine.kill();
  }
}

/**
 * Runs the packaged Claude Code guard the way the engine has Claude Code
 * run it inside the editor — the editor's binary as Node — on a read
 * outside an empty copy, and returns its permission decision.
 */
function packagedClaudeGuardDecision(guard: string, workDir: string): unknown {
  const copy = join(workDir, 'guard-copy');
  mkdirSync(copy, { recursive: true });
  const hook = spawnSync(process.execPath, [guard], {
    input: JSON.stringify({
      hook_event_name: 'PreToolUse',
      tool_name: 'Read',
      tool_input: { file_path: join(workDir, 'outside.txt') },
      tool_use_id: 'package-smoke',
    }),
    encoding: 'utf8',
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', SECOND_LOOK_READ_ROOT: copy },
    timeout: TIMEOUT_MS,
  });
  try {
    return (JSON.parse(hook.stdout) as { hookSpecificOutput?: { permissionDecision?: unknown } }).hookSpecificOutput
      ?.permissionDecision;
  } catch {
    return `no decision (exit ${hook.status}): ${hook.stderr}`;
  }
}

export async function run(): Promise<void> {
  const workDir = mkdtempSync(join(tmpdir(), 'second-look-package-smoke-'));
  const sessionChanges =
    new vscode.EventEmitter<vscode.AuthenticationProviderAuthenticationSessionsChangeEvent>();
  const session: vscode.AuthenticationSession = {
    id: 'second-look-package-smoke-session',
    accessToken: TOKEN,
    account: { id: 'second-look-package-smoke', label: 'Second Look package smoke test' },
    scopes: ['repo'],
  };
  const auth = vscode.authentication.registerAuthenticationProvider('github', 'GitHub', {
    onDidChangeSessions: sessionChanges.event,
    getSessions(scopes) {
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
    // The installed package is the code under test: the launch loaded
    // the folder the install created as the development extension the
    // editor's test runner requires, so what runs here is the packaged
    // code, not the repository's source tree.
    const extension = vscode.extensions.getExtension(EXTENSION_ID);
    ok(extension, `the ${EXTENSION_ID} extension is not installed from the package`);
    await withTimeout(extension.activate(), `activation of ${EXTENSION_ID}`);

    // The package carries what its code resolves at run time: the bundled
    // engine with both guards beside it, and every grammar the engine's
    // language list names.
    const installed = extension.extensionUri.fsPath;
    const engineDist = join(installed, 'node_modules', '@second-look', 'engine', 'dist');
    ok(existsSync(join(engineDist, 'main.js')), 'the package carries the bundled engine');
    ok(existsSync(join(engineDist, 'pi-guard.js')), "the package carries Pi's guard beside the engine");
    ok(existsSync(join(engineDist, 'claude-guard.js')), "the package carries Claude Code's guard beside the engine");
    deepStrictEqual(
      packagedClaudeGuardDecision(join(engineDist, 'claude-guard.js'), workDir),
      'deny',
      "the packaged Claude Code guard, run by the editor's binary as Node, refuses a read outside the copy",
    );
    // The Activity Bar icon the manifest's view container names.
    const containers = (extension.packageJSON as {
      contributes: { viewsContainers: { activitybar: { id: string; icon: string }[] } };
    }).contributes.viewsContainers.activitybar;
    deepStrictEqual(containers.map((container) => container.id), ['second-look']);
    for (const container of containers) {
      ok(existsSync(join(installed, container.icon)), `the package carries the ${container.icon} icon`);
    }
    for (const language of LANGUAGES) {
      ok(
        existsSync(
          join(installed, 'node_modules', '@vscode', 'tree-sitter-wasm', 'wasm', language.grammar),
        ),
        `the package carries the ${language.name} grammar`,
      );
    }

    // The bundled engine speaks the protocol: the same handshake the
    // companion performs before its first review.
    const answer = await packagedEngineHandshake(engineDist);
    deepStrictEqual(answer.result, { protocolVersion: ENGINE_PROTOCOL_VERSION });

    // The activation exported the review tree's data provider, the tree
    // the command fills.
    const provider = extension.exports as vscode.TreeDataProvider<unknown> | undefined;
    ok(
      provider !== undefined &&
        typeof provider.getChildren === 'function' &&
        typeof provider.getTreeItem === 'function',
      `the ${EXTENSION_ID} activation did not export the review tree's data provider`,
    );
    // Before the first review the tree is empty, so the view shows its
    // welcome button.
    deepStrictEqual(await renderedLabels(provider), []);

    // One full review round trip, against the fake engine fixture so no
    // network is touched: the command asks for the GitHub session, sends
    // the handshake and the review to the engine it spawned, and fills
    // the tree with the ranked parts it got back.
    const baseDir = join(workDir, 'base');
    const headDir = join(workDir, 'head');
    mkdirSync(baseDir, { recursive: true });
    mkdirSync(headDir, { recursive: true });
    const review = mixedResult({ base: baseDir, head: headDir });
    process.env['SECOND_LOOK_ENGINE_ENTRY'] = FAKE_ENGINE;
    process.env['FAKE_ENGINE_RESULT'] = JSON.stringify(review);
    process.env['FAKE_ENGINE_LOG'] = join(workDir, 'engine.log');

    await withTimeout(
      vscode.commands.executeCommand(REVIEW_COMMAND, PR_URL),
      'the review command',
    );

    deepStrictEqual(await renderedLabels(provider), [
      'Must review',
      'src/retry.py',
      'Worth reviewing',
      'src/settings.ts',
      'Context',
      'CHANGELOG.md',
      'Not ranked yet',
      'src/legacy.ts',
      '__tests__/retry.test.ts.snap',
      'Noise',
      'uv.lock',
      'transport.py',
    ]);

    const requests = readFileSync(join(workDir, 'engine.log'), 'utf8')
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => JSON.parse(line) as {
        method: string;
        params?: {
          url?: string;
          token?: string;
          agent?: { agent?: string; model?: string; effort?: string; account?: string };
          criteriaHeading?: string;
        };
      });
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
  } finally {
    delete process.env['SECOND_LOOK_ENGINE_ENTRY'];
    delete process.env['FAKE_ENGINE_RESULT'];
    delete process.env['FAKE_ENGINE_LOG'];
    auth.dispose();
    sessionChanges.dispose();
    rmSync(workDir, { recursive: true, force: true });
  }
}
