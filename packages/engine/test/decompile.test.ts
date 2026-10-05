import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { removeCopy } from '../src/cache.js';
import { decompileNuGetLibrary, findDecompiler, isolatedCommand, runIsolated, type RunIsolated } from '../src/decompile.js';
import type { NuGetPin } from '../src/nuget-fetch.js';
import { readZipEntries } from '../src/zip.js';
import { OLD_NUGET_PACKAGE as OLD_PACKAGE, recordedFetch, relicensed, temporaryCacheDir } from './helpers.js';

const ID = 'microsoft.io.recyclablememorystream';
const NUPKG = `https://api.nuget.org/v3-flatcontainer/${ID}/1.2.2/${ID}.1.2.2.nupkg`;

const pinOf = (bytes: Buffer): NuGetPin => ({
  ecosystem: 'NuGet',
  name: 'Microsoft.IO.RecyclableMemoryStream',
  version: '1.2.2',
  pinnedBy: 'packages.lock.json',
  contentHash: createHash('sha512').update(bytes).digest('base64'),
});

/** A folder holding a runnable `ilspycmd`, as the reviewer's install leaves it; the stub runner below never starts it. */
function installedDecompiler(): string {
  const dir = mkdtempSync(join(tmpdir(), 'second-look-tools-'));
  writeFileSync(join(dir, 'ilspycmd'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  return dir;
}

/** A decompiler run that writes `files` into the folder its `--outputdir` names, with a project file and a link it must leave out. */
function stubDecompiler(files: Record<string, string>, code = 0) {
  const runs: { argv: string[]; cwd: string; input: Buffer }[] = [];
  const run: RunIsolated = async (argv, cwd) => {
    const output = argv[argv.indexOf('--outputdir') + 1]!;
    runs.push({ argv: [...argv], cwd, input: readFileSync(argv[argv.indexOf('--project') - 1]!) });
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(dirname(join(output, path)), { recursive: true });
      writeFileSync(join(output, path), content);
    }
    writeFileSync(join(output, 'Microsoft.IO.RecyclableMemoryStream.csproj'), '<Project />');
    symlinkSync('/etc/hosts', join(output, 'Hosts.cs'));
    return { code, output: code === 0 ? '' : 'Unhandled exception: BadImageFormatException' };
  };
  return { run, runs };
}

const DECOMPILED = { 'Microsoft/IO/RecyclableMemoryStream.cs': 'namespace Microsoft.IO\n{\n\tpublic sealed class RecyclableMemoryStream : MemoryStream\n\t{\n\t}\n}\n' };

let cacheDir: string;
let librariesDir: string;

beforeEach(() => {
  cacheDir = temporaryCacheDir();
  librariesDir = join(cacheDir, 'libraries');
});

afterEach(async () => {
  await removeCopy(cacheDir);
});

describe('isolatedCommand', () => {
  it("cuts the network with macOS's sandbox or a Linux network namespace, and refuses any other system", () => {
    expect(isolatedCommand(['/tools/ilspycmd', 'in.dll'], 'darwin')).toEqual(['/usr/bin/sandbox-exec', '-p', '(version 1)(allow default)(deny network*)', '/tools/ilspycmd', 'in.dll']);
    expect(isolatedCommand(['/tools/ilspycmd', 'in.dll'], 'linux')).toEqual(['/usr/bin/unshare', '--user', '--map-root-user', '--net', '--', '/tools/ilspycmd', 'in.dll']);
    expect(isolatedCommand(['ilspycmd.exe'], 'win32')).toBeUndefined();
  });
});

describe('findDecompiler', () => {
  it('finds ilspycmd in the first folder holding it as a runnable file, and nothing where none does', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'second-look-tools-'));
    const notRunnable = mkdtempSync(join(tmpdir(), 'second-look-tools-'));
    writeFileSync(join(notRunnable, 'ilspycmd'), '');
    chmodSync(join(notRunnable, 'ilspycmd'), 0o644);
    const installed = installedDecompiler();

    expect(await findDecompiler([empty, notRunnable, installed], 'linux')).toBe(join(installed, 'ilspycmd'));
    expect(await findDecompiler([empty, notRunnable], 'linux')).toBeUndefined();
  });
});

