import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { writeReadOnlyFiles } from './archive.js';
import { removeCopy } from './cache.js';
import type { LibraryDownload, LibraryFetchOptions } from './library-fetch.js';
import type { SourceDocument } from './pdb.js';
import { readPackagePdbs, type PackagePdb } from './symbols.js';
import { readZipEntries } from './zip.js';

/**
 * Library fetch for .NET (ADR 0003): the engine downloads the exact
 * package the project pins from nuget.org and checks its SHA-512 against
 * the lock file, or nuget.org's own record when only a project file pins
 * it. It reads the repository commit from the package's nuspec and its
 * PDB — in the package, embedded in an assembly, or from nuget.org's
 * symbol package — and fetches each source file the PDB names at that
 * commit, only from the host its Source Link names. A file is exact
 * source only when its bytes, as fetched or with LF or CRLF line
 * endings, match the hash the PDB records for it; any other is unproven,
 * and never makes a claim verified. Nothing is built, installed or run.
 */

/** One library as a .NET project pins it: in packages.lock.json, or a project file's package reference. */
export interface NuGetPin {
  ecosystem: 'NuGet';
  /** The package id as the project writes it. */
  name: string;
  version: string;
  /** The lock or project file, by its path in the head copy. */
  pinnedBy: string;
  /** The package's SHA-512, base64, as packages.lock.json records it; none for a project file's pin. */
  contentHash?: string;
}

const NUGET_API = 'https://api.nuget.org/v3';

/** A package id and a version as a URL or a folder name may hold them, with nothing that steers a path. */
const SAFE_ID = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/;
const SAFE_VERSION = /^[0-9][0-9A-Za-z.+-]*$/;

/** A version a project pins exactly: `1.2.3` (the lowest the range allows, which NuGet picks) or `[1.2.3]`. */
const EXACT_VERSION = /^\s*\[?\s*([0-9][0-9A-Za-z.+-]*)\s*\]?\s*$/;

/** The folders never searched for a pin: dependencies, build output and hidden folders. */
const SKIPPED_FOLDERS = new Set(['node_modules', 'bin', 'obj', 'packages']);

/** How deep and how wide the search for a .NET pin goes in the head copy. */
const MAX_SEARCH_DEPTH = 6;
const MAX_SEARCHED_FILES = 5000;

