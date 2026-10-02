/**
 * The parse-only lock file checks: a lock file part whose label the name
 * rule claimed is confirmed when reading both versions of the lock file
 * and its manifest proves the change follows from the manifest change —
 * every changed entry belongs to the dependency closure of the changed
 * manifest entries, with the closure followed through the dependency
 * edges the lock file itself records. Nothing is ever resolved, installed
 * or run: no package manager is started and no registry is contacted, so
 * the check states its blind spots instead of hiding them.
 *
 * Supported formats: uv.lock and poetry.lock (manifest pyproject.toml),
 * package-lock.json (package.json), NuGet packages.lock.json (the project
 * files beside it and Directory.Packages.props up the tree) and Cargo.lock
 * (Cargo.toml). A lock file of any other ecosystem keeps its claimed label.
 */

import { readdir, readFile } from 'node:fs/promises';
import { basename, dirname } from 'node:path';
import { pathInCopy } from './archive.js';
import type { NoiseAssessment, Part } from './protocol.js';
import { isTomlTable, parseToml } from './toml.js';
import type { TomlTable, TomlValue } from './toml.js';

/** How many entries a claimed label names before counting the rest. */
const MAX_NAMED_ENTRIES = 5;

/** True for a plain JSON/TOML record, as the readers below need it. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A stable textual fingerprint of a parsed value, whatever the format. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(',')}}`;
}

/** PEP 503 normalisation, so manifest and lock file names compare equal. */
function pep503(name: string): string {
  return name.toLowerCase().replace(/[-_.]+/g, '-');
}

/** The package name of one PEP 508 requirement string, normalized. */
function requirementName(requirement: string): string | undefined {
  const match = /^\s*([A-Za-z0-9][A-Za-z0-9._-]*)/.exec(requirement);
  return match === null ? undefined : pep503(match[1]!);
}

/** One file path under a forward-slash directory, or at the root. */
function under(dir: string, name: string): string {
  return dir === '.' || dir === '' ? name : `${dir}/${name}`;
}

/**
 * One lock file read by package name: the versions present (each with a
 * fingerprint of its whole entry, so a hand-edited hash is a change too),
 * the dependency edges the lock file itself records, and the names it
 * marks transitive rather than direct.
 */
interface LockIndex {
  versions: Map<string, Map<string, string>>;
  edges: Map<string, Set<string>>;
  transitive: Set<string>;
}

function emptyIndex(): LockIndex {
  return { versions: new Map(), edges: new Map(), transitive: new Set() };
}

function recordEntry(index: LockIndex, name: string, version: string, fingerprint: string): void {
  let versions = index.versions.get(name);
  if (versions === undefined) {
    versions = new Map();
    index.versions.set(name, versions);
  }
  versions.set(version, fingerprint);
}

function recordEdge(index: LockIndex, name: string, dependency: string): void {
  let edges = index.edges.get(name);
  if (edges === undefined) {
    edges = new Set();
    index.edges.set(name, edges);
  }
  edges.add(dependency);
}

/**
 * Reads a `[[package]]`-shaped TOML lock file (uv, poetry, Cargo), with
 * each format contributing its own dependency edges. Undefined when the
 * content is outside the format, so the check never guesses.
 */
function readTomlPackages(
  text: string,
  edgesOf: (entry: TomlTable) => readonly string[] | undefined,
): LockIndex | undefined {
  const doc = parseToml(text);
  if (doc === undefined) return undefined;
  const packages = doc['package'];
  if (!Array.isArray(packages) || !packages.every(isTomlTable)) return undefined;
  const index = emptyIndex();
  for (const entry of packages) {
    const name = entry['name'];
    if (typeof name !== 'string') return undefined;
    const version = entry['version'];
    if (version !== undefined && typeof version !== 'string') return undefined;
    const edges = edgesOf(entry);
    if (edges === undefined) return undefined;
    const normalized = pep503(name);
    recordEntry(index, normalized, typeof version === 'string' ? version : '', stableStringify(entry));
    for (const edge of edges) recordEdge(index, normalized, edge);
  }
  return index;
}

/** The lock file's dependency tables that name other packages. */
const NPM_LOCK_TABLES = ['dependencies', 'optionalDependencies', 'peerDependencies', 'requires'] as const;
/** The manifest's dependency tables that name direct dependencies. */
const NPM_MANIFEST_TABLES = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
] as const;

