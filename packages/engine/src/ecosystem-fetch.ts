import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { extractTarball, extractZip } from './archive.js';
import { removeCopy } from './cache.js';
import type { LibraryDownload, LibraryFetchOptions } from './library-fetch.js';
import { download } from './nuget-fetch.js';
import { pinFilesIn } from './pin-files.js';
import { isTomlTable, parseToml } from './toml.js';
import { readZipEntries, type ZipEntry } from './zip.js';

/**
 * Library fetch for npm, Cargo, Go and Maven (ADR 0003), the same way as
 * Python's: the engine downloads the exact file the project pins — an npm
 * package's tarball, a crate, a Go module's zip, or a Maven artifact's
 * sources jar — only from the ecosystem's own host, checks it against the
 * hash the lock file records (or, for Maven, which records none, the
 * SHA-1 Maven Central records), and unpacks it read-only into the pull
 * request's library cache. Nothing is built, installed or run.
 */

export type Ecosystem = 'npm' | 'Cargo' | 'Go' | 'Maven';

/** One library as an npm, Cargo, Go or Maven project pins it. */
export interface EcosystemPin {
  ecosystem: Ecosystem;
  /** The package as its registry names it: an npm package, a crate, a Go module's path, or a Maven `group:artifact`. */
  name: string;
  version: string;
  /** The lock or build file, by its path in the head copy. */
  pinnedBy: string;
  /** The hash the lock file records: npm's SHA-512 and Cargo's SHA-256 as hex, Go's `h1:` hash; none for Maven. */
  hash?: string;
}

/** A version as a URL or a folder name may hold it, with nothing that steers a path. */
const SAFE_VERSION = /^v?[0-9][0-9A-Za-z.+-]*$/;

/** The JSON value of a file, or undefined when it is not JSON. */
function parseJson(text: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

const NPM_NAME = /^(?:@[A-Za-z0-9][A-Za-z0-9._~-]*\/)?[A-Za-z0-9][A-Za-z0-9._~-]*$/;

/** Where npm's own registry serves a package's tarball. */
function npmTarball(name: string, version: string): string {
  return `https://registry.npmjs.org/${name}/-/${name.slice(name.indexOf('/') + 1)}-${version}.tgz`;
}

/**
 * The pin of one package in a package-lock.json or npm-shrinkwrap.json:
 * the shallowest install of it, from npm's own registry, with the SHA-512
 * its integrity records.
 */
function npmPin(text: string, wanted: string, pinnedBy: string): EcosystemPin | undefined {
  const lock = parseJson(text);
  const table = lock?.['packages'] ?? lock?.['dependencies'];
  if (typeof table !== 'object' || table === null) return undefined;
  const installs = Object.entries(table as Record<string, unknown>)
    .filter(([key]) => key === wanted || key === `node_modules/${wanted}` || key.endsWith(`/node_modules/${wanted}`))
    .sort(([a], [b]) => a.length - b.length);
  for (const [, entry] of installs) {
    const { name = wanted, version, integrity, resolved, link } = (entry ?? {}) as Record<string, unknown>;
    if (link === true || typeof name !== 'string' || !NPM_NAME.test(name) || typeof version !== 'string' || !SAFE_VERSION.test(version)) continue;
    if (resolved !== undefined && resolved !== npmTarball(name, version)) continue;
    const sha512 = typeof integrity === 'string' ? integrity.split(/\s+/).find((each) => each.startsWith('sha512-')) : undefined;
    const hash = sha512 === undefined ? '' : Buffer.from(sha512.slice(7), 'base64').toString('hex');
    if (hash.length === 128) return { ecosystem: 'npm', name, version, pinnedBy, hash };
  }
  return undefined;
}

/** The sources Cargo.lock records for crates.io. */
const CRATES_IO = new Set(['registry+https://github.com/rust-lang/crates.io-index', 'sparse+https://index.crates.io/']);

/** A crate name as crates.io compares names: lowercase, `-` and `_` alike. */
function crateKey(name: string): string {
  return name.trim().toLowerCase().replace(/_/g, '-');
}

/** The pin of one crate in a Cargo.lock: from crates.io, with its checksum; the highest version when it locks several. */
function cargoPin(text: string, wanted: string, pinnedBy: string): EcosystemPin | undefined {
  const packages = parseToml(text)?.['package'];
  const pins = (Array.isArray(packages) ? packages : []).flatMap((entry): EcosystemPin[] => {
    if (!isTomlTable(entry)) return [];
    const { name, version, source, checksum } = entry;
    if (typeof name !== 'string' || crateKey(name) !== crateKey(wanted) || !/^[A-Za-z0-9_-]+$/.test(name)) return [];
    if (typeof version !== 'string' || !SAFE_VERSION.test(version) || typeof source !== 'string' || !CRATES_IO.has(source)) return [];
    if (typeof checksum !== 'string' || !/^[0-9a-f]{64}$/i.test(checksum)) return [];
    return [{ ecosystem: 'Cargo', name, version, pinnedBy, hash: checksum.toLowerCase() }];
  });
  return pins.at(-1);
}

const GO_MODULE = /^[A-Za-z0-9][A-Za-z0-9._~-]*(?:\/[A-Za-z0-9._~-]+)*$/;

/** The modules a go.mod requires, by path, and the paths it replaces. */
function goRequirements(text: string): { required: Map<string, string>; replaced: Set<string> } {
  const required = new Map<string, string>();
  const replaced = new Set<string>();
  let block: string | undefined;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\/\/.*$/, '').trim();
    if (block !== undefined && line === ')') block = undefined;
    const opened = /^(require|replace)\s*\($/.exec(line);
    if (opened) block = opened[1];
    const [verb, ...rest] = block === undefined ? line.split(/\s+/) : [block, ...line.split(/\s+/)];
    if (opened || rest.length < 2 || rest[0] === undefined) continue;
    if (verb === 'require') required.set(rest[0], rest[1]!);
    if (verb === 'replace') replaced.add(rest[0]);
  }
  return { required, replaced };
}