/** The files of the head copy that may pin a package: lock files first, then project files, each by path. */
async function pinFiles(root: string): Promise<string[]> {
  const locks: string[] = [];
  const projects: string[] = [];
  let seen = 0;
  let level = [''];
  for (let depth = 0; depth <= MAX_SEARCH_DEPTH && level.length > 0 && seen < MAX_SEARCHED_FILES; depth++) {
    const next: string[] = [];
    for (const folder of level) {
      const entries = await readdir(join(root, folder), { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        seen++;
        const path = folder === '' ? entry.name : `${folder}/${entry.name}`;
        // A symbolic link is neither a folder nor a file here, so none is followed.
        if (entry.isDirectory() && !entry.name.startsWith('.') && !SKIPPED_FOLDERS.has(entry.name.toLowerCase())) next.push(path);
        if (!entry.isFile()) continue;
        if (entry.name.toLowerCase() === 'packages.lock.json') locks.push(path);
        else if (/^directory\.packages\.props$|\.(?:cs|fs|vb)proj$/i.test(entry.name)) projects.push(path);
      }
    }
    level = next;
  }
  const byPath = (a: string, b: string): number => a.localeCompare(b);
  return [...locks.sort(byPath), ...projects.sort(byPath)];
}

/** The pin of one package in a packages.lock.json: the version it resolved and the SHA-512 it records. */
function lockPin(text: string, wanted: string, pinnedBy: string): NuGetPin | undefined {
  let root: unknown;
  try {
    root = JSON.parse(text);
  } catch {
    return undefined;
  }
  const frameworks = (root as { dependencies?: unknown } | null)?.dependencies;
  if (typeof frameworks !== 'object' || frameworks === null) return undefined;
  for (const packages of Object.values(frameworks)) {
    if (typeof packages !== 'object' || packages === null) continue;
    for (const [name, entry] of Object.entries(packages as Record<string, unknown>)) {
      const { resolved, contentHash, type } = (entry ?? {}) as { resolved?: unknown; contentHash?: unknown; type?: unknown };
      if (name.toLowerCase() !== wanted || type === 'Project' || typeof resolved !== 'string' || typeof contentHash !== 'string') continue;
      return { ecosystem: 'NuGet', name, version: resolved, pinnedBy, contentHash };
    }
  }
  return undefined;
}

/** One XML attribute's value from an element's attribute text. */
function attribute(attributes: string, name: string): string | undefined {
  return new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i').exec(attributes)?.slice(1).find((value) => value !== undefined);
}

/** The exact pin of one package in a project file or Directory.Packages.props: a reference with an exact version. */
function projectPin(text: string, wanted: string, pinnedBy: string): NuGetPin | undefined {
  const references = text.replace(/<!--[\s\S]*?-->/g, '').matchAll(/<(PackageReference|PackageVersion)\b([^>]*?)(?:\/>|>([\s\S]*?)<\/\1\s*>)/gi);
  for (const [, , attributes = '', body = ''] of references) {
    const name = attribute(attributes, 'Include') ?? attribute(attributes, 'Update');
    if (name?.trim().toLowerCase() !== wanted) continue;
    const declared = attribute(attributes, 'VersionOverride') ?? attribute(attributes, 'Version') ?? /<Version>([^<]*)<\/Version>/i.exec(body)?.[1];
    const version = declared === undefined ? undefined : EXACT_VERSION.exec(declared)?.[1];
    if (version !== undefined) return { ecosystem: 'NuGet', name: name.trim(), version, pinnedBy };
  }
  return undefined;
}

/**
 * The pin of one package in the head copy: the first packages.lock.json
 * that records it, else the first project file or Directory.Packages.props
 * that references it at one exact version; undefined when none does.
 */
export async function findNuGetPin(headRoot: string, library: string): Promise<NuGetPin | undefined> {
  const wanted = library.trim().toLowerCase();
  if (!SAFE_ID.test(wanted)) return undefined;
  for (const path of await pinFiles(headRoot)) {
    const text = await readFile(join(headRoot, ...path.split('/')), 'utf8').catch(() => '');
    const pin = path.toLowerCase().endsWith('packages.lock.json') ? lockPin(text, wanted, path) : projectPin(text, wanted, path);
    if (pin) return pin;
  }
  return undefined;
}

/** The largest package, symbol package or source file a fetch downloads; far above any real one. */
const MAX_DOWNLOAD_BYTES = 256 * 1024 * 1024;
const MAX_SOURCE_FILE_BYTES = 16 * 1024 * 1024;

/** What the source files of one package may take together, and how many it may name. */
const MAX_UNPACKED_BYTES = 1024 * 1024 * 1024;
const MAX_SOURCE_FILES = 5000;

/** How many source files download at once. */
const PARALLEL_DOWNLOADS = 8;

/** What one fetch's source-file downloads may buffer together, and what they have buffered so far. */
interface DownloadBudget {
  cap: number;
  buffered: number;
}

/**
 * Downloads one URL into memory, refusing one larger than `limit`; undefined
 * for a 404. What it buffers counts against `budget`, the bytes all of one
 * fetch's source files may take together, and it refuses once they exceed
 * it, before more is buffered.
 */
async function download(url: string, what: string, fetchFn: typeof fetch, limit = MAX_DOWNLOAD_BYTES, budget?: DownloadBudget): Promise<Buffer | undefined> {
  const response = await fetchFn(url, { redirect: 'error' });
  if (response.status === 404) return undefined;
  if (!response.ok || response.body === null) throw new Error(`the download of ${what} failed (HTTP ${response.status})`);
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of response.body as AsyncIterable<Uint8Array>) {
    size += chunk.length;
    if (size > limit) throw new Error(`${what} is larger than the ${limit / 1024 / 1024} MiB a library fetch downloads`);
    if (budget !== undefined && (budget.buffered += chunk.length) > budget.cap) {
      throw new Error(`the package's source files exceed the ${budget.cap / 1024 / 1024} MiB a library fetch downloads together`);
    }
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks, size);
}

/** Reads one nuget.org JSON document. */
async function nugetJson(url: string, what: string, fetchFn: typeof fetch): Promise<Record<string, unknown>> {
  const response = await fetchFn(url, { headers: { Accept: 'application/json' }, redirect: 'error' });
  if (!response.ok) throw new Error(`nuget.org has no ${what} (HTTP ${response.status})`);
  return (await response.json()) as Record<string, unknown>;
}

