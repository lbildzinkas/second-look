import childProcess from 'node:child_process';
import { createHash } from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MockInstance } from 'vitest';
import { join } from 'node:path';
import { removeCopy } from '../src/cache.js';
import { goModuleHash } from '../src/ecosystem-fetch.js';
import { fetchLibrary } from '../src/library-fetch.js';
import { fetchNamedRepository } from '../src/repository-fetch.js';
import { reviewPullRequest } from '../src/review.js';
import { readZipEntries } from '../src/zip.js';
import { PR_7_URL, PR_8_URL, fixtureFetch, pull7, pull8, pypiFetch, recordedFetch, sha256Hex, tarball, temporaryCacheDir, zipArchive } from './helpers.js';

// A file of its own, so the reviews below are the first in this module
// graph: the WASM runtime and grammars load while every way to start a
// process is watched. The second review exercises the parse-only lock
// file checks, which must read files and never run a package manager.

let cacheDir: string;

beforeEach(() => {
  cacheDir = temporaryCacheDir();
});

afterEach(async () => {
  await removeCopy(cacheDir);
});

/** Every way to start a process, mocked to throw the moment one is tried. */
function forbidProcesses(): { restore: () => void; spies: readonly MockInstance[] } {
  const names = [
    'spawn',
    'spawnSync',
    'exec',
    'execSync',
    'execFile',
    'execFileSync',
    'fork',
  ] as const;
  const spies = names.map((name) =>
    vi.spyOn(childProcess, name).mockImplementation(() => {
      throw new Error(`the review tried to start a process with ${name}`);
    }),
  );
  syncBuiltinESMExports();
  return {
    spies,
    restore: () => {
      for (const spy of spies) spy.mockRestore();
      syncBuiltinESMExports();
    },
  };
}

describe('a review', () => {
  it('runs no process: no pull request code and no package manager', async () => {
    const guard = forbidProcesses();
    try {
      await reviewPullRequest(PR_7_URL, {
        token: 'test-token',
        fetch: fixtureFetch(pull7()).fetch,
        cacheDir,
      });
    } finally {
      guard.restore();
    }
    for (const spy of guard.spies) expect(spy).not.toHaveBeenCalled();
  });

  it('confirms lock file noise without starting a package manager', async () => {
    const guard = forbidProcesses();
    try {
      const result = await reviewPullRequest(PR_8_URL, {
        token: 'test-token',
        fetch: fixtureFetch(pull8()).fetch,
        cacheDir,
      });
      // The parse-only checks really ran: one lock file confirmed.
      expect(
        result.parts.some(
          (part) =>
            part.noise?.label === 'lockfile' && part.noise.state === 'confirmed',
        ),
      ).toBe(true);
    } finally {
      guard.restore();
    }
    for (const spy of guard.spies) expect(spy).not.toHaveBeenCalled();
  });

  it('fetches and unpacks a library without running anything: no install, no build, no script', async () => {
    const wheel = zipArchive([
      { name: 'httpx/__init__.py', content: 'import os\nos.system("echo never")\n' },
      { name: 'httpx-0.27.2.data/scripts/httpx', content: '#!/bin/sh\necho never\n', mode: 0o100755 },
    ]);
    const sdist = tarball([
      { path: 'anyio-4.4.0/setup.py', content: 'import os\nos.system("echo never")\n' },
      { path: 'anyio-4.4.0/src/anyio/__init__.py', content: '' },
    ]);
    const librariesDir = join(cacheDir, 'libraries');
    const guard = forbidProcesses();
    try {
      await fetchLibrary(
        { name: 'httpx', version: '0.27.2', pinnedBy: 'requirements.txt', hashes: [sha256Hex(wheel)] },
        { librariesDir, fetch: pypiFetch('httpx', '0.27.2', [{ filename: 'httpx-0.27.2-py3-none-any.whl', bytes: wheel }]).fetch },
      );
      await fetchLibrary(
        { name: 'anyio', version: '4.4.0', pinnedBy: 'requirements.txt', hashes: [sha256Hex(sdist)] },
        { librariesDir, fetch: pypiFetch('anyio', '4.4.0', [{ filename: 'anyio-4.4.0.tar.gz', bytes: sdist }]).fetch },
      );
    } finally {
      guard.restore();
    }
    for (const spy of guard.spies) expect(spy).not.toHaveBeenCalled();
  });

  it('fetches an npm package, a crate, a Go module, a sources jar and a named repository without running anything', async () => {
    const npm = tarball([{ path: 'package/package.json', content: '{ "scripts": { "postinstall": "node evil.js" } }\n' }, { path: 'package/evil.js', content: 'process.exit(1)\n' }]);
    const crate = tarball([{ path: 'evil-1.0.0/build.rs', content: 'fn main() { panic!() }\n' }]);
    const goZip = zipArchive([{ name: 'example.com/evil@v1.0.0/evil.go', content: 'package evil\n' }]);
    const jar = zipArchive([{ name: 'Evil.java', content: 'class Evil {}\n' }]);
    const repository = tarball([{ path: 'evil-1.0.0/install.sh', content: '#!/bin/sh\nexit 1\n', type: '0' }]);
    const central = 'https://repo.maven.apache.org/maven2/org/evil/evil/1.0.0/evil-1.0.0-sources.jar';
    const { fetch } = recordedFetch({
      'https://registry.npmjs.org/evil/-/evil-1.0.0.tgz': npm,
      'https://static.crates.io/crates/evil/evil-1.0.0.crate': crate,
      'https://proxy.golang.org/example.com/evil/@v/v1.0.0.zip': goZip,
      [central]: jar,
      [`${central}.sha1`]: createHash('sha1').update(jar).digest('hex'),
      'https://codeload.github.com/evil/evil/tar.gz/refs/tags/v1.0.0': repository,
    });
    const options = { librariesDir: join(cacheDir, 'libraries'), fetch };
    const guard = forbidProcesses();
    try {
      await fetchLibrary({ ecosystem: 'npm', name: 'evil', version: '1.0.0', pinnedBy: 'package-lock.json', hash: createHash('sha512').update(npm).digest('hex') }, options);
      await fetchLibrary({ ecosystem: 'Cargo', name: 'evil', version: '1.0.0', pinnedBy: 'Cargo.lock', hash: sha256Hex(crate) }, options);
      await fetchLibrary({ ecosystem: 'Go', name: 'example.com/evil', version: 'v1.0.0', pinnedBy: 'go.sum', hash: goModuleHash(readZipEntries(goZip)) }, options);
      await fetchLibrary({ ecosystem: 'Maven', name: 'org.evil:evil', version: '1.0.0', pinnedBy: 'pom.xml' }, options);
      await fetchNamedRepository('evil', { url: 'https://github.com/evil/evil', tag: 'v1.0.0' }, options);
    } finally {
      guard.restore();
    }
    for (const spy of guard.spies) expect(spy).not.toHaveBeenCalled();
  });
});