/** The package name of a `packages` key; the root and workspaces stay out. */
function npmNameFromKey(key: string): string | undefined {
  const at = key.lastIndexOf('node_modules/');
  return at < 0 ? undefined : key.slice(at + 'node_modules/'.length);
}

function recordNpmEntry(index: LockIndex, name: string, raw: Record<string, unknown>): void {
  const version = raw['version'];
  recordEntry(index, name, typeof version === 'string' ? version : '', stableStringify(raw));
  for (const table of NPM_LOCK_TABLES) {
    const dependencies = raw[table];
    if (!isRecord(dependencies)) continue;
    for (const dependency of Object.keys(dependencies)) recordEdge(index, name, dependency);
  }
}

/** package-lock.json, in the `packages` form (v2 and v3) or the v1 form. */
function readNpmLock(text: string): LockIndex | undefined {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isRecord(doc)) return undefined;
  const index = emptyIndex();
  const packages = doc['packages'];
  if (isRecord(packages)) {
    for (const [key, raw] of Object.entries(packages)) {
      if (!isRecord(raw)) return undefined;
      const name = npmNameFromKey(key);
      if (name === undefined) continue;
      recordNpmEntry(index, name, raw);
    }
    return index;
  }
  const dependencies = doc['dependencies'];
  if (isRecord(dependencies)) {
    const walk = (entries: Record<string, unknown>): void => {
      for (const [name, raw] of Object.entries(entries)) {
        if (!isRecord(raw)) continue;
        recordNpmEntry(index, name, raw);
        const nested = raw['dependencies'];
        if (isRecord(nested)) walk(nested);
      }
    };
    walk(dependencies);
    return index;
  }
  return undefined;
}

/** package.json, with every dependency table read as direct. */
function readNpmManifests(texts: readonly string[]): Map<string, string> | undefined {
  const specs = new Map<string, string>();
  for (const text of texts) {
    let doc: unknown;
    try {
      doc = JSON.parse(text);
    } catch {
      return undefined;
    }
    if (!isRecord(doc)) return undefined;
    for (const table of NPM_MANIFEST_TABLES) {
      const dependencies = doc[table];
      if (dependencies === undefined) continue;
      if (!isRecord(dependencies)) return undefined;
      for (const [name, spec] of Object.entries(dependencies)) {
        if (typeof spec !== 'string') return undefined;
        specs.set(name, spec);
      }
    }
  }
  return specs;
}

/** uv.lock records dependencies as arrays of `{ name = ... }` tables. */
function uvEdges(entry: TomlTable): readonly string[] | undefined {
  const edges: string[] = [];
  const collect = (value: TomlValue): boolean => {
    if (isTomlTable(value)) {
      const name = value['name'];
      if (typeof name !== 'string') return false;
      edges.push(pep503(name));
      return true;
    }
    if (Array.isArray(value)) return value.every(collect);
    return false;
  };
  const groups: (TomlValue | undefined)[] = [entry['dependencies'], entry['dev-dependencies']];
  const optional = entry['optional-dependencies'];
  if (optional !== undefined) {
    if (!isTomlTable(optional)) return undefined;
    groups.push(...Object.values(optional));
  }
  for (const group of groups) {
    if (group === undefined) continue;
    if (!collect(group)) return undefined;
  }
  return edges;
}

/** pyproject.toml's [project] tables, as uv reads direct dependencies. */
function readPep621Manifests(texts: readonly string[]): Map<string, string> | undefined {
  const specs = new Map<string, string>();
  for (const text of texts) {
    const doc = parseToml(text);
    if (doc === undefined) return undefined;
    const project = doc['project'];
    if (project === undefined) continue;
    if (!isTomlTable(project)) return undefined;
    const requirements: string[] = [];
    const dependencies = project['dependencies'];
    if (dependencies !== undefined) {
      if (!Array.isArray(dependencies) || !dependencies.every((item) => typeof item === 'string')) {
        return undefined;
      }
      requirements.push(...(dependencies as string[]));
    }
    const optional = project['optional-dependencies'];
    if (optional !== undefined) {
      if (!isTomlTable(optional)) return undefined;
      for (const group of Object.values(optional)) {
        if (!Array.isArray(group) || !group.every((item) => typeof item === 'string')) {
          return undefined;
        }
        requirements.push(...(group as string[]));
      }
    }
    for (const requirement of requirements) {
      const name = requirementName(requirement);
      if (name !== undefined) specs.set(name, requirement);
    }
  }
  return specs;
}

