import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { removeCopy } from '../src/cache.js';
import { fetchLibrary, findLibraryPin } from '../src/library-fetch.js';
import { NoExactSourceError, fetchNuGetLibrary, findNuGetPin, provesSource, type NuGetPin } from '../src/nuget-fetch.js';
import { readPackagePdbs } from '../src/symbols.js';
import { temporaryCacheDir, zipArchive, type RecordedRequest } from './helpers.js';

/** The C# canary's recorded nuget.org answers, package and source files, by URL. */
const CANARY = fileURLToPath(new URL('../../evaluation/cases/canary-csharp/fetched/', import.meta.url));
const ID = 'microsoft.io.recyclablememorystream';
const COMMIT = 'e29a28387da9018fa9605a1dcb3f7a0435aa9974';
const NUPKG = `https://api.nuget.org/v3-flatcontainer/${ID}/3.0.1/${ID}.3.0.1.nupkg`;
const SOURCE = `https://raw.githubusercontent.com/microsoft/Microsoft.IO.RecyclableMemoryStream/${COMMIT}/src`;
const CANARY_HASH = 'xXlOonyQi1+yRC+qRB6fP4H/o9wp1BoxO1QmQ5I65hBwkFscFcLsrZgJLGubKjtCOsqXnnHtl5covVcrafIKRg==';

/** The package 1.2.2 of the same library: standalone PDBs without Source Link, and a nuspec naming no commit. */
const OLD_PACKAGE = readFileSync(fileURLToPath(new URL('./fixtures/pdb/Microsoft.IO.RecyclableMemoryStream.1.2.2.nupkg', import.meta.url)));
/** A standalone PDB whose Source Link names commit 04f0487 of ardalis/GuardClauses. */
const GUARD_PDB = readFileSync(fileURLToPath(new URL('./fixtures/pdb/Ardalis.GuardClauses.pdb', import.meta.url)));
const GUARD_COMMIT = '04f04876641f683e468305e28ae0ba0edf0cf033';

function sha512Base64(bytes: Buffer): string {
  return createHash('sha512').update(bytes).digest('base64');
}

/**
 * A fetch that serves the canary's recorded files by URL, with `served`
 * answering first; any other URL is a 404, as a Git host answers for a
 * file the build generated. Records every request.
 */
function recordedNuGet(served: Record<string, Response | Buffer | string> = {}) {
  const requests: RecordedRequest[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    requests.push({ url, method: init?.method ?? 'GET', body: null, accept: '', authorization: null });
    const answer = served[url];
    if (answer instanceof Response) return answer;
    if (answer !== undefined) return new Response(answer);
    const { host, pathname } = new URL(url);
    const body = await readFile(join(CANARY, host, ...pathname.split('/').filter(Boolean))).catch(() => undefined);
    return body === undefined ? new Response('not found', { status: 404 }) : new Response(body);
  };
  return { fetch: fetchImpl, requests };
}

const canaryPin = (contentHash?: string): NuGetPin => ({
  ecosystem: 'NuGet',
  name: 'Microsoft.IO.RecyclableMemoryStream',
  version: '3.0.1',
  pinnedBy: 'src/BlobTool.csproj',
  ...(contentHash ? { contentHash } : {}),
});

/** A head copy holding the given files, by forward-slash path. */
function headWith(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'second-look-head-'));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
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

