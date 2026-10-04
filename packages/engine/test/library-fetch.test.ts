import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { removeCopy } from '../src/cache.js';
import { fetchLibrary, findLibraryPin, normalizePackageName, offerLibraryFetches, type LibraryPin } from '../src/library-fetch.js';
import type { Claim } from '../src/protocol.js';
import { pypiFetch, sha256Hex, tarball, temporaryCacheDir, zipArchive } from './helpers.js';

const CLIENT = ['class Client:', '    def __init__(self, follow_redirects: bool = False):', '        self.follow_redirects = follow_redirects', ''].join('\n');

/** A small pure-Python wheel of `httpx`. */
function wheel(): Buffer {
  return zipArchive([
    { name: 'httpx/__init__.py', content: 'from ._client import Client\n' },
    { name: 'httpx/_client.py', content: CLIENT },
    { name: 'httpx-0.27.2.dist-info/METADATA', content: 'Name: httpx\nVersion: 0.27.2\n' },
  ]);
}

/** A head copy holding only the given files at its root. */
function headWith(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'second-look-head-'));
  for (const [name, content] of Object.entries(files)) writeFileSync(join(root, name), content);
  return root;
}

function pin(hashes: string[]): LibraryPin {
  return { name: 'httpx', version: '0.27.2', pinnedBy: 'requirements.txt', hashes };
}

let cacheDir: string;
let librariesDir: string;

beforeEach(() => {
  cacheDir = temporaryCacheDir();
  librariesDir = join(cacheDir, 'libraries');
});

afterEach(async () => {
  await removeCopy(cacheDir);
});

describe('findLibraryPin', () => {
  const HASH_A = 'a'.repeat(64);
  const HASH_B = 'b'.repeat(64);

  it('reads a hashed requirements file: continuation lines, extras, markers and comments', async () => {
    const root = headWith({
      'requirements.txt': [
        '# pinned by pip-compile',
        'anyio==4.4.0 \\',
        `    --hash=sha256:${HASH_A}`,
        `HTTPX[http2]==0.27.2 ; python_version >= "3.8" \\`,
        `    --hash=sha256:${HASH_A} \\`,
        `    --hash=sha256:${HASH_B.toUpperCase()}  # the wheel and the sdist`,
      ].join('\n'),
    });

    await expect(findLibraryPin(root, 'httpx')).resolves.toEqual({
      name: 'HTTPX',
      version: '0.27.2',
      pinnedBy: 'requirements.txt',
      hashes: [HASH_A, HASH_B],
    });
  });

  it('finds no pin a fetch could check: no hash, no exact version, or no such library', async () => {
    const root = headWith({ 'requirements.txt': 'httpx==0.27.2\nanyio>=4\n' });

    await expect(findLibraryPin(root, 'httpx')).resolves.toBeUndefined();
    await expect(findLibraryPin(root, 'anyio')).resolves.toBeUndefined();
    await expect(findLibraryPin(root, 'requests')).resolves.toBeUndefined();
  });

  it('reads uv.lock first, for packages from PyPI only', async () => {
    const root = headWith({
      'uv.lock': [
        'version = 1',
        '',
        '[[package]]',
        'name = "httpx"',
        'version = "0.27.2"',
        'source = { registry = "https://pypi.org/simple" }',
        `sdist = { url = "https://files.pythonhosted.org/packages/httpx-0.27.2.tar.gz", hash = "sha256:${HASH_B}", size = 144189 }`,
        'wheels = [',
        `    { url = "https://files.pythonhosted.org/packages/httpx-0.27.2-py3-none-any.whl", hash = "sha256:${HASH_A}", size = 76395 },`,
        ']',
        '',
        '[[package]]',
        'name = "private-lib"',
        'version = "1.0.0"',
        'source = { registry = "https://packages.example.com/simple" }',
        `wheels = [{ url = "https://packages.example.com/private_lib-1.0.0-py3-none-any.whl", hash = "sha256:${HASH_A}" }]`,
      ].join('\n'),
      'requirements.txt': `httpx==0.28.0 --hash=sha256:${HASH_A}\n`,
    });

    await expect(findLibraryPin(root, 'httpx')).resolves.toEqual({ name: 'httpx', version: '0.27.2', pinnedBy: 'uv.lock', hashes: [HASH_B, HASH_A] });
    await expect(findLibraryPin(root, 'private-lib')).resolves.toBeUndefined();
  });

  it('reads requirements.txt before a dev file that pins another version', async () => {
    const root = headWith({
      'requirements-dev.txt': `httpx==0.28.0 --hash=sha256:${HASH_B}\n`,
      'requirements.txt': `httpx==0.27.2 --hash=sha256:${HASH_A}\n`,
    });

    await expect(findLibraryPin(root, 'httpx')).resolves.toEqual({ name: 'httpx', version: '0.27.2', pinnedBy: 'requirements.txt', hashes: [HASH_A] });
  });

  it("reads poetry.lock's files, and poetry 1's metadata files", async () => {
    const poetry2 = headWith({
      'poetry.lock': ['[[package]]', 'name = "httpx"', 'version = "0.27.2"', `files = [{ file = "httpx-0.27.2-py3-none-any.whl", hash = "sha256:${HASH_A}" }]`].join('\n'),
    });
    const poetry1 = headWith({
      'poetry.lock': ['[[package]]', 'name = "httpx"', 'version = "0.27.2"', '', '[metadata.files]', `httpx = [{ file = "httpx-0.27.2.tar.gz", hash = "sha256:${HASH_B}" }]`].join('\n'),
    });

    await expect(findLibraryPin(poetry2, 'httpx')).resolves.toMatchObject({ pinnedBy: 'poetry.lock', hashes: [HASH_A] });
    await expect(findLibraryPin(poetry1, 'httpx')).resolves.toMatchObject({ pinnedBy: 'poetry.lock', hashes: [HASH_B] });
  });

  it('compares package names as PyPI does', () => {
    expect(normalizePackageName('Typing_Extensions')).toBe('typing-extensions');
    expect(normalizePackageName('zope.interface')).toBe('zope-interface');
  });
});

