import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { access, constants, lstat, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import { trackAgentChild } from './agent-children.js';
import { writeReadOnlyFiles } from './archive.js';
import { removeCopy } from './cache.js';
import { folderName, landLibrary } from './ecosystem-fetch.js';
import type { LibraryDownload, LibraryFetchOptions } from './library-fetch.js';
import { downloadNuGetPackage, nugetPackage, type NuGetPin } from './nuget-fetch.js';
import { readZipEntries } from './zip.js';

/**
 * The decompiled fallback of the .NET library fetch: when a pinned
 * package has no exact source and its own licence at that version allows
 * it (see `nuget-licence.ts`), the reviewer may have the companion
 * decompile it. The companion, never the agent, downloads the exact
 * package and checks its SHA-512, writes its assemblies under names of
 * its own, and runs the one decompiler it knows — ILSpy's `ilspycmd`, as
 * the reviewer installed it — on them alone, with the network cut by the
 * operating system's sandbox. Nothing in the package decides which
 * program runs or how. The C# it writes lands read-only beside the other
 * fetched libraries, labelled decompiled, and is never built or run.
 */

/** The one decompiler the companion runs, by its program name. */
export const DECOMPILER = 'ilspycmd';

/** How the reviewer installs it, as a missing decompiler's message says. */
const INSTALL_HINT = 'dotnet tool install --global ilspycmd';

/** What one decompiler run may take before it is stopped. */
const DECOMPILE_TIMEOUT_MS = 5 * 60 * 1000;

/** The most assemblies one package's decompile runs on, the largest one, and what the C# it writes may take together. */
const MAX_ASSEMBLIES = 32;
const MAX_ASSEMBLY_BYTES = 64 * 1024 * 1024;
const MAX_DECOMPILED_BYTES = 1024 * 1024 * 1024;
const MAX_DECOMPILED_FILES = 5000;

/** Runs a command with no network in `cwd`, and gives its exit code and the tail of what it printed. */
export type RunIsolated = (argv: readonly string[], cwd: string) => Promise<{ code: number | null; output: string }>;

export interface DecompileOptions extends LibraryFetchOptions {
  /** The folders the decompiler is looked for in: the PATH's and `~/.dotnet/tools` when omitted. */
  decompilerDirs?: readonly string[];
  /** Runs the decompiler; tests inject a stub so no test starts a process. */
  runIsolated?: RunIsolated;
  /** The operating system whose sandbox cuts the network; the engine's own when omitted. */
  platform?: NodeJS.Platform;
}

/** The folders the reviewer's installed programs are in: the PATH's, then .NET's global tools folder. */
function installedProgramDirs(): string[] {
  return [...(process.env['PATH'] ?? '').split(delimiter).filter((dir) => dir !== ''), join(homedir(), '.dotnet', 'tools')];
}

/** The decompiler's absolute path in the first folder that holds it as a runnable file; undefined when none does. */
export async function findDecompiler(dirs: readonly string[] = installedProgramDirs(), platform: NodeJS.Platform = process.platform): Promise<string | undefined> {
  const name = platform === 'win32' ? `${DECOMPILER}.exe` : DECOMPILER;
  for (const dir of dirs) {
    const path = join(dir, name);
    const runnable = await stat(path).then(
      async (found) => found.isFile() && (await access(path, constants.X_OK).then(() => true, () => false)),
      () => false,
    );
    if (runnable) return path;
  }
  return undefined;
}

/** The sandbox profile that denies every network operation and allows the rest. */
const NO_NETWORK_PROFILE = '(version 1)(allow default)(deny network*)';

/**
 * The command that runs `argv` with the network cut: under macOS's
 * sandbox with a profile that denies every network operation, or on
 * Linux in a new network namespace that holds no interface but an
 * unconfigured loopback; undefined on a system the companion cannot cut
 * the network on, where nothing is decompiled.
 */
export function isolatedCommand(argv: readonly string[], platform: NodeJS.Platform): string[] | undefined {
  if (platform === 'darwin') return ['/usr/bin/sandbox-exec', '-p', NO_NETWORK_PROFILE, ...argv];
  if (platform === 'linux') return ['/usr/bin/unshare', '--user', '--map-root-user', '--net', '--', ...argv];
  return undefined;
}

/** Runs a command, stopped after {@link DECOMPILE_TIMEOUT_MS}, keeping the last few KiB of its output; the decompiler wants no telemetry, logo or diagnostics port. */
export const runIsolated: RunIsolated = (argv, cwd) =>
  new Promise((resolve, reject) => {
    const env = { ...process.env, DOTNET_CLI_TELEMETRY_OPTOUT: '1', DOTNET_NOLOGO: '1', DOTNET_EnableDiagnostics: '0' };
    const child = trackAgentChild(spawn(argv[0]!, argv.slice(1), { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], timeout: DECOMPILE_TIMEOUT_MS, killSignal: 'SIGKILL' }));
    let output = '';
    const keep = (chunk: Buffer): void => {
      output = (output + chunk.toString('utf8')).slice(-4000);
    };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, output: signal === null ? output : `${output}\n(stopped by ${signal})` }));
  });

