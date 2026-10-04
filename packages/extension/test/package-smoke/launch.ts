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
    // into.
    const vscodeExecutablePath = await downloadAndUnzipVSCode();
    trustCompanion(vscodeExecutablePath, `${manifest.publisher}.${manifest.name}`);
    await runVSCodeCommand(['--install-extension', vsixPath]);
    const exitCode = await runVSCodeCommand([
      ...TEST_LAUNCH_FLAGS,
      `--extensionTestsPath=${fileURLToPath(new URL('./run.js', import.meta.url))}`,
      // The built-in GitHub sign-in must not offer itself: the test
      // serves the session through its own authentication provider.
      '--disable-extension=vscode.github-authentication',
    ]).then(
      () => 0,
      (error: { stdout?: string; stderr?: string; exitCode?: number }) => {
        // A test failure reads as the editor exiting nonzero; the
        // captured streams carry the test's own output.
        console.error(error.stdout ?? '', error.stderr ?? '');
        return error.exitCode ?? 1;
      },
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