describe('offerLibraryFetches', () => {
  const unverifiable = (needsLibrary?: string): Claim => ({
    quote: 'Any redirect on the way is followed.',
    source: 'docstring',
    location: { kind: 'file', path: 'app/doc_links.py', line: 9, endLine: 9 },
    part: 0,
    verdict: { kind: 'unverifiable', source: 'the change itself', reason: 'It turns on httpx.', evidence: [], ...(needsLibrary ? { needsLibrary } : {}) },
  });

  it('offers a fetch naming the library, the pinned version, the lock file and why, for a claim that needs a pinned library', async () => {
    const root = headWith({ 'requirements.txt': `httpx==0.27.2 --hash=sha256:${'a'.repeat(64)}\n` });

    const [offered, plain, unpinned] = await offerLibraryFetches([unverifiable('httpx'), unverifiable(), unverifiable('requests')], root);

    expect(offered!.verdict).toMatchObject({
      libraryFetch: {
        library: 'httpx',
        pinnedVersion: '0.27.2',
        pinnedBy: 'requirements.txt',
        reason: expect.stringContaining('needs the source of httpx 0.27.2, as requirements.txt pins it'),
      },
    });
    expect(plain!.verdict).not.toHaveProperty('libraryFetch');
    expect(unpinned!.verdict).not.toHaveProperty('libraryFetch');
  });
});