/** Orders target framework folders newest .NET first, then .NET Standard, .NET Core, .NET Framework, then any other. */
function frameworkRank(framework: string): [number, number] {
  const name = framework.toLowerCase();
  const [, major = '0', minor = '0'] = /(\d+)\.(\d+)/.exec(name) ?? [];
  const version = Number(major) * 100 + Number(minor);
  if (/^net\d+\.\d+/.test(name)) return [0, -version];
  if (name.startsWith('netstandard')) return [1, -version];
  if (name.startsWith('netcoreapp')) return [2, -version];
  if (/^net\d+$/.test(name)) return [3, -Number(name.slice(3).padEnd(3, '0'))];
  return [4, 0];
}

/** The assemblies of the package's one best target framework folder under `lib/`, by their file name. */
function chooseAssemblies(bytes: Uint8Array): { framework: string; assemblies: { name: string; bytes: Uint8Array }[] } | undefined {
  const byFramework = new Map<string, ReturnType<typeof readZipEntries>>();
  for (const entry of readZipEntries(bytes)) {
    const match = /^lib\/([^/]+)\/([^/]+\.dll)$/i.exec(entry.name);
    if (match) byFramework.set(match[1]!, [...(byFramework.get(match[1]!) ?? []), entry]);
  }
  const [framework] = [...byFramework.keys()].sort((a, b) => {
    const [rankA, rankB] = [frameworkRank(a), frameworkRank(b)];
    return rankA[0] - rankB[0] || rankA[1] - rankB[1] || a.localeCompare(b);
  });
  if (framework === undefined) return undefined;
  const entries = byFramework.get(framework)!;
  if (entries.length > MAX_ASSEMBLIES) throw new Error(`its lib/${framework} folder holds ${entries.length} assemblies, more than the ${MAX_ASSEMBLIES} a decompile runs on`);
  return {
    framework,
    assemblies: entries.map((entry) => {
      if (entry.size > MAX_ASSEMBLY_BYTES) throw new Error(`${entry.name} is larger than the ${MAX_ASSEMBLY_BYTES / 1024 / 1024} MiB a decompile runs on`);
      return { name: entry.name.slice(entry.name.lastIndexOf('/') + 1), bytes: entry.read() };
    }),
  };
}

/** The C# files the decompiler wrote under `dir`, regular files only, by their path under it. */
async function decompiledFiles(dir: string, prefix: string, into: { path: string; content: Uint8Array }[]): Promise<void> {
  for (const entry of await readdir(dir)) {
    const path = join(dir, entry);
    const info = await lstat(path);
    if (info.isDirectory()) await decompiledFiles(path, `${prefix}${entry}/`, into);
    else if (info.isFile() && entry.toLowerCase().endsWith('.cs')) {
      if (into.length >= MAX_DECOMPILED_FILES) throw new Error(`the decompiler wrote more than the ${MAX_DECOMPILED_FILES} files a decompile keeps`);
      into.push({ path: `${prefix}${entry}`, content: await readFile(path) });
    }
  }
}