/**
 * poetry.lock records dependencies either as a table whose keys are names
 * (lock version 2.0) or as an array of `{ name = ... }` tables (2.1).
 */
function poetryEdges(entry: TomlTable): readonly string[] | undefined {
  const dependencies = entry['dependencies'];
  if (dependencies === undefined) return [];
  if (isTomlTable(dependencies)) return Object.keys(dependencies).map(pep503);
  if (!Array.isArray(dependencies)) return undefined;
  const edges: string[] = [];
  for (const item of dependencies) {
    if (!isTomlTable(item)) return undefined;
    const name = item['name'];
    if (typeof name !== 'string') return undefined;
    edges.push(pep503(name));
  }
  return edges;
}

/** pyproject.toml's [tool.poetry] tables, where poetry names its direct dependencies. */
function readPoetryManifests(texts: readonly string[]): Map<string, string> | undefined {
  const specs = new Map<string, string>();
  for (const text of texts) {
    const doc = parseToml(text);
    if (doc === undefined) return undefined;
    const tool = doc['tool'];
    if (tool === undefined) continue;
    if (!isTomlTable(tool)) return undefined;
    const poetry = tool['poetry'];
    if (poetry === undefined) continue;
    if (!isTomlTable(poetry)) return undefined;
    const sections: (TomlValue | undefined)[] = [poetry['dependencies'], poetry['dev-dependencies']];
    const groups = poetry['group'];
    if (groups !== undefined) {
      if (!isTomlTable(groups)) return undefined;
      for (const group of Object.values(groups)) {
        if (!isTomlTable(group)) return undefined;
        sections.push(group['dependencies']);
      }
    }
    for (const section of sections) {
      if (section === undefined) continue;
      if (!isTomlTable(section)) return undefined;
      for (const [name, spec] of Object.entries(section)) {
        if (name === 'python') continue; // The interpreter constraint, not a dependency.
        if (typeof spec !== 'string' && !isTomlTable(spec)) return undefined;
        specs.set(pep503(name), typeof spec === 'string' ? spec : stableStringify(spec));
      }
    }
  }
  return specs;
}

/** Cargo.lock records dependencies as name or `name version` strings. */
function cargoEdges(entry: TomlTable): readonly string[] | undefined {
  const dependencies = entry['dependencies'];
  if (dependencies === undefined) return [];
  if (!Array.isArray(dependencies) || !dependencies.every((item) => typeof item === 'string')) {
    return undefined;
  }
  return (dependencies as string[]).map((dependency) => dependency.split(/[ ?]/)[0]!);
}

/** The manifest sections of Cargo.toml that name direct dependencies. */
const CARGO_SECTIONS = ['dependencies', 'dev-dependencies', 'build-dependencies'] as const;

/** Cargo.toml, including its workspace and target-specific tables. */
function readCargoManifests(texts: readonly string[]): Map<string, string> | undefined {
  const specs = new Map<string, string>();
  const collect = (table: TomlTable): boolean => {
    for (const section of CARGO_SECTIONS) {
      const dependencies = table[section];
      if (dependencies === undefined) continue;
      if (!isTomlTable(dependencies)) return false;
      for (const [name, spec] of Object.entries(dependencies)) {
        if (typeof spec !== 'string' && !isTomlTable(spec)) return false;
        specs.set(name, typeof spec === 'string' ? spec : stableStringify(spec));
      }
    }
    return true;
  };
  for (const text of texts) {
    const doc = parseToml(text);
    if (doc === undefined) return undefined;
    if (!collect(doc)) return undefined;
    const workspace = doc['workspace'];
    if (workspace !== undefined && (!isTomlTable(workspace) || !collect(workspace))) {
      return undefined;
    }
    const targets = doc['target'];
    if (targets !== undefined) {
      if (!isTomlTable(targets)) return undefined;
      for (const target of Object.values(targets)) {
        if (!isTomlTable(target) || !collect(target)) return undefined;
      }
    }
  }
  return specs;
}