describe('findNuGetPin', () => {
  const lock = (resolved: string, hash = 'aGFzaA==') =>
    JSON.stringify({ version: 1, dependencies: { 'net8.0': { 'Microsoft.IO.RecyclableMemoryStream': { type: 'Direct', requested: `[${resolved}, )`, resolved, contentHash: hash } } } });

  it("reads packages.lock.json first, with the SHA-512 it records, before any project file", async () => {
    const root = headWith({
      'src/App/packages.lock.json': lock('3.0.1', CANARY_HASH),
      'src/App/App.csproj': '<Project><ItemGroup><PackageReference Include="Microsoft.IO.RecyclableMemoryStream" Version="2.0.0" /></ItemGroup></Project>',
    });

    await expect(findNuGetPin(root, 'microsoft.io.recyclablememorystream')).resolves.toEqual({
      ecosystem: 'NuGet',
      name: 'Microsoft.IO.RecyclableMemoryStream',
      version: '3.0.1',
      pinnedBy: 'src/App/packages.lock.json',
      contentHash: CANARY_HASH,
    });
  });

  it('reads an exact version from a project file, a Version element or Directory.Packages.props', async () => {
    const attribute = headWith({ 'src/BlobTool.csproj': '<Project><ItemGroup><PackageReference Include="Microsoft.IO.RecyclableMemoryStream" Version="[3.0.1]" /></ItemGroup></Project>' });
    const element = headWith({ 'Lib.fsproj': '<Project><PackageReference Include="Microsoft.IO.RecyclableMemoryStream">\n  <Version>3.0.1</Version>\n</PackageReference></Project>' });
    const central = headWith({
      'Directory.Packages.props': '<Project><ItemGroup><PackageVersion Include="Microsoft.IO.RecyclableMemoryStream" Version="3.0.1" /></ItemGroup></Project>',
      'src/App.csproj': '<Project><ItemGroup><PackageReference Include="Microsoft.IO.RecyclableMemoryStream" /></ItemGroup></Project>',
    });

    await expect(findNuGetPin(attribute, 'Microsoft.IO.RecyclableMemoryStream')).resolves.toEqual({ ...canaryPin(), pinnedBy: 'src/BlobTool.csproj' });
    await expect(findNuGetPin(element, 'Microsoft.IO.RecyclableMemoryStream')).resolves.toMatchObject({ version: '3.0.1', pinnedBy: 'Lib.fsproj' });
    await expect(findNuGetPin(central, 'Microsoft.IO.RecyclableMemoryStream')).resolves.toMatchObject({ version: '3.0.1', pinnedBy: 'Directory.Packages.props' });
  });

  it('finds no pin for a range, a floating version, a property, a comment, or a reference in build output', async () => {
    const reference = (version: string) => `<Project><PackageReference Include="Microsoft.IO.RecyclableMemoryStream" Version="${version}" /></Project>`;
    for (const version of ['[3.0,4.0)', '3.*', '$(StreamVersion)', '']) {
      await expect(findNuGetPin(headWith({ 'App.csproj': reference(version) }), 'Microsoft.IO.RecyclableMemoryStream')).resolves.toBeUndefined();
    }
    const hidden = headWith({ 'App.csproj': `<Project><!-- ${reference('3.0.1')} --></Project>`, 'bin/Debug/App.csproj': reference('3.0.1'), 'node_modules/x/App.csproj': reference('3.0.1') });
    await expect(findNuGetPin(hidden, 'Microsoft.IO.RecyclableMemoryStream')).resolves.toBeUndefined();
  });

  it('is where findLibraryPin looks when no Python lock file pins the library', async () => {
    const root = headWith({ 'requirements.txt': 'httpx==0.27.2\n', 'src/BlobTool.csproj': `<Project><PackageReference Include="Microsoft.IO.RecyclableMemoryStream" Version="3.0.1" /></Project>` });

    await expect(findLibraryPin(root, 'Microsoft.IO.RecyclableMemoryStream')).resolves.toEqual(canaryPin());
  });
});

