import {
  downloadAndUnzipVSCode,
  runVSCodeCommand,
} from '@vscode/test-electron';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { trustCompanion } from '../real-host/launch.js';

/**
 * Launches a clean, downloaded VS Code with nothing but the packaged
 * extension, installed from its .vsix file, and runs the package smoke
 * test inside it. CI calls this on macOS, Linux and Windows after a
 * build job has packaged the extension and this job has downloaded the
 * artifact; no local check runs it, because it opens a real editor
 * window.
 *
 * The launch goes through `runVSCodeCommand` rather than `runTests`,
 * because `runTests` always loads a development extension — and the
 * development copy would take the installed package's place, defeating
 * the test. The flags below are `runTests`' own launch recipe minus the
 * development path.
 */

/**
 * Finds the package to install: the one a CI run downloaded next to the
 * repository, else the newest one `npm run package` wrote into the
 * extension's dist folder.
 */
export function findPackage(repoRoot: string, extensionRoot: string): string {
  for (const folder of [join(repoRoot, 'package'), join(extensionRoot, 'dist')]) {
    if (!existsSync(folder)) {
      continue;
    }
    const found = readdirSync(folder)
      .filter((file) => file.endsWith('.vsix'))
      .sort();
    if (found.length > 0) {
      return join(folder, found[found.length - 1]!);
    }
  }
  throw new Error(
    `no .vsix package found; run npm run package first`,
  );
}

/** The launch flags `runTests` uses, minus the development path it requires. */
const TEST_LAUNCH_FLAGS: readonly string[] = [
  // https://github.com/microsoft/vscode/issues/84238
  '--no-sandbox',
  // https://github.com/microsoft/vscode-test/issues/221
  '--disable-gpu-sandbox',
  // https://github.com/microsoft/vscode-test/issues/120
  '--disable-updates',
  '--skip-welcome',
  '--skip-release-notes',
  '--no-cached-data',
  '--disable-workspace-trust',
];

/**
 * How long any one launcher step may run. Downloading the editor,
 * installing the package and the test round trip each take a couple of
 * minutes at most on a CI runner; anything longer is a stall, and the
 * bound turns it into a failing check with an error naming the stalled
 * step, instead of a job that hangs until it is cancelled.
 */
const STEP_TIMEOUT_MS = 300_000;

/**
 * Bounds one launcher step: if `step` does not settle within
 * `timeoutMs`, this rejects with an error naming the step, and the
 * signal the step was handed aborts — killing whatever the step
 * spawned, so a stalled editor cannot keep the launcher alive either.
 */
export async function withStepTimeout<T>(
  what: string,
  step: (spawnSignal: AbortSignal) => PromiseLike<T>,
  timeoutMs: number = STEP_TIMEOUT_MS,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const stalled = new Promise<never>((_, reject) => {
    controller.signal.addEventListener('abort', () => {
      reject(new Error(`${what} did not finish within ${timeoutMs} ms`));
    });
  });
  try {
    return await Promise.race([step(controller.signal), stalled]);
  } finally {
    clearTimeout(timer);
  }
}

async function main(): Promise<void> {
  try {
    // Resolved through the workspace link, so it holds wherever this
    // script runs from.
    const require = createRequire(import.meta.url);
    const extensionRoot = dirname(require.resolve('second-look-extension/package.json'));
    const manifest = JSON.parse(readFileSync(join(extensionRoot, 'package.json'), 'utf8')) as {
      name: string;
      publisher: string;
    };
    const repoRoot = join(extensionRoot, '..', '..');
    const vsixPath = findPackage(repoRoot, extensionRoot);

    // The same download runTests would make, patched before the launch:
    // later commands reuse the copy already in the cache. The install
    // and the test launch then share the cache's extensions folder, so
    // the editor the test runs in is the one the package was installed
    // into. Every step below is bounded, so a stalled one fails this
    // launcher naming itself instead of hanging the check.
    const vscodeExecutablePath = await withStepTimeout(
      'downloading VS Code',
      () => downloadAndUnzipVSCode(),
    );
    trustCompanion(vscodeExecutablePath, `${manifest.publisher}.${manifest.name}`);
    await withStepTimeout('installing the extension package into VS Code', (signal) =>
      runVSCodeCommand(['--install-extension', vsixPath], { spawn: { signal } }),
    );
    const exitCode = await withStepTimeout(
      'running the package smoke test in VS Code',
      (signal) =>
        runVSCodeCommand(
          [
            ...TEST_LAUNCH_FLAGS,
            `--extensionTestsPath=${fileURLToPath(new URL('./run.js', import.meta.url))}`,
            // The built-in GitHub sign-in must not offer itself: the test
            // serves the session through its own authentication provider.
            '--disable-extension=vscode.github-authentication',
          ],
          { spawn: { signal } },
        ).then(
          () => 0,
          (error: { stdout?: string; stderr?: string; exitCode?: number }) => {
            // A test failure reads as the editor exiting nonzero; the
            // captured streams carry the test's own output.
            console.error(error.stdout ?? '', error.stderr ?? '');
            return error.exitCode ?? 1;
          },
        ),
    );
    process.exitCode = exitCode;
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}

// Runs the launch only when executed as a script, so the helpers stay
// importable without downloading or launching anything.
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  void main();
}