/** NuGet packages.lock.json lists direct and transitive entries per framework. */
function readNugetLock(text: string): LockIndex | undefined {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isRecord(doc)) return undefined;
  const frameworks = doc['dependencies'];
  if (!isRecord(frameworks)) return undefined;
  const index = emptyIndex();
  for (const framework of Object.values(frameworks)) {
    if (!isRecord(framework)) return undefined;
    for (const [rawName, raw] of Object.entries(framework)) {
      if (!isRecord(raw)) return undefined;
      const name = rawName.toLowerCase();
      const version = raw['resolved'];
      if (version !== undefined && typeof version !== 'string') return undefined;
      recordEntry(index, name, typeof version === 'string' ? version : '', stableStringify(raw));
      if (raw['type'] === 'Transitive') index.transitive.add(name);
      const dependencies = raw['dependencies'];
      if (dependencies === undefined) continue;
      if (!isRecord(dependencies)) return undefined;
      for (const dependency of Object.keys(dependencies)) {
        recordEdge(index, name, dependency.toLowerCase());
      }
    }
  }
  return index;
}

/** File extensions that carry a NuGet project's PackageReference entries. */
const NUGET_PROJECT_PATTERN = /\.(?:csproj|vbproj|fsproj)$/;

/** Lists a directory inside a copy; empty when it does not exist. */
type ListDir = (relativeDir: string) => Promise<readonly string[]>;

/**
 * The NuGet manifests: every project file beside the lock file, then each
 * Directory.Packages.props from its directory up to the repository root.
 */
async function nugetManifestsIn(dir: string, list: ListDir): Promise<readonly string[]> {
  const names = await list(dir);
  const manifests = names
    .filter((name) => NUGET_PROJECT_PATTERN.test(name))
    .map((name) => under(dir, name))
    .sort();
  let current = dir;
  for (;;) {
    const entries = current === dir ? names : await list(current);
    if (entries.includes('Directory.Packages.props')) {
      manifests.push(under(current, 'Directory.Packages.props'));
    }
    if (current === '.' || current === '') break;
    current = dirname(current);
  }
  return manifests;
}

const PACKAGE_REFERENCE_TAG = /<PackageReference\b[^>]*>/g;
const INCLUDE_ATTRIBUTE = /\bInclude="([^"]*)"/;
const VERSION_ATTRIBUTE = /\bVersion="([^"]*)"/;

/** Project files' PackageReference entries, by package name (lowercase). */
function readNugetManifests(texts: readonly string[]): Map<string, string> | undefined {
  const specs = new Map<string, string>();
  for (const text of texts) {
    for (const tag of text.match(PACKAGE_REFERENCE_TAG) ?? []) {
      const include = INCLUDE_ATTRIBUTE.exec(tag);
      if (include === null) continue;
      const version = VERSION_ATTRIBUTE.exec(tag);
      const name = include[1]!.toLowerCase();
      // The nearest non-empty version wins, so a project without a version
      // (central package management) takes the one Directory.Packages.props set.
      if (specs.get(name) === undefined || specs.get(name) === '') {
        specs.set(name, version?.[1] ?? '');
      }
    }
  }
  return specs;
}

/**
 * One lock file format's parse-only check: how to read the lock file, how
 * to find and read the manifests that name its direct dependencies, and
 * the blind spots a confirmed label must state.
 */
export interface LockfileFormat {
  /** The lock file's basename, as the reviewer knows it. */
  readonly name: string;
  /** The manifest the check reads, named for blind spots. */
  readonly manifestName: string;
  /** What a confirmed label of this format cannot see. */
  readonly blindSpot: string;
  /**
   * True when the lock file marks entries transitive but not which
   * package pulls them (NuGet): a changed transitive is then accepted
   * while a manifest dependency changed, and the blind spot says so.
   */
  readonly attributesTransitives: boolean;
  readLock(text: string): LockIndex | undefined;
  manifestsIn(lockDir: string, list: ListDir): Promise<readonly string[]>;
  readManifests(texts: readonly string[]): Map<string, string> | undefined;
}