/**
 * The SHA-512 nuget.org records for a package, base64, for a pin that
 * records none itself: read from the package's catalog entry, found
 * through its registration, both on nuget.org's own API host.
 */
async function catalogHash(id: string, version: string, fetchFn: typeof fetch): Promise<string> {
  const what = `record of ${id} ${version}`;
  const leaf = await nugetJson(`${NUGET_API}/registration5-gz-semver2/${id}/${version}.json`, what, fetchFn);
  const entry = leaf['catalogEntry'];
  if (typeof entry !== 'string' || !entry.startsWith(`${NUGET_API}/catalog0/`)) throw new Error(`nuget.org's ${what} names no catalog entry`);
  const catalog = await nugetJson(entry, what, fetchFn);
  const hash = catalog['packageHash'];
  if (catalog['packageHashAlgorithm'] !== 'SHA512' || typeof hash !== 'string') throw new Error(`nuget.org's ${what} records no SHA-512`);
  return hash;
}

/**
 * The PDBs of the package's symbol package on nuget.org, or none when
 * nuget.org has no symbol package of it. nuget.org answers with a
 * redirect to its own download host; any other is refused.
 */
async function symbolPackagePdbs(id: string, version: string, fetchFn: typeof fetch): Promise<PackagePdb[]> {
  const response = await fetchFn(`https://www.nuget.org/api/v2/symbolpackage/${id}/${version}`, { redirect: 'manual' });
  if (response.status === 404) return [];
  const location = response.headers.get('location');
  const target = response.status >= 300 && response.status < 400 && location ? new URL(location, 'https://www.nuget.org/') : undefined;
  if (target === undefined || target.protocol !== 'https:' || !/(?:^|\.)nuget\.org$/.test(target.hostname)) {
    throw new Error(`nuget.org's symbol package of ${id} ${version} is not on nuget.org's download host (HTTP ${response.status})`);
  }
  const bytes = await download(target.href, `the symbol package of ${id} ${version}`, fetchFn);
  return bytes === undefined ? [] : readPackagePdbs(`${id}.${version}.snupkg`, bytes);
}

/** What a package's nuspec says of it: its id, its version and the repository commit it was built from. */
function readNuspec(bytes: Uint8Array): { id?: string; version?: string; commit?: string } {
  const nuspec = readZipEntries(bytes).find((entry) => !entry.name.includes('/') && entry.name.toLowerCase().endsWith('.nuspec'));
  const text = nuspec === undefined ? '' : Buffer.from(nuspec.read()).toString('utf8');
  const repository = /<repository\b([^>]*)>/i.exec(text)?.[1] ?? '';
  return {
    id: /<id>\s*([^<]*?)\s*<\/id>/i.exec(text)?.[1],
    version: /<version>\s*([^<]*?)\s*<\/version>/i.exec(text)?.[1],
    commit: /^[0-9a-f]{40}$/i.exec(attribute(repository, 'commit') ?? '')?.[0]?.toLowerCase(),
  };
}

/** A document's Source Link URL, parsed; undefined when it has none or it is not a URL. */
function linkOf(document: { sourceLinkUrl: string | null }): URL | undefined {
  try {
    return document.sourceLinkUrl === null ? undefined : new URL(document.sourceLinkUrl);
  } catch {
    return undefined;
  }
}

/** A commit hash in a Source Link URL: a path segment of 40 hex digits. */
function sourceLinkCommit(pdbs: readonly PackagePdb[]): string | undefined {
  for (const document of pdbs.flatMap((pdb) => pdb.documents)) {
    const match = /\/([0-9a-f]{40})\//i.exec(linkOf(document)?.pathname ?? '');
    if (match) return match[1]!.toLowerCase();
  }
  return undefined;
}

/** A host a source file may come from: a public DNS name, never `localhost`, a bare name or an IP address, so no PDB can point the fetch into the reviewer's network. */
const PUBLIC_HOST = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/i;

/** One source file to fetch: its path in the repository, its Source Link URL and every hash a PDB records for it. */
interface SourceFile {
  path: string;
  url: string;
  hashes: SourceDocument[];
}

