import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PdbFormatError, readEmbeddedPdb, readPortablePdb } from '../src/pdb.js';
import { parseSourceLink, sourceLinkUrl } from '../src/sourcelink.js';
import { readPackagePdbs } from '../src/symbols.js';
import { readZipEntries } from '../src/zip.js';

/** Reads one of the public package files under test/fixtures/pdb. */
function fixture(name: string): Uint8Array {
  return readFileSync(fileURLToPath(new URL(`./fixtures/pdb/${name}`, import.meta.url)));
}

const GUARD_CLAUSES_PDB = 'Ardalis.GuardClauses.pdb';
const TOOLKIT_PDB = 'CommunityToolkit.Diagnostics.pdb';
const STREAM_DLL = 'Microsoft.IO.RecyclableMemoryStream.dll';
const STREAM_NUPKG = 'Microsoft.IO.RecyclableMemoryStream.1.2.2.nupkg';

describe('readPortablePdb', () => {
  it('lists the documents of a standalone PDB with their SHA-256 hashes', () => {
    const pdb = readPortablePdb(fixture(GUARD_CLAUSES_PDB));

    expect(pdb.documents).toHaveLength(17);
    expect(pdb.documents.every((document) => document.hashAlgorithm === 'SHA-256')).toBe(true);
    expect(pdb.documents).toContainEqual({
      name: 'D:\\a\\GuardClauses\\GuardClauses\\src\\GuardClauses\\Guard.cs',
      hashAlgorithm: 'SHA-256',
      // The SHA-256 of Guard.cs at the linked commit, checked out with CRLF line endings.
      hash: 'a9bd439431ec189645df9381ced2ecfdeaad8509634f3ac4c1627400569efc76',
    });
  });

  it('reads the Source Link JSON', () => {
    const pdb = readPortablePdb(fixture(GUARD_CLAUSES_PDB));
    expect(JSON.parse(pdb.sourceLink!)).toEqual({
      documents: {
        'D:\\a\\GuardClauses\\GuardClauses\\*':
          'https://raw.githubusercontent.com/ardalis/GuardClauses/04f04876641f683e468305e28ae0ba0edf0cf033/*',
      },
    });
  });

  it('reads SHA-1 and SHA-256 hashes side by side', () => {
    const pdb = readPortablePdb(fixture(TOOLKIT_PDB));
    const sha1 = pdb.documents.filter((document) => document.hashAlgorithm === 'SHA-1');
    const sha256 = pdb.documents.filter((document) => document.hashAlgorithm === 'SHA-256');

    expect(sha1).toHaveLength(3);
    expect(sha256).toHaveLength(26);
    expect(sha1.every((document) => /^[0-9a-f]{40}$/.test(document.hash))).toBe(true);
    expect(sha256.every((document) => /^[0-9a-f]{64}$/.test(document.hash))).toBe(true);
    expect(sha1).toContainEqual({
      name: '/_/src/CommunityToolkit.Diagnostics/PolySharp.SourceGenerators/PolySharp.SourceGenerators.PolyfillsGenerator/System.Diagnostics.StackTraceHiddenAttribute.g.cs',
      hashAlgorithm: 'SHA-1',
      hash: '786e94155f8fb4350c47333c6b643779b9e72e07',
    });
  });

  it('says a PDB without Source Link carries none', () => {
    const [entry] = readZipEntries(fixture(STREAM_NUPKG)).filter((zipEntry) =>
      zipEntry.name.endsWith('net45/Microsoft.IO.RecyclableMemoryStream.pdb'),
    );
    const pdb = readPortablePdb(entry!.read());

    expect(pdb.sourceLink).toBeNull();
    expect(pdb.documents.map((document) => document.hashAlgorithm)).toEqual([
      'SHA-1',
      'SHA-1',
      'SHA-1',
    ]);
  });
});

