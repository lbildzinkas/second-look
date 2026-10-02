import { runTests } from '@vscode/test-electron';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Launches a real VS Code and runs the real-host test in it. CI calls
 * this under xvfb; no local check runs it, because it opens a real
 * editor window.
 */
async function main(): Promise<void> {
  try {
    // Resolved through the workspace link, so it holds wherever this
    // script runs from.
    const require = createRequire(import.meta.url);
    const extensionRoot = dirname(require.resolve('second-look-extension/package.json'));
    const exitCode = await runTests({
      extensionDevelopmentPath: extensionRoot,
      extensionTestsPath: fileURLToPath(new URL('./run.js', import.meta.url)),
      launchArgs: [
        // The built-in GitHub sign-in must not offer itself: the test
        // serves the session through its own authentication provider.
        '--disable-extension=vscode.github-authentication',
      ],
    });
    process.exitCode = exitCode;
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}

void main();
