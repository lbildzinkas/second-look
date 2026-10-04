import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  findPackage,
  installedPackageFolder,
  smokeExtensionsDir,
  withStepTimeout,
} from './package-smoke/launch.js';

/**
 * The package smoke launcher's own halves: every await the launcher
 * makes must settle within its bound or the launcher fails naming the
 * stalled step and aborts whatever the step spawned — a CI hang must
 * become a failing check with an error, never a silent stall that sits
 * inside the job until it is cancelled — and the folder the install
 * step creates must be found exactly where the install put it, because
 * the editor's test runner refuses to start without it.
 */

describe('withStepTimeout', () => {
  it('resolves with the step result when the step settles in time', async () => {
    await expect(
      withStepTimeout(
        'a quick step',
        async () => 'done',
        60_000,
      ),
    ).resolves.toBe('done');
  });

  it('propagates the step own failure instead of masking it', async () => {
    await expect(
      withStepTimeout(
        'a failing step',
        async () => {
          throw new Error('the step failed');
        },
        60_000,
      ),
    ).rejects.toThrow('the step failed');
  });

  it('fails naming the stalled step and aborts its spawn signal', async () => {
    let aborted = false;
    const stalled = withStepTimeout(
      'the stalled step',
      (signal) =>
        // Never settles by itself, like an editor that never exits.
        new Promise<string>((resolve) => {
          signal.addEventListener('abort', () => {
            aborted = true;
            resolve('the spawned process was killed');
          });
        }),
      20,
    );
    await expect(stalled).rejects.toThrow(
      'the stalled step did not finish within 20 ms',
    );
    expect(aborted).toBe(true);
  });

  it('leaves the spawn signal alone when the step settles in time', async () => {
    let signal: AbortSignal | undefined;
    await withStepTimeout(
      'a quick step',
      (spawnSignal) => {
        signal = spawnSignal;
        return Promise.resolve('done');
      },
      10,
    );
    // Past the deadline the step would have been killed at.
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(signal?.aborted).toBe(false);
  });
});

const workDir = mkdtempSync(join(tmpdir(), 'second-look-package-smoke-launch-'));

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe('findPackage', () => {
  it('finds the downloaded package beside the repository, else the newest one packaged', () => {
    const downloaded = join(workDir, 'package');
    mkdirSync(downloaded);
    writeFileSync(join(downloaded, 'second-look-extension-0.1.0.vsix'), '');
    expect(findPackage(workDir, join(workDir, 'extension'))).toBe(
      join(downloaded, 'second-look-extension-0.1.0.vsix'),
    );

    const dist = join(workDir, 'extension', 'dist');
    mkdirSync(dist, { recursive: true });
    writeFileSync(join(dist, 'second-look-extension-0.1.0.vsix'), '');
    writeFileSync(join(dist, 'second-look-extension-0.2.0.vsix'), '');
    expect(findPackage(workDir, join(workDir, 'extension'))).toBe(
      join(downloaded, 'second-look-extension-0.1.0.vsix'),
    );
    expect(findPackage(join(workDir, 'empty-root'), join(workDir, 'extension'))).toBe(
      join(dist, 'second-look-extension-0.2.0.vsix'),
    );
  });

  it('fails with a plain error when no package exists anywhere', () => {
    const empty = join(workDir, 'nothing-packaged');
    mkdirSync(empty);
    expect(() => findPackage(empty, join(empty, 'extension'))).toThrow(
      'no .vsix package found',
    );
  });
});

describe('installedPackageFolder', () => {
  it('finds the folder the install created, newest first, under the smoke extensions dir', () => {
    const extensionsDir = smokeExtensionsDir(workDir);
    mkdirSync(extensionsDir, { recursive: true });
    for (const entry of [
      'other-publisher.other-extension-1.0.0',
      'lbildzinkas.second-look-extension-0.1.0',
      'lbildzinkas.second-look-extension-0.1.1',
    ]) {
      mkdirSync(join(extensionsDir, entry));
    }
    expect(
      installedPackageFolder(extensionsDir, 'lbildzinkas', 'second-look-extension'),
    ).toBe(join(extensionsDir, 'lbildzinkas.second-look-extension-0.1.1'));
  });

  it('fails with a plain error when the install created no such folder', () => {
    expect(() =>
      installedPackageFolder(join(workDir, 'nowhere'), 'lbildzinkas', 'second-look-extension'),
    ).toThrow('installing the package created no');
  });
});