describe('readEmbeddedPdb', () => {
  it('inflates the portable PDB an assembly embeds', () => {
    const embedded = readEmbeddedPdb(fixture(STREAM_DLL));
    const pdb = readPortablePdb(embedded!);

    expect(pdb.documents.map((document) => document.name)).toEqual([
      '/_/src/EventArgs.cs',
      '/_/src/Events.cs',
      '/_/src/Properties/AssemblyInfo.cs',
      '/_/src/RecyclableMemoryStream.cs',
      '/_/src/RecyclableMemoryStreamManager.cs',
      '/_/src/obj/Release/netstandard2.1/.NETStandard,Version=v2.1.AssemblyAttributes.cs',
    ]);
    expect(pdb.documents[0]).toEqual({
      name: '/_/src/EventArgs.cs',
      hashAlgorithm: 'SHA-256',
      // The SHA-256 of EventArgs.cs at the linked commit, checked out with CRLF line endings.
      hash: 'c403ea6864c655117d9022bcb62fb15626c4bfbb98b8c385521efd3f28e3d39d',
    });
    expect(JSON.parse(pdb.sourceLink!)).toEqual({
      documents: {
        '/_/*':
          'https://raw.githubusercontent.com/microsoft/Microsoft.IO.RecyclableMemoryStream/2e75ee13b803d8c4166bc80b12acd71de37f7722/*',
      },
    });
  });

  it('returns null for an assembly that embeds no PDB', () => {
    const [assembly] = readZipEntries(fixture(STREAM_NUPKG)).filter((entry) =>
      entry.name.endsWith('net45/Microsoft.IO.RecyclableMemoryStream.dll'),
    );
    expect(readEmbeddedPdb(assembly!.read())).toBeNull();
  });
});

describe('Source Link', () => {
  const entries = parseSourceLink(
    JSON.stringify({
      documents: {
        'C:\\src\\*': 'https://example.test/repo/*',
        'C:\\src\\vendor\\*': 'https://example.test/vendor/*?raw=1',
        'C:\\src\\Exact.cs': 'https://example.test/exact',
      },
    }),
  );

  it('maps a path below a prefix, joining its segments with slashes', () => {
    expect(sourceLinkUrl(entries, 'C:\\src\\lib\\Guard.cs')).toBe(
      'https://example.test/repo/lib/Guard.cs',
    );
  });

  it('lets the most specific entry win', () => {
    expect(sourceLinkUrl(entries, 'C:\\src\\vendor\\a.cs')).toBe(
      'https://example.test/vendor/a.cs?raw=1',
    );
    expect(sourceLinkUrl(entries, 'C:\\src\\Exact.cs')).toBe('https://example.test/exact');
  });

  it('matches case-insensitively and escapes each path segment', () => {
    expect(sourceLinkUrl(entries, 'c:\\SRC\\my dir\\a(1).cs')).toBe(
      'https://example.test/repo/my%20dir/a%281%29.cs',
    );
  });

  it('returns null for a path no entry maps', () => {
    expect(sourceLinkUrl(entries, 'D:\\other\\a.cs')).toBeNull();
  });

  it.each([
    ['not JSON', '{'],
    ['not an object', '[]'],
    ['documents not an object', '{"documents":"x"}'],
    ['a star inside the path', '{"documents":{"a*b":"https://x/*"}}'],
    ['a star in the URL only', '{"documents":{"a/":"https://x/*"}}'],
    ['two stars in the URL', '{"documents":{"a/*":"https://x/*/*"}}'],
    ['a URL that is not a string', '{"documents":{"a/*":1}}'],
  ])('refuses Source Link JSON with %s', (_name, json) => {
    expect(() => parseSourceLink(json)).toThrow(PdbFormatError);
  });
});

describe('readPackagePdbs', () => {
  it('reads every standalone PDB in a package and skips assemblies without one', () => {
    const pdbs = readPackagePdbs(STREAM_NUPKG, fixture(STREAM_NUPKG));

    expect(pdbs.map((pdb) => [pdb.entry, pdb.embedded])).toEqual([
      ['lib/net40/Microsoft.IO.RecyclableMemoryStream.pdb', false],
      ['lib/net45/Microsoft.IO.RecyclableMemoryStream.pdb', false],
      ['lib/netstandard1.4/Microsoft.IO.RecyclableMemoryStream.pdb', false],
    ]);
    expect(pdbs[0]!.documents[0]).toEqual({
      name: 'E:\\agent\\_work\\1\\s\\src\\Events.cs',
      hashAlgorithm: 'SHA-1',
      hash: '44ac239cb40dd88f2b00cb8923427c63c0b6300d',
      sourceLinkUrl: null,
    });
  });

  it('resolves each document of an embedded PDB to its Source Link URL', () => {
    const [pdb] = readPackagePdbs(STREAM_DLL, fixture(STREAM_DLL));

    expect(pdb!.embedded).toBe(true);
    expect(pdb!.documents[0]!.sourceLinkUrl).toBe(
      'https://raw.githubusercontent.com/microsoft/Microsoft.IO.RecyclableMemoryStream/2e75ee13b803d8c4166bc80b12acd71de37f7722/src/EventArgs.cs',
    );
  });

  it('reads a standalone PDB given on its own', () => {
    const [pdb] = readPackagePdbs(TOOLKIT_PDB, fixture(TOOLKIT_PDB));
    expect(pdb!.embedded).toBe(false);
    expect(pdb!.documents.every((document) => document.sourceLinkUrl !== null)).toBe(true);
  });
});