describe('provesSource', () => {
  const LF = Buffer.from('namespace Blob;\n\npublic class Reader { }\n');
  const CRLF = Buffer.from('namespace Blob;\r\n\r\npublic class Reader { }\r\n');
  const sha256 = (bytes: Buffer) => ({ hashAlgorithm: 'SHA-256' as const, hash: createHash('sha256').update(bytes).digest('hex') });
  const sha1 = (bytes: Buffer) => ({ hashAlgorithm: 'SHA-1' as const, hash: createHash('sha1').update(bytes).digest('hex') });

  it('proves a file served with LF line endings against the hash of its CRLF checkout', () => {
    expect(provesSource(LF, [sha256(CRLF)])).toBe(true);
    expect(provesSource(LF, [sha1(CRLF)])).toBe(true);
  });

  it('proves a file served with CRLF line endings against the hash of its LF checkout, and as served', () => {
    expect(provesSource(CRLF, [sha256(LF)])).toBe(true);
    expect(provesSource(CRLF, [sha256(CRLF)])).toBe(true);
  });

  it('proves nothing when the bytes differ, or the PDB records no hash it knows', () => {
    const changed = Buffer.from('namespace Blob;\n\npublic class Writer { }\n');
    expect(provesSource(changed, [sha256(LF), sha256(CRLF), sha1(CRLF)])).toBe(false);
    expect(provesSource(LF, [{ hashAlgorithm: 'unknown', hash: sha256(LF).hash }, { hashAlgorithm: 'none', hash: '' }])).toBe(false);
  });

  it("proves the canary's source as GitHub serves it, LF, against the CRLF checkout's hash its embedded PDB records", () => {
    const served = readFileSync(join(CANARY, 'raw.githubusercontent.com/microsoft/Microsoft.IO.RecyclableMemoryStream', COMMIT, 'src/RecyclableMemoryStream.cs'));
    const [pdb] = readPackagePdbs('canary.nupkg', readFileSync(join(CANARY, 'api.nuget.org/v3-flatcontainer', ID, '3.0.1', `${ID}.3.0.1.nupkg`)));
    const document = pdb!.documents.find((each) => each.name === '/_/src/RecyclableMemoryStream.cs')!;

    expect(served.includes('\r\n')).toBe(false);
    expect(createHash('sha256').update(served).digest('hex')).not.toBe(document.hash);
    expect(provesSource(served, [document])).toBe(true);
  });
});