/** A manifest fixed beside the lock file, whatever directory it is in. */
function manifestBeside(name: string): (lockDir: string) => Promise<readonly string[]> {
  return async (lockDir: string) => [under(lockDir, name)];
}

const CLOSURE_BLIND_SPOT =
  'the closure follows package names through the lock file\u2019s own recorded edges, so an unrelated change inside the closure cannot be told apart';

const NPM_FORMAT: LockfileFormat = {
  name: 'package-lock.json',
  manifestName: 'package.json',
  blindSpot: `Parse-only: the resolver is not re-run and hashes are not re-checked against the registry; ${CLOSURE_BLIND_SPOT}.`,
  attributesTransitives: false,
  readLock: readNpmLock,
  manifestsIn: manifestBeside('package.json'),
  readManifests: readNpmManifests,
};

const UV_FORMAT: LockfileFormat = {
  name: 'uv.lock',
  manifestName: 'pyproject.toml',
  blindSpot: `Parse-only: the resolver is not re-run and hashes are not re-checked against the registry; ${CLOSURE_BLIND_SPOT}.`,
  attributesTransitives: false,
  readLock: (text: string) => readTomlPackages(text, uvEdges),
  manifestsIn: manifestBeside('pyproject.toml'),
  readManifests: readPep621Manifests,
};

const POETRY_FORMAT: LockfileFormat = {
  name: 'poetry.lock',
  manifestName: 'pyproject.toml',
  blindSpot: `Parse-only: the resolver is not re-run and hashes are not re-checked against the registry; ${CLOSURE_BLIND_SPOT}.`,
  attributesTransitives: false,
  readLock: (text: string) => readTomlPackages(text, poetryEdges),
  manifestsIn: manifestBeside('pyproject.toml'),
  readManifests: readPoetryManifests,
};

const CARGO_FORMAT: LockfileFormat = {
  name: 'Cargo.lock',
  manifestName: 'Cargo.toml',
  blindSpot: `Parse-only: the resolver is not re-run and checksums are not re-checked against the registry; ${CLOSURE_BLIND_SPOT}.`,
  attributesTransitives: false,
  readLock: (text: string) => readTomlPackages(text, cargoEdges),
  manifestsIn: manifestBeside('Cargo.toml'),
  readManifests: readCargoManifests,
};

const NUGET_FORMAT: LockfileFormat = {
  name: 'packages.lock.json',
  manifestName: 'project files or Directory.Packages.props',
  blindSpot:
    'Parse-only: restore is not re-run and content hashes are not re-checked; the lock file does not record which package pulls a transitive entry, so any changed transitive is accepted while a manifest dependency changed.',
  attributesTransitives: true,
  readLock: readNugetLock,
  manifestsIn: nugetManifestsIn,
  readManifests: readNugetManifests,
};

/** The parse-only checks, by lock file basename. */
const LOCKFILE_FORMATS: Readonly<Record<string, LockfileFormat>> = {
  'package-lock.json': NPM_FORMAT,
  'uv.lock': UV_FORMAT,
  'poetry.lock': POETRY_FORMAT,
  'Cargo.lock': CARGO_FORMAT,
  'packages.lock.json': NUGET_FORMAT,
};

/** The format of the lock file at this path, when a check exists for it. */
export function lockfileFormatFor(path: string): LockfileFormat | undefined {
  return LOCKFILE_FORMATS[basename(path)];
}

/** One side of the lock file's story: its text and its manifests' texts. */
export interface LockfileSide {
  /** The lock file's content; null when this side has no such file. */
  readonly lock: string | null;
  /** The content of every manifest that side reads, in read order. */
  readonly manifests: readonly string[];
}

/** The outcome of one lock file's parse-only check. */
export type LockfileCheck =
  | { outcome: 'confirmed'; blindSpot: string }
  | { outcome: 'unexplained'; blindSpot: string }
  | { outcome: 'no check'; blindSpot: string };

/** Names reachable from the starts through the recorded dependency edges. */
function closureFrom(starts: readonly string[], edges: ReadonlyMap<string, ReadonlySet<string>>): Set<string> {
  const reached = new Set<string>();
  const queue = [...starts];
  while (queue.length > 0) {
    const name = queue.pop()!;
    if (reached.has(name)) continue;
    reached.add(name);
    for (const dependency of edges.get(name) ?? []) {
      if (!reached.has(dependency)) queue.push(dependency);
    }
  }
  return reached;
}