describe('fetchLibrary', () => {
  it('downloads the pinned wheel, checks its hash and unpacks it read-only into the library cache', async () => {
    const bytes = wheel();
    const transport = pypiFetch('httpx', '0.27.2', [
      { filename: 'httpx-0.27.2.tar.gz', bytes: tarball([{ path: 'httpx-0.27.2/httpx/_client.py', content: CLIENT }]) },
      { filename: 'httpx-0.27.2-py3-none-any.whl', bytes },
    ]);
    const hashes = [sha256Hex(bytes), sha256Hex(tarball([{ path: 'httpx-0.27.2/httpx/_client.py', content: CLIENT }]))];

    const fetched = await fetchLibrary(pin(hashes), { librariesDir, fetch: transport.fetch });

    expect(fetched).toEqual({
      file: 'httpx-0.27.2-py3-none-any.whl',
      sha256: sha256Hex(bytes),
      archive: 'wheel',
      path: join(librariesDir, `httpx-0.27.2-${sha256Hex(bytes).slice(0, 12)}`),
      reused: false,
    });
    expect(readFileSync(join(fetched.path, 'httpx', '_client.py'), 'utf8')).toBe(CLIENT);
    // The cache is read-only: no file can be written or run, no folder changed.
    expect(statSync(join(fetched.path, 'httpx', '_client.py')).mode & 0o777).toBe(0o444);
    expect(statSync(join(fetched.path, 'httpx')).mode & 0o777).toBe(0o555);
    expect(statSync(fetched.path).mode & 0o777).toBe(0o555);
    expect(transport.requests.map((request) => request.url)).toEqual([
      'https://pypi.org/pypi/httpx/0.27.2/json',
      'https://files.pythonhosted.org/packages/ab/cd/httpx-0.27.2-py3-none-any.whl',
    ]);
  });

  it('aborts on a hash mismatch with a clear message, and unpacks nothing', async () => {
    const pinned = wheel();
    const tampered = zipArchive([{ name: 'httpx/_client.py', content: 'import os\n' }]);
    const transport = pypiFetch('httpx', '0.27.2', [{ filename: 'httpx-0.27.2-py3-none-any.whl', bytes: tampered, sha256: sha256Hex(pinned) }]);

    await expect(fetchLibrary(pin([sha256Hex(pinned)]), { librariesDir, fetch: transport.fetch })).rejects.toThrow(
      `the download of httpx-0.27.2-py3-none-any.whl does not match the hash requirements.txt pins (expected sha256 ${sha256Hex(pinned)}, got ${sha256Hex(tampered)}); nothing was unpacked`,
    );
    expect(existsSync(librariesDir) ? readdirSync(librariesDir) : []).toEqual([]);
  });

  it('downloads only a file whose hash the lock pins, and only from PyPI', async () => {
    const bytes = wheel();
    const elsewhere = pypiFetch('httpx', '0.27.2', [{ filename: 'httpx-0.27.2-py3-none-any.whl', bytes, url: 'https://example.com/httpx-0.27.2-py3-none-any.whl' }]);
    const unpinned = pypiFetch('httpx', '0.27.2', [{ filename: 'httpx-0.27.2-py3-none-any.whl', bytes }]);

    await expect(fetchLibrary(pin([sha256Hex(bytes)]), { librariesDir, fetch: elsewhere.fetch })).rejects.toThrow(
      'PyPI lists no wheel or source archive of httpx 0.27.2 whose hash requirements.txt pins; nothing was downloaded',
    );
    await expect(fetchLibrary(pin(['f'.repeat(64)]), { librariesDir, fetch: unpinned.fetch })).rejects.toThrow(/whose hash requirements.txt pins/);
    expect([...elsewhere.requests, ...unpinned.requests].map((request) => request.url)).toEqual([
      'https://pypi.org/pypi/httpx/0.27.2/json',
      'https://pypi.org/pypi/httpx/0.27.2/json',
    ]);
  });

  it('unpacks a source archive without building it, and says when only that exists', async () => {
    const sdist = tarball([
      { path: 'httpx-0.27.2/', type: '5' },
      { path: 'httpx-0.27.2/setup.py', content: 'raise SystemExit("never run")\n' },
      { path: 'httpx-0.27.2/httpx/_client.py', content: CLIENT },
    ]);
    const transport = pypiFetch('httpx', '0.27.2', [{ filename: 'httpx-0.27.2.tar.gz', bytes: sdist }]);

    const fetched = await fetchLibrary(pin([sha256Hex(sdist)]), { librariesDir, fetch: transport.fetch });

    expect(fetched).toMatchObject({
      archive: 'source archive',
      note: 'requirements.txt pins no wheel of httpx 0.27.2, only its source archive: it was unpacked and never built, so code the build would generate is missing.',
    });
    expect(readFileSync(join(fetched.path, 'httpx', '_client.py'), 'utf8')).toBe(CLIENT);
    expect(statSync(join(fetched.path, 'setup.py')).mode & 0o111).toBe(0);
  });

  it('skips links and paths that would leave the cache', async () => {
    const bytes = zipArchive([
      { name: 'httpx/_client.py', content: CLIENT },
      { name: 'httpx/link.py', content: '/etc/passwd', mode: 0o120777 },
      { name: '../escape.py', content: 'x = 1\n' },
      { name: '/absolute.py', content: 'x = 1\n' },
    ]);
    const transport = pypiFetch('httpx', '0.27.2', [{ filename: 'httpx-0.27.2-py3-none-any.whl', bytes }]);

    const fetched = await fetchLibrary(pin([sha256Hex(bytes)]), { librariesDir, fetch: transport.fetch });

    expect(readdirSync(join(fetched.path, 'httpx'))).toEqual(['_client.py']);
    expect(readdirSync(fetched.path)).toEqual(['httpx']);
    expect(existsSync(join(librariesDir, 'escape.py'))).toBe(false);
  });

  it('reuses an earlier fetch of the same file without downloading it again', async () => {
    const bytes = wheel();
    const transport = pypiFetch('httpx', '0.27.2', [{ filename: 'httpx-0.27.2-py3-none-any.whl', bytes }]);
    const first = await fetchLibrary(pin([sha256Hex(bytes)]), { librariesDir, fetch: transport.fetch });

    const second = await fetchLibrary(pin([sha256Hex(bytes)]), { librariesDir, fetch: transport.fetch });

    expect(second).toEqual({ ...first, reused: true });
    expect(transport.requests.filter((request) => request.url.endsWith('.whl'))).toHaveLength(1);
  });

  it('refuses a version that could steer the cache path', async () => {
    mkdirSync(librariesDir, { recursive: true });
    await expect(fetchLibrary({ ...pin(['a'.repeat(64)]), version: '../0.27.2' }, { librariesDir, fetch: pypiFetch('httpx', '0', []).fetch })).rejects.toThrow(
      'not a version a library fetch can download: ../0.27.2',
    );
  });
});