/**
 * The pin of one Go module in a go.sum, at the version the go.mod beside it
 * requires, with the `h1:` hash go.sum records for the module's zip. A
 * library named by an import path matches the longest module holding it;
 * a module the go.mod replaces is pinned to other code, so it has no pin.
 */
async function goPin(headRoot: string, path: string, wanted: string): Promise<EcosystemPin | undefined> {
  const sum = await readFile(join(headRoot, ...path.split('/')), 'utf8').catch(() => '');
  const mod = await readFile(join(headRoot, ...path.replace(/go\.sum$/, 'go.mod').split('/')), 'utf8').catch(() => '');
  const { required, replaced } = goRequirements(mod);
  const [module] = [...required.keys()].filter((each) => wanted === each || wanted.startsWith(`${each}/`)).sort((a, b) => b.length - a.length);
  const version = module === undefined ? undefined : required.get(module);
  if (module === undefined || version === undefined || replaced.has(module) || !GO_MODULE.test(module) || !SAFE_VERSION.test(version)) return undefined;
  const line = sum.split(/\r?\n/).find((each) => each.startsWith(`${module} ${version} h1:`));
  const hash = line?.split(/\s+/)[2];
  return hash === undefined ? undefined : { ecosystem: 'Go', name: module, version, pinnedBy: path, hash };
}

const MAVEN_ID = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/;

/** One XML element's text inside some XML, or undefined. */
function element(xml: string, name: string): string | undefined {
  return new RegExp(`<${name}>\\s*([^<]*?)\\s*</${name}>`).exec(xml)?.[1];
}

/** The `group:artifact` and version of every dependency a pom.xml names at a literal version or one of its own properties. */
function pomDependencies(text: string): { name: string; version: string }[] {
  const xml = text.replace(/<!--[\s\S]*?-->/g, '');
  const properties = /<properties>([\s\S]*?)<\/properties>/.exec(xml)?.[1] ?? '';
  const resolve = (value: string): string => value.replace(/^\$\{([A-Za-z0-9_.-]+)\}$/, (whole, key: string) => element(properties, key.replace(/\./g, '\\.')) ?? whole);
  return [...xml.matchAll(/<dependency>([\s\S]*?)<\/dependency>/g)].flatMap(([, body = '']) => {
    const [group, artifact, version] = [element(body, 'groupId'), element(body, 'artifactId'), element(body, 'version')];
    return group && artifact && version ? [{ name: `${group}:${artifact}`, version: resolve(version) }] : [];
  });
}