describe('fetchNuGetLibrary', () => {
  it("downloads the pinned package, checks nuget.org's SHA-512, and keeps each source file at the nuspec's commit read-only, proven by its PDB", async () => {
    const transport = recordedNuGet();

    const fetched = await fetchLibrary(canaryPin(), { librariesDir, fetch: transport.fetch });

    expect(fetched).toEqual({
      file: `${ID}.3.0.1.nupkg`,
      sha256: createHash('sha256').update(readFileSync(join(CANARY, 'api.nuget.org/v3-flatcontainer', ID, '3.0.1', `${ID}.3.0.1.nupkg`))).digest('hex'),
      archive: 'NuGet package',
      note:
        `Source fetched from raw.githubusercontent.com at commit ${COMMIT}, which its nuspec names: 5 of 5 files are exact source, matched to the hash its PDB records; ` +
        '6 more its PDB names were not found there, such as files the build generated.',
      path: join(librariesDir, `${ID}-3.0.1-${Buffer.from(CANARY_HASH, 'base64').toString('hex').slice(0, 12)}`),
      reused: false,
    });
    expect(readdirSync(join(fetched.path, 'src')).sort()).toEqual(['EventArgs.cs', 'Events.cs', 'Properties', 'RecyclableMemoryStream.cs', 'RecyclableMemoryStreamManager.cs']);
    expect(statSync(join(fetched.path, 'src', 'RecyclableMemoryStream.cs')).mode & 0o777).toBe(0o444);
    expect(statSync(join(fetched.path, 'src')).mode & 0o777).toBe(0o555);
    // Only nuget.org and the host the PDB's Source Link names are asked, and nothing else.
    expect(new Set(transport.requests.map((request) => new URL(request.url).host))).toEqual(new Set(['api.nuget.org', 'raw.githubusercontent.com']));
    expect(transport.requests.every((request) => !request.url.startsWith('https://raw.') || request.url.includes(`/${COMMIT}/`))).toBe(true);
  });

  it('reuses an earlier fetch of the same package, as it landed, without downloading it again', async () => {
    const transport = recordedNuGet({ [`${SOURCE}/Events.cs`]: '// not the compiled file\n' });
    const first = await fetchLibrary(canaryPin(CANARY_HASH), { librariesDir, fetch: transport.fetch });

    const second = await fetchLibrary(canaryPin(CANARY_HASH), { librariesDir, fetch: transport.fetch });

    expect(second).toEqual({ ...first, reused: true });
    expect(transport.requests.filter((request) => request.url === NUPKG)).toHaveLength(1);
  });

  it('labels a file whose bytes match no hash its PDB records unproven, and says so', async () => {
    const transport = recordedNuGet({ [`${SOURCE}/Events.cs`]: '// not the compiled file\n' });

    const fetched = await fetchNuGetLibrary(canaryPin(CANARY_HASH), { librariesDir, fetch: transport.fetch });

    expect(fetched.unproven).toEqual(['src/Events.cs']);
    expect(fetched.note).toContain('4 of 5 files are exact source, matched to the hash its PDB records; 1 is unproven and never make a claim verified');
    // With a lock file's hash, nuget.org's record is not read.
    expect(transport.requests.some((request) => request.url.includes('/registration5-'))).toBe(false);
  });

  it("aborts once the package's source files together exceed what a fetch downloads, and lands none of them", async () => {
    const big = Buffer.alloc(512 * 1024, 97);
    const transport = recordedNuGet({
      [`${SOURCE}/EventArgs.cs`]: big,
      [`${SOURCE}/Events.cs`]: big,
      [`${SOURCE}/Properties/AssemblyInfo.cs`]: big,
      [`${SOURCE}/RecyclableMemoryStream.cs`]: big,
      [`${SOURCE}/RecyclableMemoryStreamManager.cs`]: big,
    });

    await expect(fetchNuGetLibrary(canaryPin(CANARY_HASH), { librariesDir, fetch: transport.fetch, maxSourceBytes: 2 * 1024 * 1024 })).rejects.toThrow(
      "the package's source files exceed the 2 MiB a library fetch downloads together",
    );
    expect(existsSync(librariesDir) ? readdirSync(librariesDir) : []).toEqual([]);
  });

  it('aborts on a SHA-512 mismatch with a clear message, and fetches no source', async () => {
    const transport = recordedNuGet();
    const wrong = sha512Base64(Buffer.from('another package'));

    await expect(fetchNuGetLibrary(canaryPin(wrong), { librariesDir, fetch: transport.fetch })).rejects.toThrow(
      new RegExp(`^the download of ${ID}\\.3\\.0\\.1\\.nupkg does not match the SHA-512 src/BlobTool\\.csproj gives .*; no source was fetched$`),
    );
    expect(transport.requests.map((request) => request.url)).toEqual([NUPKG]);
    expect(existsSync(librariesDir) ? readdirSync(librariesDir) : []).toEqual([]);
  });

  it('says plainly that no exact source can be found when the package names no commit and has no Source Link, and guesses nothing', async () => {
    const symbols = 'https://www.nuget.org/api/v2/symbolpackage/microsoft.io.recyclablememorystream/1.2.2';
    const transport = recordedNuGet({
      [`https://api.nuget.org/v3-flatcontainer/${ID}/1.2.2/${ID}.1.2.2.nupkg`]: OLD_PACKAGE,
      [symbols]: new Response('not found', { status: 404 }),
    });
    const pin: NuGetPin = { ...canaryPin(sha512Base64(OLD_PACKAGE)), version: '1.2.2', pinnedBy: 'packages.lock.json' };

    await expect(fetchNuGetLibrary(pin, { librariesDir, fetch: transport.fetch })).rejects.toThrow(
      'the exact source of Microsoft.IO.RecyclableMemoryStream 1.2.2 cannot be found: no PDB of it carries Source Link, which names where each source file is, ' +
        'and neither its nuspec nor its PDB names the repository commit it was built from; no source was fetched, and nothing is guessed',
    );
    // It carries what that version's own licence says of decompiling it.
    await expect(fetchNuGetLibrary(pin, { librariesDir, fetch: transport.fetch })).rejects.toSatisfy(
      (error) => error instanceof NoExactSourceError && error.licence.kind === 'unknown',
    );
    // The package and its symbol package are read; no source host, tag or branch is tried.
    expect(transport.requests.map((request) => new URL(request.url).host)).toEqual(['api.nuget.org', 'www.nuget.org', 'api.nuget.org', 'www.nuget.org']);
    expect(existsSync(librariesDir) ? readdirSync(librariesDir) : []).toEqual([]);
  });

  describe("a package whose PDB is in nuget.org's symbol package", () => {
    const nuspec = `<?xml version="1.0"?><package><metadata><id>Ardalis.GuardClauses</id><version>4.5.0</version><repository type="git" url="https://github.com/ardalis/GuardClauses" commit="${GUARD_COMMIT}" /></metadata></package>`;
    const PACKAGE = zipArchive([{ name: 'Ardalis.GuardClauses.nuspec', content: nuspec }, { name: 'lib/netstandard2.1/Ardalis.GuardClauses.xml', content: '<doc/>' }]);
    const SYMBOLS = zipArchive([{ name: 'lib/netstandard2.1/Ardalis.GuardClauses.pdb', content: GUARD_PDB }]);
    const SYMBOL_PACKAGE = 'https://www.nuget.org/api/v2/symbolpackage/ardalis.guardclauses/4.5.0';
    const pin: NuGetPin = { ecosystem: 'NuGet', name: 'Ardalis.GuardClauses', version: '4.5.0', pinnedBy: 'packages.lock.json', contentHash: sha512Base64(PACKAGE) };
    const redirect = (location: string) => new Response(null, { status: 302, headers: { location } });

    it("follows nuget.org's redirect to its download host and fetches the source its Source Link names", async () => {
      const download = 'https://globalcdn.nuget.org/symbol-packages/ardalis.guardclauses.4.5.0.snupkg';
      const transport = recordedNuGet({
        'https://api.nuget.org/v3-flatcontainer/ardalis.guardclauses/4.5.0/ardalis.guardclauses.4.5.0.nupkg': PACKAGE,
        [SYMBOL_PACKAGE]: redirect(download),
        [download]: SYMBOLS,
        [`https://raw.githubusercontent.com/ardalis/GuardClauses/${GUARD_COMMIT}/src/GuardClauses/Guard.cs`]: 'namespace Ardalis.GuardClauses;\n',
      });

      const fetched = await fetchNuGetLibrary(pin, { librariesDir, fetch: transport.fetch });

      expect(readFileSync(join(fetched.path, 'src/GuardClauses/Guard.cs'), 'utf8')).toBe('namespace Ardalis.GuardClauses;\n');
      expect(fetched.unproven).toEqual(['src/GuardClauses/Guard.cs']);
      expect(fetched.note).toContain(`at commit ${GUARD_COMMIT}, which its nuspec names: 0 of 1 file is exact source`);
    });

    it('refuses a symbol package nuget.org redirects to any other host', async () => {
      const transport = recordedNuGet({
        'https://api.nuget.org/v3-flatcontainer/ardalis.guardclauses/4.5.0/ardalis.guardclauses.4.5.0.nupkg': PACKAGE,
        [SYMBOL_PACKAGE]: redirect('https://nuget.org.example.com/ardalis.guardclauses.4.5.0.snupkg'),
      });

      await expect(fetchNuGetLibrary(pin, { librariesDir, fetch: transport.fetch })).rejects.toThrow(
        "nuget.org's symbol package of ardalis.guardclauses 4.5.0 is not on nuget.org's download host (HTTP 302)",
      );
      expect(transport.requests).toHaveLength(2);
    });
  });

  describe("the source hosts a PDB's Source Link may name", () => {
    const PACKAGE = 'https://api.nuget.org/v3-flatcontainer/ardalis.guardclauses/4.5.0/ardalis.guardclauses.4.5.0.nupkg';
    const GUARD_SOURCE = `https://raw.githubusercontent.com/ardalis/GuardClauses/${GUARD_COMMIT}/src/GuardClauses/Guard.cs`;

    /** A package embedding the GuardClauses PDB with its Source Link URL's `https://raw.githubusercontent.com/` prefix rewritten to `origin`, padded to the same length. */
    const packageAt = (origin: string): { bytes: Buffer; pin: NuGetPin } => {
      const pdb = Buffer.from(GUARD_PDB);
      const at = pdb.indexOf('https://raw.githubusercontent.com/');
      pdb.write(`${origin}/`.padEnd('https://raw.githubusercontent.com/'.length, 'b'), at, 'latin1');
      const bytes = zipArchive([
        { name: 'Ardalis.GuardClauses.nuspec', content: `<package><metadata><id>Ardalis.GuardClauses</id><version>4.5.0</version><repository commit="${GUARD_COMMIT}" /></metadata></package>` },
        { name: 'lib/netstandard2.1/Ardalis.GuardClauses.pdb', content: pdb },
      ]);
      return { bytes, pin: { ecosystem: 'NuGet', name: 'Ardalis.GuardClauses', version: '4.5.0', pinnedBy: 'packages.lock.json', contentHash: sha512Base64(bytes) } };
    };

    it("downloads the source its PDB names on an allowed host", async () => {
      const { bytes, pin } = packageAt('https://raw.githubusercontent.com');
      const transport = recordedNuGet({ [PACKAGE]: bytes, [GUARD_SOURCE]: 'namespace Ardalis.GuardClauses;\n' });

      const fetched = await fetchNuGetLibrary(pin, { librariesDir, fetch: transport.fetch });

      expect(readFileSync(join(fetched.path, 'src/GuardClauses/Guard.cs'), 'utf8')).toBe('namespace Ardalis.GuardClauses;\n');
      expect(new Set(transport.requests.map((request) => new URL(request.url).host))).toEqual(new Set(['api.nuget.org', 'raw.githubusercontent.com']));
    });

    it('never contacts a source host outside the allowed list — wildcard DNS, localhost, a bare IP, a port, plain http — and says so plainly', async () => {
      for (const origin of ['https://files.127.0.0.1.nip.io', 'https://localhost', 'https://127.0.0.1', 'https://github.com:8443', 'http://raw.githubusercontent.com']) {
        const { bytes, pin } = packageAt(origin);
        const transport = recordedNuGet({ [PACKAGE]: bytes });

        await expect(fetchNuGetLibrary(pin, { librariesDir, fetch: transport.fetch })).rejects.toThrow(
          `the Source Link of Ardalis.GuardClauses 4.5.0's PDB names ${origin} for its source at commit ${GUARD_COMMIT}, which is not one of the public source hosts a library fetch downloads from; no source was fetched`,
        );
        expect(transport.requests.map((request) => new URL(request.url).host)).toEqual(['api.nuget.org']);
        expect(existsSync(librariesDir) ? readdirSync(librariesDir) : []).toEqual([]);
      }
    });
  });

  it('refuses a package id or version that could steer a URL or the cache path', async () => {
    const transport = recordedNuGet();
    await expect(fetchNuGetLibrary({ ...canaryPin(CANARY_HASH), version: '../3.0.1' }, { librariesDir, fetch: transport.fetch })).rejects.toThrow(
      'not a package a library fetch can download: Microsoft.IO.RecyclableMemoryStream ../3.0.1',
    );
    await expect(fetchNuGetLibrary({ ...canaryPin(CANARY_HASH), name: 'a/../b' }, { librariesDir, fetch: transport.fetch })).rejects.toThrow(/not a package/);
    expect(transport.requests).toEqual([]);
  });
});
