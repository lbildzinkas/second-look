import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { productJsonPath, trustCompanion } from './real-host/launch.js';

/**
 * The host-layout half of the launchers: `productJsonPath` and
 * `trustCompanion` must hold for every layout a downloaded editor has
 * on the platforms CI runs, because the package smoke test patches
 * product.json before it can install or run anything.
 */

const workDir = mkdtempSync(join(tmpdir(), 'second-look-host-launch-'));

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
});

/**
 * Lays out a downloaded editor on disk — an executable marker plus the
 * product.json placement the given download uses — and returns the
 * executable path `downloadAndUnzipVSCode` would report for it.
 */
function downloadedEditor(folder: string, executable: string, productJson: string): string {
  const root = join(workDir, folder);
  const executablePath = join(root, executable);
  mkdirSync(dirname(executablePath), { recursive: true });
  writeFileSync(executablePath, '');
  const productJsonFile = join(root, productJson);
  mkdirSync(dirname(productJsonFile), { recursive: true });
  writeFileSync(productJsonFile, '{}\n');
  return executablePath;
}

describe('productJsonPath', () => {
  // Current Windows archives nest resources under a folder named after
  // the build's commit, with Code.exe still beside it
  // (microsoft/vscode#249239).
  it('finds product.json in the Windows archive current layout', () => {
    expect(
      productJsonPath(downloadedEditor('win', 'Code.exe', '07b4ff1883/resources/app/product.json')),
    ).toBe(join(workDir, 'win', '07b4ff1883', 'resources', 'app', 'product.json'));
  });

  it('finds product.json beside the executable on Linux and older Windows archives', () => {
    expect(
      productJsonPath(downloadedEditor('linux', 'code', 'resources/app/product.json')),
    ).toBe(join(workDir, 'linux', 'resources', 'app', 'product.json'));
  });

  it('finds product.json inside the downloaded macOS app bundle', () => {
    expect(
      productJsonPath(
        downloadedEditor(
          'mac',
          'Visual Studio Code.app/Contents/MacOS/Electron',
          'Visual Studio Code.app/Contents/Resources/app/product.json',
        ),
      ),
    ).toBe(join(workDir, 'mac', 'Visual Studio Code.app', 'Contents', 'Resources', 'app', 'product.json'));
  });

  it('fails loudly when no product.json sits in any known layout', () => {
    const executable = downloadedEditor('empty', 'code', 'resources/app/product.json');
    rmSync(join(workDir, 'empty', 'resources'), { recursive: true, force: true });
    expect(() => productJsonPath(executable)).toThrow(/no product\.json found/);
  });
});

describe('trustCompanion', () => {
  it('adds the companion to the trust list of the Windows archive current layout', () => {
    trustCompanion(
      downloadedEditor('win-trust', 'Code.exe', '07b4ff1883/resources/app/product.json'),
      'lbildzinkas.second-look-extension',
    );
    expect(
      JSON.parse(
        readFileSync(
          join(workDir, 'win-trust', '07b4ff1883', 'resources', 'app', 'product.json'),
          'utf8',
        ),
      ),
    ).toEqual({
      trustedExtensionAuthAccess: { github: ['lbildzinkas.second-look-extension'] },
    });
  });
});