/** The pin of one Maven artifact in a pom.xml or gradle.lockfile, named as `group:artifact` or by its artifact alone, at one exact version. */
function mavenPin(text: string, wanted: string, pinnedBy: string): EcosystemPin | undefined {
  const pins = pinnedBy.endsWith('gradle.lockfile')
    ? [...text.matchAll(/^([^:#\s]+:[^:\s]+):([^=\s]+)=/gm)].map(([, name = '', version = '']) => ({ name, version }))
    : pomDependencies(text);
  const key = wanted.trim().toLowerCase();
  const pin = pins.find(({ name, version }) => {
    const [group = '', artifact = ''] = name.split(':');
    return (name.toLowerCase() === key || artifact.toLowerCase() === key) && MAVEN_ID.test(group) && MAVEN_ID.test(artifact) && SAFE_VERSION.test(version);
  });
  return pin === undefined ? undefined : { ecosystem: 'Maven', ...pin, pinnedBy };
}

/** The files read for a pin, by ecosystem: npm's lock files, Cargo.lock, go.sum, and Maven's pom.xml and gradle.lockfile. */
const PIN_FILES = /^(?:package-lock\.json|npm-shrinkwrap\.json|Cargo\.lock|go\.sum|pom\.xml|gradle\.lockfile)$/;

/**
 * The pin of one library in the head copy's npm, Cargo, Go or Maven files,
 * searched below the root, shallowest first; undefined when none pins it
 * at one exact version, with the hash a lock file records where the
 * ecosystem's lock records one.
 */
export async function findEcosystemPin(headRoot: string, library: string): Promise<EcosystemPin | undefined> {
  const wanted = library.trim();
  if (wanted === '') return undefined;
  for (const path of await pinFilesIn(headRoot, (name) => PIN_FILES.test(name))) {
    const name = path.slice(path.lastIndexOf('/') + 1);
    if (name === 'go.sum') {
      const pin = await goPin(headRoot, path, wanted);
      if (pin) return pin;
      continue;
    }
    const text = await readFile(join(headRoot, ...path.split('/')), 'utf8').catch(() => '');
    const pin = name === 'Cargo.lock' ? cargoPin(text, wanted, path) : name.endsWith('.json') ? npmPin(text, wanted, path) : mavenPin(text, wanted, path);
    if (pin) return pin;
  }
  return undefined;
}

/** A Go module path or version as the module proxy escapes it: each capital letter as `!` and its lowercase. */
function goEscape(path: string): string {
  return path.replace(/[A-Z]/g, (letter) => `!${letter.toLowerCase()}`);
}

/**
 * The `h1:` hash of a Go module's zip, as go.sum records it: the SHA-256 of
 * a summary listing each file's SHA-256 and name, sorted by name.
 */
export function goModuleHash(entries: readonly ZipEntry[]): string {
  const sorted = [...entries].sort((a, b) => Buffer.compare(Buffer.from(a.name), Buffer.from(b.name)));
  const summary = sorted.map((entry) => {
    if (entry.name.includes('\n')) throw new Error(`the module's zip holds a file name with a line break: ${JSON.stringify(entry.name)}`);
    return `${createHash('sha256').update(entry.read()).digest('hex')}  ${entry.name}\n`;
  });
  return `h1:${createHash('sha256').update(summary.join('')).digest('base64')}`;
}

/** The largest download, and what one may unpack to; far above any real package. */
const MAX_UNPACKED_BYTES = 1024 * 1024 * 1024;

const MAVEN_CENTRAL = 'https://repo.maven.apache.org/maven2';

/** How each ecosystem's pinned file is found, checked and unpacked. */
interface Route {
  archive: LibraryDownload['archive'];
  /** The exact file's URL on the ecosystem's own host. */
  url(pin: EcosystemPin): string;
  /** The hash to check the download against, and who records it: the pin's own, or the host's record when the pin has none. */
  expected(pin: EcosystemPin, fetchFn: typeof fetch): Promise<{ hash: string; by: string }>;
  /** The download's hash, as `expected` gives it. */
  hashOf(bytes: Buffer): string;
  unpack(bytes: Buffer, dir: string, pin: EcosystemPin): Promise<unknown>;
}

const pinned = async (pin: EcosystemPin): Promise<{ hash: string; by: string }> => ({ hash: pin.hash ?? '', by: pin.pinnedBy });
const hexHash = (algorithm: string) => (bytes: Buffer): string => createHash(algorithm).update(bytes).digest('hex');
const untar = (bytes: Buffer, dir: string): Promise<unknown> => extractTarball((async function* () { yield bytes; })(), dir, { maxBytes: MAX_UNPACKED_BYTES });

const ROUTES: Record<Ecosystem, Route> = {
  npm: { archive: 'npm package', url: (pin) => npmTarball(pin.name, pin.version), expected: pinned, hashOf: hexHash('sha512'), unpack: untar },
  Cargo: {
    archive: 'crate',
    url: (pin) => `https://static.crates.io/crates/${pin.name}/${pin.name}-${pin.version}.crate`,
    expected: pinned,
    hashOf: hexHash('sha256'),
    unpack: untar,
  },
  Go: {
    archive: 'Go module',
    url: (pin) => `https://proxy.golang.org/${goEscape(pin.name)}/@v/${goEscape(pin.version)}.zip`,
    expected: pinned,
    hashOf: (bytes) => {
      const entries = readZipEntries(bytes);
      if (entries.reduce((sum, entry) => sum + entry.size, 0) > MAX_UNPACKED_BYTES) throw new Error('the module unpacks to more than the companion allows');
      return goModuleHash(entries);
    },
    unpack: (bytes, dir, pin) => extractZip(bytes, dir, { maxBytes: MAX_UNPACKED_BYTES }, pin.name.split('/').length),
  },
  Maven: {
    archive: 'sources jar',
    url: (pin) => {
      const [group = '', artifact = ''] = pin.name.split(':');
      return `${MAVEN_CENTRAL}/${group.split('.').join('/')}/${artifact}/${pin.version}/${artifact}-${pin.version}-sources.jar`;
    },
    expected: async (pin, fetchFn) => {
      const record = await download(`${ROUTES.Maven.url(pin)}.sha1`, `the SHA-1 of ${pin.name} ${pin.version}'s sources jar`, fetchFn, 1024);
      const hash = /^\s*([0-9a-f]{40})\b/i.exec(record?.toString('utf8') ?? '')?.[1];
      if (hash === undefined) throw new Error(`Maven Central has no sources jar of ${pin.name} ${pin.version}, or no SHA-1 for it; nothing was downloaded`);
      return { hash: hash.toLowerCase(), by: "Maven Central's record of it" };
    },
    hashOf: hexHash('sha1'),
    unpack: (bytes, dir) => extractZip(bytes, dir, { maxBytes: MAX_UNPACKED_BYTES }),
  },
};

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

/** What a fetch records beside the library's folder, so a later fetch of the same file reuses it as it landed. */
type Landed = Omit<LibraryDownload, 'path' | 'reused'>;

/**
 * Lands one fetch in its own folder of the library cache: `write` fills a
 * partial folder, which is renamed into place with its record beside it
 * only once complete. A folder already there, with its record, is reused.
 */
export async function landLibrary(
  librariesDir: string,
  folder: string,
  fetchLanded: () => Promise<{ landed: Landed; write: (dir: string) => Promise<unknown> }>,
): Promise<LibraryDownload> {
  const path = join(librariesDir, folder);
  const manifest = `${path}.json`;
  if ((await exists(path)) && (await exists(manifest))) return { ...(JSON.parse(await readFile(manifest, 'utf8')) as Landed), path, reused: true };
  const { landed, write } = await fetchLanded();
  await mkdir(librariesDir, { recursive: true });
  const partial = join(librariesDir, `.partial-${randomBytes(6).toString('hex')}`);
  try {
    await write(partial);
    await writeFile(`${partial}.json`, JSON.stringify(landed), { mode: 0o444 });
    await rename(`${partial}.json`, manifest);
    await rename(partial, path);
  } catch (error) {
    await removeCopy(partial);
    await rm(`${partial}.json`, { force: true });
    // Another fetch finished the same file first; theirs is just as good.
    if (await exists(path)) return { ...landed, path, reused: true };
    throw error;
  }
  return { ...landed, path, reused: false };
}

/** A name as a folder name may hold it: anything but letters, digits, `.`, `_` and `-` as `_`. */
export function folderName(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '_');
}

/**
 * Fetches one pinned npm, Cargo, Go or Maven library: downloads the exact
 * file from the ecosystem's own host, checks it against the pinned hash —
 * or Maven Central's SHA-1 for a Maven artifact, whose build files record
 * none — before anything is unpacked, and unpacks it read-only into its
 * own folder of the library cache, never built, installed or run.
 */
export async function fetchEcosystemLibrary(pin: EcosystemPin, options: LibraryFetchOptions): Promise<LibraryDownload> {
  const route = ROUTES[pin.ecosystem];
  if (!SAFE_VERSION.test(pin.version)) throw new Error(`not a version a library fetch can download: ${pin.version}`);
  const fetchFn = options.fetch ?? fetch;
  const url = route.url(pin);
  const file = url.slice(url.lastIndexOf('/') + 1);
  const { hash: expected, by } = await route.expected(pin, fetchFn);
  if (expected === '') throw new Error(`${pin.pinnedBy} records no hash of ${pin.name} ${pin.version}; nothing was downloaded`);
  const tag = createHash('sha256').update(expected).digest('hex').slice(0, 12);
  return landLibrary(options.librariesDir, `${pin.ecosystem.toLowerCase()}-${folderName(pin.name)}-${pin.version}-${tag}`, async () => {
    const bytes = await download(url, file, fetchFn);
    if (bytes === undefined) throw new Error(`${new URL(url).host} has no ${route.archive} ${pin.name} ${pin.version}; nothing was downloaded`);
    const actual = route.hashOf(bytes);
    if (actual !== expected) throw new Error(`the download of ${file} does not match the hash ${by} gives (expected ${expected}, got ${actual}); nothing was unpacked`);
    const landed: Landed = { file, sha256: createHash('sha256').update(bytes).digest('hex'), archive: route.archive };
    return { landed, write: (dir) => route.unpack(bytes, dir, pin) };
  });
}