/** One changed lock entry: its name, and how the label names it. */
interface ChangedEntry {
  readonly name: string;
  readonly display: string;
}

function versionMapsEqual(
  oldVersions: ReadonlyMap<string, string>,
  newVersions: ReadonlyMap<string, string>,
): boolean {
  if (oldVersions.size !== newVersions.size) return false;
  for (const [version, fingerprint] of oldVersions) {
    if (newVersions.get(version) !== fingerprint) return false;
  }
  return true;
}

/** How one changed entry is named: `name old → new`, or `name@version`. */
function describeChange(
  name: string,
  oldVersions: ReadonlyMap<string, string>,
  newVersions: ReadonlyMap<string, string>,
): string {
  const label = (version: string): string => (version === '' ? name : `${name}@${version}`);
  const removed = [...oldVersions.keys()].filter((version) => !newVersions.has(version));
  const added = [...newVersions.keys()].filter((version) => !oldVersions.has(version));
  if (
    oldVersions.size === 1 &&
    newVersions.size === 1 &&
    removed.length === 1 &&
    added.length === 1 &&
    removed[0] !== '' &&
    added[0] !== ''
  ) {
    return `${name} ${removed[0]} → ${added[0]}`;
  }
  const parts: string[] = [];
  for (const version of removed) parts.push(label(version));
  for (const version of added) parts.push(label(version));
  for (const version of newVersions.keys()) {
    if (oldVersions.has(version) && oldVersions.get(version) !== newVersions.get(version)) {
      parts.push(`${label(version)} (content changed)`);
    }
  }
  return parts.join(', ');
}

function changedEntries(oldIndex: LockIndex, newIndex: LockIndex): ChangedEntry[] {
  const names = [...new Set([...oldIndex.versions.keys(), ...newIndex.versions.keys()])].sort();
  const changed: ChangedEntry[] = [];
  for (const name of names) {
    const oldVersions = oldIndex.versions.get(name) ?? new Map<string, string>();
    const newVersions = newIndex.versions.get(name) ?? new Map<string, string>();
    if (versionMapsEqual(oldVersions, newVersions)) continue;
    changed.push({ name, display: describeChange(name, oldVersions, newVersions) });
  }
  return changed;
}

/**
 * The parse-only check itself: every changed lock entry must belong to the
 * dependency closure of the changed manifest entries — the closure walked
 * through the lock file's own edges, on the side where the entry lives. A
 * change the manifest does not explain keeps the check's outcome at
 * `unexplained` with the entries named; a lock file or manifest outside
 * the format keeps it at `no check`.
 */
export function confirmLockfileChange(
  format: LockfileFormat,
  lockName: string,
  oldSide: LockfileSide,
  newSide: LockfileSide,
): LockfileCheck {
  const oldIndex =
    oldSide.lock === null ? emptyIndex() : format.readLock(oldSide.lock);
  if (oldIndex === undefined) {
    return { outcome: 'no check', blindSpot: `no check for this lockfile: the base ${lockName} did not parse` };
  }
  const newIndex =
    newSide.lock === null ? emptyIndex() : format.readLock(newSide.lock);
  if (newIndex === undefined) {
    return { outcome: 'no check', blindSpot: `no check for this lockfile: the head ${lockName} did not parse` };
  }
  if (oldSide.manifests.length === 0 && newSide.manifests.length === 0) {
    return {
      outcome: 'no check',
      blindSpot: `no check for this lockfile: no ${format.manifestName} beside it names its dependencies`,
    };
  }
  const oldSpecs = format.readManifests(oldSide.manifests);
  if (oldSpecs === undefined) {
    return { outcome: 'no check', blindSpot: `no check for this lockfile: its ${format.manifestName} did not parse` };
  }
  const newSpecs = format.readManifests(newSide.manifests);
  if (newSpecs === undefined) {
    return { outcome: 'no check', blindSpot: `no check for this lockfile: its ${format.manifestName} did not parse` };
  }
  const changedDirects = [...new Set([...oldSpecs.keys(), ...newSpecs.keys()])].filter(
    (name) => oldSpecs.get(name) !== newSpecs.get(name),
  );
  const explained = new Set<string>([
    ...closureFrom(changedDirects, newIndex.edges),
    ...closureFrom(changedDirects, oldIndex.edges),
  ]);
  const unexplained = changedEntries(oldIndex, newIndex).filter(
    (entry) =>
      !explained.has(entry.name) &&
      !(
        format.attributesTransitives &&
        changedDirects.length > 0 &&
        (oldIndex.transitive.has(entry.name) || newIndex.transitive.has(entry.name))
      ),
  );
  if (unexplained.length === 0) {
    return { outcome: 'confirmed', blindSpot: format.blindSpot };
  }
  const named = unexplained.map((entry) => entry.display);
  const head = named.slice(0, MAX_NAMED_ENTRIES).join(', ');
  const counted =
    named.length > MAX_NAMED_ENTRIES ? ` (+${named.length - MAX_NAMED_ENTRIES} more)` : '';
  return {
    outcome: 'unexplained',
    blindSpot: `entries the manifest change does not explain: ${head}${counted}; the check is parse-only, and hashes are not re-checked against the registry.`,
  };
}

