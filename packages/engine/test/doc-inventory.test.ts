import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { deflateSync, gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import {
  frameworkMoniker,
  packageMonikers,
  parseSphinxInventory,
  scanXrefMap,
  sphinxVersionMatches,
  xrefLink,
} from '../src/doc-inventory.js';

function recorded(name: string): Buffer {
  return readFileSync(fileURLToPath(new URL(`./fixtures/docs/${name}`, import.meta.url)));
}

/** Streams bytes in chunks of `size`, as a download arrives. */
async function* inChunks(bytes: Buffer, size: number): AsyncGenerator<Uint8Array> {
  for (let at = 0; at < bytes.length; at += size) yield bytes.subarray(at, at + size);
}

function sphinxInventory(version: string, lines: string[]): Buffer {
  const header = ['# Sphinx inventory version 2', '# Project: example', `# Version: ${version}`, '# The remainder of this file is compressed using zlib.', ''].join('\n');
  return Buffer.concat([Buffer.from(header), deflateSync(Buffer.from(lines.join('\n')))]);
}

describe('parseSphinxInventory', () => {
  it('reads the recorded attrs 23.1.0 inventory: its project, its version and its Python objects', () => {
    const inventory = parseSphinxInventory(recorded('attrs-23.1.0-objects.inv'));
    expect(inventory.project).toBe('attrs');
    expect(inventory.version).toBe('23.1');
    expect(inventory.objects.get('attrs.define')).toEqual({ role: 'py:function', uri: 'api.html#attrs.define' });
    expect(inventory.objects.get('attr.Attribute')).toEqual({ role: 'py:class', uri: 'api-attr.html#attr.Attribute' });
    expect(inventory.objects.get('attr')).toEqual({ role: 'py:module', uri: 'api-attr.html#module-attr' });
  });

  it('reads the version the stable inventory documents, which is not 23.1', () => {
    expect(parseSphinxInventory(recorded('attrs-stable-objects.inv')).version).toBe('26.1');
  });

  it('keeps the Python domain only, a name with spaces, and the first of a name given twice', () => {
    const inventory = parseSphinxInventory(
      sphinxInventory('1.0', [
        'example.run py:function 1 api.html#$ -',
        'example.run py:method 1 other.html#$ -',
        'getting started std:label -1 start.html#getting-started Getting started',
        'example.Thing std:doc -1 thing.html -',
      ]),
    );
    expect([...inventory.objects.keys()]).toEqual(['example.run']);
    expect(inventory.objects.get('example.run')!.uri).toBe('api.html#example.run');
  });

  it('refuses anything but a version 2 inventory, and a body that inflates past the cap', () => {
    expect(() => parseSphinxInventory(Buffer.from('<html>not found</html>\n\n\n\n'))).toThrow(/not a Sphinx inventory version 2/);
    expect(() => parseSphinxInventory(Buffer.from('# Sphinx inventory version 2\n'))).toThrow(/header ends early/);
    const large = sphinxInventory('1.0', Array.from({ length: 2000 }, (_, index) => `example.name${index} py:function 1 api.html#$ -`));
    expect(() => parseSphinxInventory(large, 1024)).toThrow(/cannot be read/);
  });
});

describe('sphinxVersionMatches', () => {
  it.each([
    ['23.1', '23.1.0', true],
    ['23.1.0', '23.1.0', true],
    ['0.27', '0.27.2', true],
    ['8.1.x', '8.1.7', true],
    ['v2.0.7', '2.0.7', true],
    ['2.0', '2', true],
    ['26.1', '23.1.0', false],
    ['8.5.x', '8.1.7', false],
    ['23.1.1', '23.1.0', false],
    ['23', '23.1.0', false],
    ['latest', '23.1.0', false],
    ['', '23.1.0', false],
    ['2.0.0rc1', '2.0.0rc1', true],
    ['2.0.0rc1', '2.0.0', false],
    ['2.0.0.dev0', '2.0.0', false],
  ])('an inventory of %s documents %s: %s', (documented, pinned, matches) => {
    expect(sphinxVersionMatches(documented, pinned)).toBe(matches);
  });
});

describe('scanXrefMap', () => {
  const map = gunzipSync(recorded('dotnet-xrefmap-excerpt.json.gz'));

  it('keeps only the wanted entries of the recorded map, read in small chunks', async () => {
    const found = await scanXrefMap(inChunks(map, 97), new Set(['System.IO.Stream', 'System.IO.Stream.CopyTo*', 'System.Missing']));
    expect([...found.keys()].sort()).toEqual(['System.IO.Stream', 'System.IO.Stream.CopyTo*']);
    const stream = found.get('System.IO.Stream')!;
    expect(stream.href).toBe('https://learn.microsoft.com/dotnet/api/system.io.stream');
    expect(stream.monikers).toContain('net-8.0');
  });

  it('reads braces and quotes inside strings as text, and refuses an entry larger than any real one', async () => {
    const text = JSON.stringify({
      references: [
        { uid: 'A.B', href: 'https://learn.microsoft.com/dotnet/api/a.b', summary: '{ "uid": "C.D" } [', monikers: ['net-8.0'] },
        { uid: 'C.D', href: 'https://learn.microsoft.com/dotnet/api/c.d', monikers: [] },
      ],
      moniker_groups: { g: ['net-8.0'] },
    });
    const found = await scanXrefMap(inChunks(Buffer.from(text), 5), new Set(['A.B', 'C.D']));
    expect(found.get('A.B')!.href).toBe('https://learn.microsoft.com/dotnet/api/a.b');
    expect(found.get('C.D')!.monikers).toEqual([]);
    const huge = JSON.stringify({ references: [{ uid: 'A.B', href: 'https://learn.microsoft.com/a', summary: 'x'.repeat(2 * 1024 * 1024) }] });
    await expect(scanXrefMap(inChunks(Buffer.from(huge), 64 * 1024), new Set(['A.B']))).rejects.toThrow(/larger than any real one/);
  });

  it('skips an entry whose link is not https', async () => {
    const text = JSON.stringify({ references: [{ uid: 'A.B', href: 'http://learn.microsoft.com/a', monikers: [] }] });
    expect((await scanXrefMap(inChunks(Buffer.from(text), 8), new Set(['A.B']))).size).toBe(0);
  });
});

describe('.NET version matching', () => {
  it.each([
    ['net8.0', 'net-8.0'],
    ['net8.0-windows', 'net-8.0'],
    ['net10.0', 'net-10.0'],
    ['netcoreapp3.1', 'netcore-3.1'],
    ['netstandard2.0', 'netstandard-2.0'],
    ['net48', 'netframework-4.8'],
    ['net472', 'netframework-4.7.2'],
    ['net4.0', undefined],
    ['monoandroid', undefined],
  ])('the target framework %s is documented as %s', (framework, moniker) => {
    expect(frameworkMoniker(framework)).toBe(moniker);
  });

  it('looks for a package version in its .NET version package documentation, then the framework, and not for a version .NET never had', () => {
    expect(packageMonikers('10.0.1')).toEqual(['net-10.0-pp', 'net-10.0']);
    expect(packageMonikers('3.0.1')).toEqual([]);
  });

  it('links an entry at the first wanted version it is documented in, and not at all when it is in none', async () => {
    const found = await scanXrefMap(inChunks(gunzipSync(recorded('dotnet-xrefmap-excerpt.json.gz')), 4096), new Set(['System.IO.MemoryStream.GetBuffer*', 'Microsoft.Extensions.Logging.ILogger']));
    const getBuffer = found.get('System.IO.MemoryStream.GetBuffer*')!;
    expect(xrefLink(getBuffer, ['net-8.0'])).toBe('https://learn.microsoft.com/dotnet/api/system.io.memorystream.getbuffer?view=net-8.0');
    const logger = found.get('Microsoft.Extensions.Logging.ILogger')!;
    expect(xrefLink(logger, packageMonikers('8.0.1'))).toBeUndefined();
    expect(xrefLink(logger, packageMonikers('10.0.0'))).toBe('https://learn.microsoft.com/dotnet/api/microsoft.extensions.logging.ilogger?view=net-10.0-pp');
  });
});