/**
 * The source files the PDBs name at one commit, by their path in the
 * repository: what follows the commit in an https Source Link URL on a
 * public host. A document whose URL is not at that commit is left out.
 */
function sourceFiles(pdbs: readonly PackagePdb[], commit: string): SourceFile[] {
  const files = new Map<string, SourceFile>();
  for (const document of pdbs.flatMap((pdb) => pdb.documents)) {
    const url = linkOf(document);
    const at = url?.pathname.toLowerCase().indexOf(`/${commit}/`) ?? -1;
    if (url === undefined || url.protocol !== 'https:' || !PUBLIC_HOST.test(url.hostname) || at < 0) continue;
    let path: string;
    try {
      path = url.pathname.slice(at + commit.length + 2).split('/').map(decodeURIComponent).join('/');
    } catch {
      continue;
    }
    const file = files.get(path) ?? { path, url: url.href, hashes: [] };
    file.hashes.push(document);
    files.set(path, file);
  }
  return [...files.values()].sort((a, b) => a.path.localeCompare(b.path));
}

const NODE_HASHES: Partial<Record<SourceDocument['hashAlgorithm'], string>> = { 'SHA-1': 'sha1', 'SHA-256': 'sha256' };

/**
 * True when a source file is proven to be what the compiler read: its
 * bytes as fetched, or with every line ending turned LF or CRLF, hash to
 * one of the hashes a PDB records for it. A Git host may serve a file
 * with other line endings than the build checked out, so both are tried.
 */
export function provesSource(bytes: Uint8Array, hashes: readonly Pick<SourceDocument, 'hashAlgorithm' | 'hash'>[]): boolean {
  const text = Buffer.from(bytes).toString('latin1');
  const lf = text.replace(/\r\n/g, '\n');
  const variants = [Buffer.from(bytes), Buffer.from(lf, 'latin1'), Buffer.from(lf.replace(/\n/g, '\r\n'), 'latin1')];
  return hashes.some(({ hashAlgorithm, hash }) => {
    const algorithm = NODE_HASHES[hashAlgorithm];
    return algorithm !== undefined && variants.some((variant) => createHash(algorithm).update(variant).digest('hex') === hash);
  });
}