/** Reads one file inside a copy; null when it does not exist there. */
async function readTextOrNull(absolute: string): Promise<string | null> {
  try {
    return await readFile(absolute, 'utf8');
  } catch {
    return null;
  }
}

/** Reads one side of a lock file's story inside one copy of the repository. */
async function readSide(
  copyRoot: string,
  lockPath: string,
  format: LockfileFormat,
): Promise<LockfileSide> {
  const lockAbsolute = pathInCopy(copyRoot, lockPath);
  const lock = lockAbsolute === undefined ? null : await readTextOrNull(lockAbsolute);
  const list: ListDir = async (relativeDir) => {
    const absolute = pathInCopy(copyRoot, relativeDir);
    if (absolute === undefined) return [];
    try {
      return (await readdir(absolute)).filter((name) => !name.startsWith('.'));
    } catch {
      return [];
    }
  };
  const manifests: string[] = [];
  for (const relative of await format.manifestsIn(dirname(lockPath), list)) {
    const absolute = pathInCopy(copyRoot, relative);
    if (absolute === undefined) continue;
    const text = await readTextOrNull(absolute);
    if (text !== null) manifests.push(text);
  }
  return { lock, manifests };
}

/** The assessment a check's outcome turns into, in place of the name rule's. */
function assessmentFor(
  format: LockfileFormat,
  lockName: string,
  oldSide: LockfileSide,
  newSide: LockfileSide,
): NoiseAssessment {
  const check = confirmLockfileChange(format, lockName, oldSide, newSide);
  if (check.outcome === 'confirmed') {
    return {
      label: 'lockfile',
      rule: 'lockfile-follows-manifest',
      state: 'confirmed',
      blindSpot: check.blindSpot,
    };
  }
  return {
    label: 'lockfile',
    rule: check.outcome === 'unexplained' ? 'lockfile-unexplained' : 'lockfile-name',
    state: 'claimed',
    blindSpot: check.blindSpot,
  };
}

/**
 * Runs the parse-only check on every part a check exists for, reading both
 * versions of the lock file and its manifests from the read-only copies —
 * never by running a package manager (the no-process tests prove it).
 * Returns the assessments by part path; the noise rules attach each one
 * only where the name rule's claim stands, so a renamed or
 * linguist-declared lock file keeps its own label.
 */
export async function confirmLockfileNoise(
  parts: readonly Part[],
  copies: { readonly base: string; readonly head: string },
): Promise<Map<string, NoiseAssessment>> {
  const overrides = new Map<string, NoiseAssessment>();
  await Promise.all(
    parts
      .filter((part) => !part.isBinary && lockfileFormatFor(part.path) !== undefined)
      .map(async (part) => {
        const format = lockfileFormatFor(part.path)!;
        const [oldSide, newSide] = await Promise.all([
          readSide(copies.base, part.previousPath ?? part.path, format),
          readSide(copies.head, part.path, format),
        ]);
        overrides.set(
          part.path,
          assessmentFor(format, basename(part.path), oldSide, newSide),
        );
      }),
  );
  return overrides;
}
