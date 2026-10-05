import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, readdir, rename, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { extractTarball, extractZip } from './archive.js';
import { removeCopy } from './cache.js';
import { fetchNuGetLibrary, findNuGetPin, type NuGetPin } from './nuget-fetch.js';
import type { Claim, LibraryFetchOffer } from './protocol.js';
import { isTomlTable, parseToml, type TomlValue } from './toml.js';

/**
 * Library fetch, Python first (ADR 0003): when a verdict needs a
 * library's source, the companion offers to fetch it at the version the
 * project pins, and only when the reviewer presses the offer does the
 * engine download the exact file the lock file pins — found on PyPI by
 * the hash the lock records, downloaded only from PyPI's own file host —
 * check that hash, and unpack the file read-only into the pull request's
 * library cache. Nothing downloaded is built, installed or run: a wheel
 * is unzipped, a source archive untarred, and the agent and the reviewer
 * only read what landed. A .NET library is fetched the same way, from
 * nuget.org, by {@link fetchNuGetLibrary}.
 */

/** One library as a lock file pins it, with the hashes it records for the version's files. */
export interface LibraryPin {
  /** The package name as the lock file writes it. */
  name: string;
  version: string;
  /** The lock file, by its path in the head copy. */
  pinnedBy: string;
  /** The SHA-256 hashes the lock file pins, as lowercase hex. */
  hashes: string[];
}

/** A package name as PyPI compares names: lowercase, with runs of `-`, `_` and `.` as one `-`. */
export function normalizePackageName(name: string): string {
  return name.trim().toLowerCase().replace(/[-_.]+/g, '-');
}

const SHA256 = /^sha256:([0-9a-f]{64})$/i;

/** The SHA-256 in a lock file's `sha256:<hex>` hash, lowercase; undefined for another algorithm. */
function sha256Of(value: unknown): string | undefined {
  return typeof value === 'string' ? SHA256.exec(value.trim())?.[1]?.toLowerCase() : undefined;
}

/** The hashes in a list of `{ hash = "sha256:..." }` tables, such as uv's wheels or poetry's files. */
function tableHashes(value: TomlValue | undefined): string[] {
  const tables = Array.isArray(value) ? value : value === undefined ? [] : [value];
  return tables.flatMap((table) => (isTomlTable(table) ? [sha256Of(table['hash'])] : [])).filter((hash): hash is string => hash !== undefined);
}

/** True when a uv or poetry package entry comes from PyPI: no source, or PyPI's own index. */
function fromPyPI(source: TomlValue | undefined, lock: 'uv.lock' | 'poetry.lock'): boolean {
  if (source === undefined) return lock === 'poetry.lock';
  if (!isTomlTable(source)) return false;
  return lock === 'uv.lock' && source['registry'] === 'https://pypi.org/simple';
}

/** The pins of a uv.lock or poetry.lock, from its `[[package]]` tables (and poetry 1's `[metadata.files]`). */
function tomlPins(text: string, pinnedBy: string, lock: 'uv.lock' | 'poetry.lock'): LibraryPin[] {
  const root = parseToml(text);
  const packages = root?.['package'];
  if (!root || !Array.isArray(packages)) return [];
  const metadata = root['metadata'];
  const oldFiles = isTomlTable(metadata) && isTomlTable(metadata['files']) ? metadata['files'] : {};
  return packages.flatMap((entry) => {
    if (!isTomlTable(entry) || typeof entry['name'] !== 'string' || typeof entry['version'] !== 'string') return [];
    if (!fromPyPI(entry['source'], lock)) return [];
    const hashes =
      lock === 'uv.lock'
        ? [...tableHashes(entry['sdist']), ...tableHashes(entry['wheels'])]
        : tableHashes(entry['files'] ?? oldFiles[entry['name']]);
    return [{ name: entry['name'], version: entry['version'], pinnedBy, hashes }];
  });
}

