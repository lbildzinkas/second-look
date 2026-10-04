import { downloadAndUnzipVSCode, runTests } from '@vscode/test-electron';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * Launches a real VS Code and runs the real-host test in it. CI calls
 * this under xvfb; no local check runs it, because it opens a real
 * editor window.
 */

/** Where product.json lives for a downloaded VS Code, per platform. */
export function productJsonPath(vscodeExecutablePath: string): string {
  const appRoot = dirname(vscodeExecutablePath);
  const candidates = [
    // Linux, and Windows archives before their resources moved under a
    // versioned folder: the executable sits beside resources/.
    join(appRoot, 'resources', 'app', 'product.json'),
    // macOS: the executable sits in <app>.app/Contents/MacOS/.
    join(appRoot, '..', 'Resources', 'app', 'product.json'),
    // Recent Windows archives nest resources under a folder named after
    // the build's commit (microsoft/vscode#249239), beside Code.exe.
    ...readdirSync(appRoot)
      .filter((entry) => /^[0-9a-f]{10}$/.test(entry))
      .map((entry) => join(appRoot, entry, 'resources', 'app', 'product.json')),
  ];
  const productJson = candidates.find((path) => existsSync(path));
  if (productJson === undefined) {
    throw new Error(`no product.json found next to ${vscodeExecutablePath}`);
  }
  return productJson;
}

/**
 * Adds the companion to the downloaded host's trust list for the GitHub
 * provider. A test host refuses every dialog, so the consent dialog
 * getSession would otherwise stop at — the one a reviewer clicks once in
 * a real editor — can never be answered there, and the review would read
 * as "not signed in". The trust list is VS Code's own mechanism for
 * extensions allowed a provider's sessions without that dialog.
 */
export function trustCompanion(vscodeExecutablePath: string, extensionId: string): void {
  const productJson = productJsonPath(vscodeExecutablePath);
  const product = JSON.parse(readFileSync(productJson, 'utf8')) as {
    trustedExtensionAuthAccess?: Record<string, string[]> | string[];
  };
  const trusted = (product.trustedExtensionAuthAccess ??= {});
  // The host reads either shape: a plain list trusted for every provider,
  // or a per-provider map.
  let trustedAlready: boolean;
  if (Array.isArray(trusted)) {
    trustedAlready = trusted.includes(extensionId);
    if (!trustedAlready) {
      trusted.push(extensionId);
    }
  } else {
    const trustedByGithub = (trusted['github'] ??= []);
    trustedAlready = trustedByGithub.includes(extensionId);
    if (!trustedAlready) {
      trustedByGithub.push(extensionId);
    }
  }
  if (!trustedAlready) {
    writeFileSync(productJson, JSON.stringify(product, undefined, 2));
  }
}

async function main(): Promise<void> {
  try {
    // Resolved through the workspace link, so it holds wherever this
    // script runs from.
    const require = createRequire(import.meta.url);
    const manifestPath = require.resolve('second-look-extension/package.json');
    const extensionRoot = dirname(manifestPath);
    const { name, publisher } = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      name: string;
      publisher: string;
    };
    // The same download runTests would make, patched before the launch:
    // runTests reuses the copy already in the cache.
    const vscodeExecutablePath = await downloadAndUnzipVSCode({
      extensionDevelopmentPath: extensionRoot,
    });
    trustCompanion(vscodeExecutablePath, `${publisher}.${name}`);
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

// Runs the launch only when executed as a script, so the helpers stay
// importable without downloading or launching anything.
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  void main();
}