/** A small deterministic random generator, so every run mutates the same bytes. */
function seededRandom(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32;
  };
}

describe('malformed input', () => {
  it.each([
    ['empty input', new Uint8Array(0), /metadata signature/],
    ['random text', Buffer.from('not a pdb at all, just text'), /not a portable PDB/],
    [
      'a Windows PDB',
      Buffer.from('Microsoft C/C++ MSF 7.00\r\n\x1aDS\0\0\0', 'latin1'),
      /Windows PDB, not a portable PDB/,
    ],
    ['a truncated PDB', fixture(GUARD_CLAUSES_PDB).subarray(0, 600), /lies outside the data/],
  ])('fails with a clear error for %s', (_name, bytes, message) => {
    expect(() => readPortablePdb(bytes)).toThrow(PdbFormatError);
    expect(() => readPortablePdb(bytes)).toThrow(message);
  });

  it('fails with a clear error for a truncated assembly', () => {
    expect(() => readEmbeddedPdb(fixture(STREAM_DLL).subarray(0, 300))).toThrow(PdbFormatError);
  });

  it('fails with a clear error for corrupt embedded PDB data', () => {
    const assembly = Buffer.from(fixture(STREAM_DLL));
    const signature = assembly.indexOf(Buffer.from('MPDB', 'latin1'));
    assembly.fill(0xff, signature + 8, signature + 40);
    expect(() => readEmbeddedPdb(assembly)).toThrow(/embedded PDB: the compressed data is corrupt/);
  });

  it('refuses an embedded PDB that declares an implausible or wrong size', () => {
    const assembly = Buffer.from(fixture(STREAM_DLL));
    const signature = assembly.indexOf(Buffer.from('MPDB', 'latin1'));
    assembly.writeUInt32LE(0x7fffffff, signature + 4);
    expect(() => readEmbeddedPdb(assembly)).toThrow(/more than the 256 MiB/);
    assembly.writeUInt32LE(1000, signature + 4); // Smaller than the real PDB.
    expect(() => readEmbeddedPdb(assembly)).toThrow(/exceeds its declared 1000 bytes/);
  });

  it('names the package entry that is malformed', () => {
    const nupkg = Buffer.from(fixture(STREAM_NUPKG));
    expect(() => readPackagePdbs('x.nupkg', nupkg.subarray(0, nupkg.length - 30))).toThrow(
      /package: not a ZIP archive/,
    );
    expect(() => readPackagePdbs('notes.txt', Buffer.from('hello'))).toThrow(
      /notes\.txt: not a portable PDB/,
    );
  });

  it.each([GUARD_CLAUSES_PDB, TOOLKIT_PDB, STREAM_DLL, STREAM_NUPKG])(
    'never crashes or hangs on corrupted copies of %s',
    (name) => {
      const original = fixture(name);
      const random = seededRandom(original.length);
      for (let round = 0; round < 200; round++) {
        const bytes = Buffer.from(original);
        const flips = 1 + Math.floor(random() * 8);
        for (let flip = 0; flip < flips; flip++) {
          bytes[Math.floor(random() * bytes.length)] = Math.floor(random() * 256);
        }
        const length = random() < 0.25 ? Math.floor(random() * bytes.length) : bytes.length;
        try {
          readPackagePdbs(name, bytes.subarray(0, length));
        } catch (error) {
          expect(error).toBeInstanceOf(PdbFormatError);
        }
      }
    },
  );
});