/**
 * Decompiles one pinned .NET library the reviewer asked to: downloads the
 * exact package from nuget.org and checks its SHA-512, checks again that
 * its own licence at that version allows decompiling it, and runs the
 * reviewer's installed decompiler, with no network, on the assemblies of
 * its best target framework, each written under a name of the
 * companion's own. The C# it writes is kept read-only in its own folder
 * of the library cache, labelled decompiled, never built or run; a later
 * decompile of the same package reuses it. Throws, saying why, when the
 * licence does not allow it, no decompiler is installed, the network
 * cannot be cut on this system, or the decompiler fails.
 */
export async function decompileNuGetLibrary(pin: NuGetPin, options: DecompileOptions): Promise<LibraryDownload> {
  const fetchFn = options.fetch ?? fetch;
  const nuget = await nugetPackage(pin, fetchFn);
  const { id, version, name, file, expected } = nuget;
  return landLibrary(options.librariesDir, `${id}-${version}-${expected.slice(0, 12)}-decompiled`, async () => {
    const platform = options.platform ?? process.platform;
    const { bytes, licence } = await downloadNuGetPackage(pin, nuget, fetchFn);
    if (licence.kind !== 'permissive') throw new Error(`${name} is not decompiled: ${licence.why}`);
    const decompiler = await findDecompiler(options.decompilerDirs, platform);
    if (decompiler === undefined) {
      throw new Error(
        `no decompiler is installed: the companion decompiles with ILSpy's ${DECOMPILER}, which it found neither on the PATH nor in ~/.dotnet/tools; ` +
          `install it with \`${INSTALL_HINT}\` and press the decompile again. Nothing was decompiled`,
      );
    }
    if (isolatedCommand([], platform) === undefined) throw new Error(`the companion cannot cut the decompiler's network on ${platform}, so nothing was decompiled`);
    const chosen = chooseAssemblies(bytes);
    if (chosen === undefined) throw new Error(`${file} holds no assembly under lib/ to decompile; nothing was decompiled`);

    const scratch = join(options.librariesDir, `.decompile-${randomBytes(6).toString('hex')}`);
    const files: { path: string; content: Uint8Array }[] = [];
    try {
      for (const [index, assembly] of chosen.assemblies.entries()) {
        const input = join(scratch, 'in', `${index}.dll`);
        const output = join(scratch, 'out', `${index}`);
        await mkdir(output, { recursive: true });
        await mkdir(join(scratch, 'in'), { recursive: true });
        await writeFile(input, assembly.bytes, { mode: 0o444 });
        const argv = isolatedCommand([decompiler, input, '--project', '--outputdir', output, '--disable-updatecheck'], platform)!;
        const run = await (options.runIsolated ?? runIsolated)(argv, scratch);
        if (run.code !== 0) throw new Error(`${DECOMPILER} failed on ${assembly.name} of ${name} (exit code ${run.code}): ${run.output.trim() || 'it printed nothing'}; nothing was decompiled`);
        await decompiledFiles(output, `${folderName(assembly.name.replace(/\.dll$/i, ''))}/`, files);
      }
    } finally {
      await removeCopy(scratch);
    }
    if (files.length === 0) throw new Error(`${DECOMPILER} wrote no C# for ${name}; nothing was decompiled`);
    const assemblies = chosen.assemblies.map((assembly) => assembly.name).join(', ');
    return {
      landed: {
        file,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        archive: 'decompiled NuGet package',
        note:
          `Decompiled, not the library's source: ${DECOMPILER} turned ${assemblies} (lib/${chosen.framework}) of ${file}, its SHA-512 checked, back into C# with no network, ` +
          `because ${name} has no exact source and ${licence.why}. Names, comments and layout are the decompiler's; nothing was built or run.`,
      },
      write: (dir) => writeReadOnlyFiles(files, dir, { maxBytes: MAX_DECOMPILED_BYTES }),
    };
  });
}