describe('runIsolated', () => {
  it('gives the exit code and the tail of what the program printed', async () => {
    const result = await runIsolated([process.execPath, '-e', 'console.log("out"); console.error("boom"); process.exit(3)'], tmpdir());

    expect(result.code).toBe(3);
    expect(result.output).toContain('out');
    expect(result.output).toContain('boom');
  });
});

describe('decompileNuGetLibrary', () => {
  it("runs the installed decompiler with no network on the package's assemblies alone, keeping only its C# read-only and labelled decompiled", async () => {
    const PACKAGE = relicensed('<license type="expression">MIT</license>');
    const tools = installedDecompiler();
    const decompiler = stubDecompiler(DECOMPILED);
    const transport = recordedFetch({ [NUPKG]: PACKAGE });

    const landed = await decompileNuGetLibrary(pinOf(PACKAGE), { librariesDir, fetch: transport.fetch, decompilerDirs: [tools], runIsolated: decompiler.run, platform: 'linux' });

    const hash = createHash('sha512').update(PACKAGE).digest('hex');
    expect(landed).toEqual({
      file: `${ID}.1.2.2.nupkg`,
      sha256: createHash('sha256').update(PACKAGE).digest('hex'),
      archive: 'decompiled NuGet package',
      note:
        `Decompiled, not the library's source: ilspycmd turned Microsoft.IO.RecyclableMemoryStream.dll (lib/netstandard1.4) of ${ID}.1.2.2.nupkg, its SHA-512 checked, back into C# with no network, ` +
        "because Microsoft.IO.RecyclableMemoryStream 1.2.2 has no exact source and its licence at version 1.2.2, MIT, allows decompiling it. Names, comments and layout are the decompiler's; nothing was built or run.",
      path: join(librariesDir, `${ID}-1.2.2-${hash.slice(0, 12)}-decompiled`),
      reused: false,
    });
    // One run, on the newest target framework's assembly written under a name of the companion's own.
    const netstandard = readZipEntries(OLD_PACKAGE).find((entry) => entry.name === 'lib/netstandard1.4/Microsoft.IO.RecyclableMemoryStream.dll')!.read();
    expect(decompiler.runs).toHaveLength(1);
    expect(decompiler.runs[0]!.argv).toEqual([
      '/usr/bin/unshare',
      '--user',
      '--map-root-user',
      '--net',
      '--',
      join(tools, 'ilspycmd'),
      join(decompiler.runs[0]!.cwd, 'in', '0.dll'),
      '--project',
      '--outputdir',
      join(decompiler.runs[0]!.cwd, 'out', '0'),
      '--disable-updatecheck',
    ]);
    expect(Buffer.compare(decompiler.runs[0]!.input, Buffer.from(netstandard))).toBe(0);
    // Only the C# lands, read-only; the project file and the link are left out, and the scratch folder is gone.
    const file = join(landed.path, 'Microsoft.IO.RecyclableMemoryStream', 'Microsoft', 'IO', 'RecyclableMemoryStream.cs');
    expect(readFileSync(file, 'utf8')).toBe(DECOMPILED['Microsoft/IO/RecyclableMemoryStream.cs']);
    expect(statSync(file).mode & 0o222).toBe(0);
    expect(readdirSync(join(landed.path, 'Microsoft.IO.RecyclableMemoryStream'))).toEqual(['Microsoft']);
    expect(readdirSync(librariesDir).sort()).toEqual([`${ID}-1.2.2-${hash.slice(0, 12)}-decompiled`, `${ID}-1.2.2-${hash.slice(0, 12)}-decompiled.json`]);

    // A later decompile of the same package reuses it, running nothing.
    const again = await decompileNuGetLibrary(pinOf(PACKAGE), { librariesDir, fetch: transport.fetch, decompilerDirs: [tools], runIsolated: decompiler.run, platform: 'linux' });
    expect(again).toMatchObject({ path: landed.path, archive: 'decompiled NuGet package', reused: true });
    expect(decompiler.runs).toHaveLength(1);
  });

  it("checks the licence again in the downloaded package, and decompiles nothing a version's licence does not allow", async () => {
    for (const [licence, why] of [
      ['<license type="expression">BUSL-1.1</license>', 'its licence at version 1.2.2, BUSL-1.1, is not an open-source licence known to allow decompiling it'],
      ['<license type="file">EULA.txt</license>', 'its licence at version 1.2.2 is unknown: its nuspec gives it only as the file EULA.txt in the package, which the companion does not judge'],
    ] as const) {
      const PACKAGE = relicensed(licence);
      const decompiler = stubDecompiler(DECOMPILED);

      await expect(
        decompileNuGetLibrary(pinOf(PACKAGE), { librariesDir, fetch: recordedFetch({ [NUPKG]: PACKAGE }).fetch, decompilerDirs: [installedDecompiler()], runIsolated: decompiler.run, platform: 'linux' }),
      ).rejects.toThrow(`Microsoft.IO.RecyclableMemoryStream 1.2.2 is not decompiled: ${why}`);
      expect(decompiler.runs).toEqual([]);
    }
    expect(existsSync(librariesDir) ? readdirSync(librariesDir) : []).toEqual([]);
  });

  it('says plainly that no decompiler is installed, running nothing', async () => {
    const PACKAGE = relicensed('<license type="expression">MIT</license>');
    const decompiler = stubDecompiler(DECOMPILED);

    await expect(
      decompileNuGetLibrary(pinOf(PACKAGE), {
        librariesDir,
        fetch: recordedFetch({ [NUPKG]: PACKAGE }).fetch,
        decompilerDirs: [mkdtempSync(join(tmpdir(), 'second-look-tools-'))],
        runIsolated: decompiler.run,
        platform: 'linux',
      }),
    ).rejects.toThrow(
      "no decompiler is installed: the companion decompiles with ILSpy's ilspycmd, which it found neither on the PATH nor in ~/.dotnet/tools; " +
        'install it with `dotnet tool install --global ilspycmd` and press the decompile again. Nothing was decompiled',
    );
    expect(decompiler.runs).toEqual([]);
    expect(existsSync(librariesDir) ? readdirSync(librariesDir) : []).toEqual([]);
  });

  it("decompiles nothing on a system whose network it cannot cut, saying so even when no decompiler is installed", async () => {
    const PACKAGE = relicensed('<license type="expression">MIT</license>');
    const decompiler = stubDecompiler(DECOMPILED);

    await expect(
      decompileNuGetLibrary(pinOf(PACKAGE), {
        librariesDir,
        fetch: recordedFetch({ [NUPKG]: PACKAGE }).fetch,
        decompilerDirs: [mkdtempSync(join(tmpdir(), 'second-look-tools-'))],
        runIsolated: decompiler.run,
        platform: 'freebsd',
      }),
    ).rejects.toThrow("the companion cannot cut the decompiler's network on freebsd, so nothing was decompiled");
    expect(decompiler.runs).toEqual([]);
  });

  it('refuses the C# the decompiler wrote past the byte cap, before reading it all', async () => {
    const PACKAGE = relicensed('<license type="expression">MIT</license>');
    const run: RunIsolated = async (argv) => {
      const output = argv[argv.indexOf('--outputdir') + 1]!;
      const huge = join(output, 'Huge.cs');
      mkdirSync(output, { recursive: true });
      writeFileSync(huge, '');
      truncateSync(huge, 1024 * 1024 * 1024 + 1);
      return { code: 0, output: '' };
    };

    await expect(
      decompileNuGetLibrary(pinOf(PACKAGE), { librariesDir, fetch: recordedFetch({ [NUPKG]: PACKAGE }).fetch, decompilerDirs: [installedDecompiler()], runIsolated: run, platform: 'linux' }),
    ).rejects.toThrow('the decompiler wrote more than the 1024 MiB of C# a decompile keeps');
  });

  it('reports a failed decompiler run with what it printed, and keeps nothing', async () => {
    const PACKAGE = relicensed('<license type="expression">MIT</license>');
    const decompiler = stubDecompiler(DECOMPILED, 134);

    await expect(
      decompileNuGetLibrary(pinOf(PACKAGE), { librariesDir, fetch: recordedFetch({ [NUPKG]: PACKAGE }).fetch, decompilerDirs: [installedDecompiler()], runIsolated: decompiler.run, platform: 'darwin' }),
    ).rejects.toThrow(
      'ilspycmd failed on Microsoft.IO.RecyclableMemoryStream.dll of Microsoft.IO.RecyclableMemoryStream 1.2.2 (exit code 134): Unhandled exception: BadImageFormatException; nothing was decompiled',
    );
    expect(decompiler.runs[0]!.argv.slice(0, 3)).toEqual(['/usr/bin/sandbox-exec', '-p', '(version 1)(allow default)(deny network*)']);
    expect(readdirSync(librariesDir)).toEqual([]);
  });
});