/** One requirement pinned to an exact version: `name[extras] == version`, before any marker or option. */
const PINNED_REQUIREMENT = /^([A-Za-z0-9][A-Za-z0-9._-]*)\s*(?:\[[^\]]*\])?\s*===?\s*([^\s;#\\]+)/;

/** The exactly pinned requirements of a requirements file, with the `--hash` options each carries. */
function requirementPins(text: string, pinnedBy: string): LibraryPin[] {
  const logical = text.replace(/\\\r?\n/g, ' ').split(/\r?\n/);
  return logical.flatMap((line) => {
    const requirement = line.replace(/(^|\s)#.*$/, '').trim();
    const pinned = PINNED_REQUIREMENT.exec(requirement);
    if (!pinned) return [];
    const hashes = [...requirement.matchAll(/--hash[=\s]\s*(\S+)/g)].map((match) => sha256Of(match[1])).filter((hash): hash is string => hash !== undefined);
    return [{ name: pinned[1]!, version: pinned[2]!, pinnedBy, hashes }];
  });
}

/** The lock files read for a pin, in the order they are trusted: uv.lock, then poetry.lock, then `requirements.txt` before every other requirements file, then the rest by name. */
async function lockFiles(root: string): Promise<string[]> {
  const names = await readdir(root).catch(() => [] as string[]);
  const requirements = names
    .filter((name) => /requirements.*\.txt$/i.test(name))
    .sort((a, b) => Number(/^requirements\.txt$/i.test(b)) - Number(/^requirements\.txt$/i.test(a)) || a.localeCompare(b));
  return ['uv.lock', 'poetry.lock', ...requirements].filter((name) => names.includes(name));
}

/**
 * The pin of one library in the head copy's lock files at its root: uv.lock,
 * then poetry.lock, then `requirements.txt` before every other requirements
 * file. Only a pin that records at
 * least one SHA-256 hash counts, since a fetch must check what it
 * downloads. When none pins it, a .NET project's pin of it is looked for
 * (see {@link findNuGetPin}); undefined when nothing pins the library so.
 */
export async function findLibraryPin(headRoot: string, library: string): Promise<LibraryPin | NuGetPin | undefined> {
  const wanted = normalizePackageName(library);
  for (const name of await lockFiles(headRoot)) {
    const text = await readFile(join(headRoot, name), 'utf8').catch(() => '');
    const pins = name.endsWith('.lock') ? tomlPins(text, name, name as 'uv.lock' | 'poetry.lock') : requirementPins(text, name);
    const pin = pins.find((each) => normalizePackageName(each.name) === wanted && each.hashes.length > 0);
    if (pin) return pin;
  }
  return findNuGetPin(headRoot, library);
}

/** The offer for a pin: the library, its pinned version, the lock file and why. */
export function fetchOffer(pin: LibraryPin | NuGetPin): LibraryFetchOffer {
  return {
    library: pin.name,
    pinnedVersion: pin.version,
    pinnedBy: pin.pinnedBy,
    reason: `The change alone cannot settle this claim: it turns on how ${pin.name} behaves, so checking it needs the source of ${pin.name} ${pin.version}, as ${pin.pinnedBy} pins it.`,
  };
}

/**
 * Adds a library fetch offer to every verdict that needs a library the
 * head copy's lock files pin with hashes, or a .NET project pins at one
 * exact version. Only local files are read:
 * nothing is downloaded until the reviewer presses an offer.
 */
export async function offerLibraryFetches(claims: readonly Claim[], headRoot: string): Promise<Claim[]> {
  return Promise.all(
    claims.map(async (claim) => {
      const { verdict } = claim;
      if (verdict.kind === 'not checked' || verdict.needsLibrary === undefined || verdict.library !== undefined) return claim;
      const pin = await findLibraryPin(headRoot, verdict.needsLibrary);
      return pin === undefined ? claim : { ...claim, verdict: { ...verdict, libraryFetch: fetchOffer(pin) } };
    }),
  );
}

/** One file PyPI lists for a release. */
interface IndexFile {
  filename: string;
  url: string;
  sha256: string;
}

/** The only host the engine downloads library files from: PyPI's own. */
const FILE_HOST = 'https://files.pythonhosted.org/';

/** The largest file a fetch downloads; far above any real wheel or source archive of Python code. */
const MAX_DOWNLOAD_BYTES = 256 * 1024 * 1024;

/** What one download may unpack to. */
const MAX_UNPACKED_BYTES = 1024 * 1024 * 1024;

/** A version as a folder name may hold it: PEP 440 characters only. */
const SAFE_VERSION = /^[A-Za-z0-9][A-Za-z0-9.+!_-]*$/;

/** A file name PyPI may give a wheel or a source archive, with nothing that steers a path. */
const SAFE_FILENAME = /^[A-Za-z0-9][A-Za-z0-9._+!-]*\.(?:whl|tar\.gz)$/;

/** The files PyPI lists for one release, from its JSON API. */
async function indexFiles(pin: LibraryPin, fetchFn: typeof fetch): Promise<IndexFile[]> {
  const url = `https://pypi.org/pypi/${encodeURIComponent(normalizePackageName(pin.name))}/${encodeURIComponent(pin.version)}/json`;
  const response = await fetchFn(url, { headers: { Accept: 'application/json' }, redirect: 'error' });
  if (!response.ok) throw new Error(`PyPI has no release ${pin.name} ${pin.version} (HTTP ${response.status})`);
  const body = (await response.json()) as { urls?: unknown };
  if (!Array.isArray(body.urls)) throw new Error(`PyPI's answer for ${pin.name} ${pin.version} lists no files`);
  return body.urls.flatMap((each: unknown) => {
    if (typeof each !== 'object' || each === null) return [];
    const { filename, url: fileUrl, digests } = each as { filename?: unknown; url?: unknown; digests?: { sha256?: unknown } };
    const sha256 = typeof digests?.sha256 === 'string' ? digests.sha256.toLowerCase() : undefined;
    if (typeof filename !== 'string' || typeof fileUrl !== 'string' || sha256 === undefined) return [];
    return [{ filename, url: fileUrl, sha256 }];
  });
}

/**
 * The file to download: of the files PyPI lists whose hash the lock
 * pins, served from PyPI's own host, a pure-Python wheel first, then any
 * wheel, then a source archive.
 */
function chooseFile(pin: LibraryPin, files: readonly IndexFile[]): IndexFile {
  const pinned = files.filter((file) => pin.hashes.includes(file.sha256) && file.url.startsWith(FILE_HOST) && SAFE_FILENAME.test(file.filename));
  const rank = (file: IndexFile): number => (file.filename.endsWith('-none-any.whl') ? 0 : file.filename.endsWith('.whl') ? 1 : 2);
  const [chosen] = [...pinned].sort((a, b) => rank(a) - rank(b) || a.filename.localeCompare(b.filename));
  if (chosen === undefined) {
    throw new Error(`PyPI lists no wheel or source archive of ${pin.name} ${pin.version} whose hash ${pin.pinnedBy} pins; nothing was downloaded`);
  }
  return chosen;
}

/** Downloads one file into memory, refusing one larger than {@link MAX_DOWNLOAD_BYTES}. */
async function download(file: IndexFile, fetchFn: typeof fetch): Promise<Buffer> {
  const response = await fetchFn(file.url, { redirect: 'error' });
  if (!response.ok || response.body === null) throw new Error(`the download of ${file.filename} failed (HTTP ${response.status})`);
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of response.body as AsyncIterable<Uint8Array>) {
    size += chunk.length;
    if (size > MAX_DOWNLOAD_BYTES) throw new Error(`${file.filename} is larger than the ${MAX_DOWNLOAD_BYTES / 1024 / 1024} MiB a library fetch downloads`);
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks, size);
}

async function* once(bytes: Uint8Array): AsyncIterable<Uint8Array> {
  yield bytes;
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

/** What one fetch landed: the file, its hash, and where its source was unpacked. */
export interface LibraryDownload {
  file: string;
  sha256: string;
  archive: 'wheel' | 'source archive' | 'NuGet package';
  /** Absolute path of the unpacked, read-only source. */
  path: string;
  note?: string;
  /** The source files not proven to be what the library was built from, by their path in it; none when every file is. */
  unproven?: string[];
  /** True when an earlier fetch of the same file was reused. */
  reused: boolean;
}

export interface LibraryFetchOptions {
  /** The pull request's library cache: `libraries` in its cache folder, shared by the agent and the reviewer. */
  librariesDir: string;
  /** Fetch implementation; tests inject recorded responses so no test touches the network. */
  fetch?: typeof fetch;
}

/**
 * Fetches one pinned library: finds on PyPI the exact file whose hash the
 * lock file pins, downloads it from PyPI's own host, checks its SHA-256
 * against the pin before anything is unpacked, and unpacks it read-only
 * into its own folder of the library cache — a wheel unzipped, a source
 * archive untarred, never built, installed or run. The folder is renamed
 * into place only once complete, and reused by a later fetch of the same
 * file. A .NET pin is fetched by {@link fetchNuGetLibrary}.
 */
export async function fetchLibrary(pin: LibraryPin | NuGetPin, options: LibraryFetchOptions): Promise<LibraryDownload> {
  if ('ecosystem' in pin) return fetchNuGetLibrary(pin, options);
  if (!SAFE_VERSION.test(pin.version)) throw new Error(`not a version a library fetch can download: ${pin.version}`);
  const fetchFn = options.fetch ?? fetch;
  const file = chooseFile(pin, await indexFiles(pin, fetchFn));
  const archive = file.filename.endsWith('.whl') ? 'wheel' : 'source archive';
  const note =
    archive === 'source archive'
      ? `${pin.pinnedBy} pins no wheel of ${pin.name} ${pin.version}, only its source archive: it was unpacked and never built, so code the build would generate is missing.`
      : undefined;
  const path = join(options.librariesDir, `${normalizePackageName(pin.name)}-${pin.version}-${file.sha256.slice(0, 12)}`);
  const landed = { file: file.filename, sha256: file.sha256, archive, path, ...(note ? { note } : {}) } as const;
  if (await exists(path)) return { ...landed, reused: true };

  const bytes = await download(file, fetchFn);
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (actual !== file.sha256) {
    throw new Error(
      `the download of ${file.filename} does not match the hash ${pin.pinnedBy} pins (expected sha256 ${file.sha256}, got ${actual}); nothing was unpacked`,
    );
  }
  await mkdir(options.librariesDir, { recursive: true });
  const partial = join(options.librariesDir, `.partial-${randomBytes(6).toString('hex')}`);
  try {
    if (archive === 'wheel') await extractZip(bytes, partial, { maxBytes: MAX_UNPACKED_BYTES });
    else await extractTarball(once(bytes), partial, { maxBytes: MAX_UNPACKED_BYTES });
    await rename(partial, path);
  } catch (error) {
    await removeCopy(partial);
    // Another fetch finished the same file first; theirs is just as good.
    if (await exists(path)) return { ...landed, reused: true };
    throw error;
  }
  return { ...landed, reused: false };
}