/** Runs `task` on every item, at most `limit` at once, keeping the items' order. */
async function inParallel<T, R>(items: readonly T[], limit: number, task: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next++;
      results[index] = await task(items[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

/** What a fetch records beside the library's folder, so a later fetch of the same package reuses it as it landed. */
type Landed = Omit<LibraryDownload, 'path' | 'reused'>;

/**
 * Fetches one pinned .NET library: downloads the exact package from
 * nuget.org, checks its SHA-512, reads its nuspec and PDBs, fetches each
 * source file the PDBs name at the repository commit, and keeps them
 * read-only in their own folder of the library cache, each labelled exact
 * source or unproven by the PDB's hash. Throws, saying why, when no source
 * can be found at a known commit: no PDB, no Source Link, or no commit.
 */
export async function fetchNuGetLibrary(pin: NuGetPin, options: LibraryFetchOptions): Promise<LibraryDownload> {
  const id = pin.name.toLowerCase();
  const version = pin.version.toLowerCase();
  if (!SAFE_ID.test(id) || !SAFE_VERSION.test(version)) throw new Error(`not a package a library fetch can download: ${pin.name} ${pin.version}`);
  const fetchFn = options.fetch ?? fetch;
  const name = `${pin.name} ${pin.version}`;
  const expected = Buffer.from(pin.contentHash ?? (await catalogHash(id, version, fetchFn)), 'base64').toString('hex');
  if (expected.length !== 128) throw new Error(`the SHA-512 ${pin.pinnedBy} records for ${name} is malformed`);
  const path = join(options.librariesDir, `${id}-${version}-${expected.slice(0, 12)}`);
  const manifest = `${path}.json`;
  if ((await exists(path)) && (await exists(manifest))) return { ...(JSON.parse(await readFile(manifest, 'utf8')) as Landed), path, reused: true };

  const file = `${id}.${version}.nupkg`;
  const bytes = await download(`${NUGET_API}-flatcontainer/${id}/${version}/${file}`, file, fetchFn);
  if (bytes === undefined) throw new Error(`nuget.org has no package ${name}`);
  const actual = createHash('sha512').update(bytes).digest('hex');
  const hashedBy = pin.contentHash === undefined ? "nuget.org's record of it" : pin.pinnedBy;
  if (actual !== expected) throw new Error(`the download of ${file} does not match the SHA-512 ${hashedBy} gives (expected ${expected}, got ${actual}); no source was fetched`);
  const nuspec = readNuspec(bytes);
  if (nuspec.id?.toLowerCase() !== id || nuspec.version?.toLowerCase() !== version) throw new Error(`${file} names another package in its nuspec; no source was fetched`);

  let pdbs = readPackagePdbs(file, bytes);
  if (!pdbs.some((pdb) => pdb.sourceLink !== null)) pdbs = [...pdbs, ...(await symbolPackagePdbs(id, version, fetchFn))];
  const commit = nuspec.commit ?? sourceLinkCommit(pdbs);
  const missing = [
    ...(pdbs.length === 0 ? ['no PDB of it is in the package or on the symbol server'] : []),
    ...(pdbs.length > 0 && !pdbs.some((pdb) => pdb.sourceLink !== null) ? ['no PDB of it carries Source Link, which names where each source file is'] : []),
    ...(commit === undefined ? ['neither its nuspec nor its PDB names the repository commit it was built from'] : []),
  ];
  if (missing.length > 0 || commit === undefined) throw new Error(`the exact source of ${name} cannot be found: ${missing.join(', and ')}; no source was fetched, and nothing is guessed`);
  const wanted = sourceFiles(pdbs, commit);
  if (wanted.length === 0) throw new Error(`the Source Link of ${name}'s PDB names no source file at commit ${commit}; no source was fetched`);
  if (wanted.length > MAX_SOURCE_FILES) throw new Error(`${name}'s PDBs name ${wanted.length} source files, more than the ${MAX_SOURCE_FILES} a library fetch downloads`);

  const budget: DownloadBudget = { cap: options.maxSourceBytes ?? MAX_UNPACKED_BYTES, buffered: 0 };
  const fetched = await inParallel(wanted, PARALLEL_DOWNLOADS, async (source) => ({
    ...source,
    content: await download(source.url, source.path, fetchFn, MAX_SOURCE_FILE_BYTES, budget),
  }));
  const landedFiles = fetched.flatMap((each) => (each.content === undefined ? [] : [{ ...each, content: each.content }]));
  if (landedFiles.length === 0) throw new Error(`none of the source files ${name}'s PDB names could be fetched at commit ${commit}`);
  const unproven = landedFiles.filter((each) => !provesSource(each.content, each.hashes)).map((each) => each.path);
  const host = new URL(landedFiles[0]!.url).host;
  const notFound = wanted.length - landedFiles.length;
  const landed: Landed = {
    file,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    archive: 'NuGet package',
    note:
      `Source fetched from ${host} at commit ${commit}, which ${nuspec.commit ? 'its nuspec' : 'its PDB'} names: ` +
      `${landedFiles.length - unproven.length} of ${landedFiles.length} ${landedFiles.length === 1 ? 'file is' : 'files are'} exact source, matched to the hash its PDB records` +
      (unproven.length > 0 ? `; ${unproven.length} ${unproven.length === 1 ? 'is' : 'are'} unproven and never make a claim verified` : '') +
      (notFound > 0 ? `; ${notFound} more its PDB names were not found there, such as files the build generated` : '') +
      '.',
    ...(unproven.length > 0 ? { unproven } : {}),
  };

  await mkdir(options.librariesDir, { recursive: true });
  const partial = join(options.librariesDir, `.partial-${randomBytes(6).toString('hex')}`);
  try {
    await writeReadOnlyFiles(landedFiles, partial, { maxBytes: MAX_UNPACKED_BYTES });
    await writeFile(`${partial}.json`, JSON.stringify(landed), { mode: 0o444 });
    await rename(`${partial}.json`, manifest);
    await rename(partial, path);
  } catch (error) {
    await removeCopy(partial);
    await rm(`${partial}.json`, { force: true });
    // Another fetch finished the same package first; theirs is just as good.
    if (await exists(path)) return { ...landed, path, reused: true };
    throw error;
  }
  return { ...landed, path, reused: false };
}
