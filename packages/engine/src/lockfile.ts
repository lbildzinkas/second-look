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
 *
 * npm, uv and Cargo workspaces: the members are the directories the root
 * manifest's own workspace declaration names, found by listing and reading
 * files, and each member's manifest names direct dependencies too. The
 * lock's own record of a project — the root or a member — mirrors that
 * project's manifest rather than following from it, so it is explained
 * only when the pull request changes that manifest and the record names
 * no dependency the manifest does not declare.
 */

import { readdir, readFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
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
 * the dependency edges the lock file itself records, fingerprints of the
 * entries no package name covers (NuGet's libraries section), and the
 * lock's own records of the workspace's projects by directory, which their manifests' changes explain.
 */
interface LockIndex {
  versions: Map<string, Map<string, Set<string>>>;
  edges: Map<string, Set<string>>;
  roots: Map<string, string>;
  projects: Map<string, ProjectRecord>;
}

/**
 * The lock's own record of one workspace project, keyed by its directory
 * beside the lock file ('.' for the root): npm's folder record with the
 * node_modules link stubs that point at it, or the uv or Cargo entry that
 * records the project itself.
 */
interface ProjectRecord {
  /** How a claimed label names the record. */
  readonly display: string;
  readonly fingerprint: string;
  /** The package name the record carries, compared as the format compares names. */
  readonly name: string | undefined;
  /** The dependencies the record names. */
  readonly edges: ReadonlySet<string>;
  /** False when the record points anywhere but the project's own folder: a registry, a tarball or a hash. */
  readonly local: boolean;
}

function emptyIndex(): LockIndex {
  return {
    versions: new Map(),
    edges: new Map(),
    roots: new Map(),
    projects: new Map(),
  };
}

function recordEntry(index: LockIndex, name: string, version: string, fingerprint: string): void {
  let versions = index.versions.get(name);
  if (versions === undefined) {
    versions = new Map();
    index.versions.set(name, versions);
  }
  let fingerprints = versions.get(version);
  if (fingerprints === undefined) {
    fingerprints = new Set();
    versions.set(version, fingerprints);
  }
  fingerprints.add(fingerprint);
}

function recordEdge(index: LockIndex, name: string, dependency: string): void {
  let edges = index.edges.get(name);
  if (edges === undefined) {
    edges = new Set();
    index.edges.set(name, edges);
  }
  edges.add(dependency);
}

/** The keys a TOML lock entry fetches a package by, which a project's own entry never carries. */
const TOML_REMOTE_KEYS = ['sdist', 'wheels', 'checksum'] as const;

/**
 * Reads a `[[package]]`-shaped TOML lock file (uv, poetry, Cargo), with
 * each format contributing its own dependency edges and its own way of
 * telling the workspace's projects' entries apart, by directory, which
 * mirror their manifests rather than following from them. Undefined when
 * the content is outside the format, so the check never guesses.
 */
function readTomlPackages(
  text: string,
  edgesOf: (entry: TomlTable) => readonly string[] | undefined,
  projectOf?: (entry: TomlTable) => string | undefined,
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
    const dir = projectOf?.(entry);
    if (dir !== undefined) {
      // Two entries for one project is outside the format.
      if (index.projects.has(dir)) return undefined;
      index.projects.set(dir, {
        display: `the ${normalized} entry`,
        fingerprint: stableStringify(entry),
        name: normalized,
        edges: new Set(edges),
        local: TOML_REMOTE_KEYS.every((key) => entry[key] === undefined),
      });
      // A member is a package the others may depend on, so the closure walks through it.
      if (dir !== '.') for (const edge of edges) recordEdge(index, normalized, edge);
      continue;
    }
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
/** The manifest's override tables, whose nested tables scope an override to a subtree. */
const NPM_OVERRIDE_TABLES = ['overrides', 'resolutions'] as const;

/** The package name of a `packages` key; undefined for the root and workspace keys. */
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

/** The keys an npm record fetches a package by, which a project's own folder record never carries. */
const NPM_REMOTE_KEYS = ['link', 'resolved', 'integrity'] as const;

/**
 * One npm folder record — the root's or a workspace folder's — with the
 * node_modules link stubs and the legacy mirror's own entries for it.
 * Local only when the record itself fetches nothing, every stub is a
 * bare link named after the package the folder holds, and every mirror
 * entry fetches nothing either.
 */
function npmProjectRecord(
  dir: string,
  raw: Record<string, unknown>,
  stubs: readonly (readonly [string, Record<string, unknown>])[],
  mirrors: readonly (readonly [string, Record<string, unknown>])[],
): ProjectRecord {
  const name = typeof raw['name'] === 'string' ? raw['name'] : undefined;
  const linkName = name ?? basename(dir);
  const edges = new Set<string>();
  for (const table of NPM_MANIFEST_TABLES) {
    const dependencies = raw[table];
    if (isRecord(dependencies)) for (const dependency of Object.keys(dependencies)) edges.add(dependency);
  }
  // The legacy mirror records a project's own dependencies under `requires`.
  for (const [, mirror] of mirrors) {
    const requires = mirror['requires'];
    if (isRecord(requires)) for (const dependency of Object.keys(requires)) edges.add(dependency);
  }
  const sorted = [...stubs].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const mirrored = [...mirrors].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return {
    display: dir === '.' ? 'the root entry' : `the ${dir} entry`,
    fingerprint: stableStringify([raw, sorted, mirrored]),
    name,
    edges,
    local:
      NPM_REMOTE_KEYS.every((key) => raw[key] === undefined) &&
      sorted.every(
        ([key, stub]) => Object.keys(stub).length === 2 && npmNameFromKey(key) === linkName,
      ) &&
      mirrored.every(([, mirror]) => NPM_REMOTE_KEYS.every((key) => mirror[key] === undefined)),
  };
}

/**
 * Walks one npm `dependencies` tree into per-name entries — the whole of
 * a v1 lock, or the legacy mirror a lockfileVersion 2 lock writes beside
 * `packages` — so a mirror-only addition or divergence is a named changed
 * entry on its own. A declared member's own entry, whose version is
 * `file:` naming its folder, mirrors that member's manifest like its
 * folder record does, so it is collected for the project records the
 * caller builds instead; the v1 form has no folder records, so nothing
 * is ever collected for it. Returns the collected entries by folder.
 */
function walkNpmDependencies(
  index: LockIndex,
  entries: Record<string, unknown>,
  memberDirs: ReadonlySet<string>,
): Map<string, [string, Record<string, unknown>][]> {
  const mirrors = new Map<string, [string, Record<string, unknown>][]>();
  const walk = (entries: Record<string, unknown>): void => {
    for (const [name, raw] of Object.entries(entries)) {
      if (!isRecord(raw)) continue;
      const version = raw['version'];
      const dir =
        typeof version === 'string' && version.startsWith('file:')
          ? version.slice('file:'.length)
          : undefined;
      if (dir !== undefined && memberDirs.has(dir)) {
        mirrors.set(dir, [...(mirrors.get(dir) ?? []), [name, raw]]);
      } else {
        recordNpmEntry(index, name, raw);
      }
      const nested = raw['dependencies'];
      if (isRecord(nested)) walk(nested);
    }
  };
  walk(entries);
  return mirrors;
}

/**
 * package-lock.json, in the `packages` form (v2 and v3) or the v1 form.
 * In the `packages` form every folder record is a project record, a
 * link stub pointing at a declared member's folder belongs to that
 * member's record, and so does the member's own `file:` entry in the
 * legacy mirror; any other link stays an entry like a package.
 */
function readNpmLock(text: string, members: readonly WorkspaceMember[]): LockIndex | undefined {
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
    const memberDirs = new Set(members.map((member) => member.dir));
    const folders = new Map<string, Record<string, unknown>>();
    const stubs = new Map<string, [string, Record<string, unknown>][]>();
    for (const [key, raw] of Object.entries(packages)) {
      if (!isRecord(raw)) return undefined;
      const name = npmNameFromKey(key);
      if (name === undefined) {
        const dir = key === '' ? '.' : key;
        if (folders.has(dir)) return undefined;
        folders.set(dir, raw);
        continue;
      }
      const target = raw['resolved'];
      if (raw['link'] === true && typeof target === 'string' && memberDirs.has(target)) {
        stubs.set(target, [...(stubs.get(target) ?? []), [key, raw]]);
        continue;
      }
      recordNpmEntry(index, name, raw);
    }
    const mirror = doc['dependencies'];
    const mirrors = isRecord(mirror)
      ? walkNpmDependencies(index, mirror, memberDirs)
      : new Map<string, [string, Record<string, unknown>][]>();
    for (const [dir, raw] of folders) {
      index.projects.set(dir, npmProjectRecord(dir, raw, stubs.get(dir) ?? [], mirrors.get(dir) ?? []));
    }
    // A stub, or a mirror entry, whose member folder has no record of its
    // own stays an entry like a package.
    for (const [target, linked] of stubs) {
      if (folders.has(target)) continue;
      for (const [key, raw] of linked) recordNpmEntry(index, npmNameFromKey(key)!, raw);
    }
    for (const [dir, mirrored] of mirrors) {
      if (folders.has(dir)) continue;
      for (const [name, raw] of mirrored) recordNpmEntry(index, name, raw);
    }
    return index;
  }
  const dependencies = doc['dependencies'];
  if (isRecord(dependencies)) {
    walkNpmDependencies(index, dependencies, new Set<string>());
    return index;
  }
  return undefined;
}

/** package.json, with every dependency and override table read as direct. */
function readNpmManifests(texts: readonly string[]): Map<string, string> | undefined {
  const specs = new Map<string, string>();
  const add = (name: string, spec: string): void => {
    specs.set(name, specs.has(name) ? `${specs.get(name)} ${spec}` : spec);
  };
  const collectOverrides = (entries: Record<string, unknown>): boolean => {
    for (const [name, spec] of Object.entries(entries)) {
      if (typeof spec === 'string') {
        add(name, spec);
        continue;
      }
      if (!isRecord(spec)) return false;
      add(name, stableStringify(spec));
      if (!collectOverrides(spec)) return false;
    }
    return true;
  };
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
        add(name, spec);
      }
    }
    for (const table of NPM_OVERRIDE_TABLES) {
      const overrides = doc[table];
      if (overrides === undefined) continue;
      if (!isRecord(overrides)) return undefined;
      if (!collectOverrides(overrides)) return undefined;
    }
  }
  return specs;
}

/** A package.json's parsed object; undefined when it is not one. */
function parseNpmManifest(manifest: string): Record<string, unknown> | undefined {
  try {
    const doc: unknown = JSON.parse(manifest);
    return isRecord(doc) ? doc : undefined;
  } catch {
    return undefined;
  }
}

/** package.json's `workspaces`, as an array or a `packages` array, with `!` globs excluding. */
function npmWorkspaceGlobs(manifest: string): WorkspaceGlobs | undefined {
  const declared = parseNpmManifest(manifest)?.['workspaces'];
  const globs = isRecord(declared) ? declared['packages'] : declared;
  if (!isStringArray(globs)) return undefined;
  return {
    include: globs.filter((glob) => !glob.startsWith('!')),
    exclude: globs.filter((glob) => glob.startsWith('!')).map((glob) => glob.slice(1)),
  };
}

/** The name a package.json declares. */
function npmProjectName(manifest: string): string | undefined {
  const name = parseNpmManifest(manifest)?.['name'];
  return typeof name === 'string' ? name : undefined;
}

/** uv.lock records dependencies as arrays of `{ name = ... }` tables, with optional and dev groups keyed by name. */
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
  const groups: (TomlValue | undefined)[] = [entry['dependencies']];
  const optional = entry['optional-dependencies'];
  if (optional !== undefined) {
    if (!isTomlTable(optional)) return undefined;
    groups.push(...Object.values(optional));
  }
  const dev = entry['dev-dependencies'];
  if (dev !== undefined) {
    if (isTomlTable(dev)) groups.push(...Object.values(dev));
    else groups.push(dev);
  }
  for (const group of groups) {
    if (group === undefined) continue;
    if (!collect(group)) return undefined;
  }
  return edges;
}

/**
 * uv.lock records the project itself with a virtual or editable source
 * of ".", and each workspace member with one of the member's directory.
 */
function uvProjectOf(members: readonly WorkspaceMember[]): (entry: TomlTable) => string | undefined {
  const dirs = new Set(members.map((member) => member.dir));
  return (entry) => {
    const source = entry['source'];
    if (!isTomlTable(source)) return undefined;
    const path = source['editable'] ?? source['virtual'];
    if (typeof path !== 'string') return undefined;
    return path === '.' || dirs.has(path) ? path : undefined;
  };
}

/** The table at a dotted path inside a TOML document; undefined when any step is missing or not a table. */
function tomlTableAt(doc: TomlTable, path: readonly string[]): TomlTable | undefined {
  let current: TomlTable = doc;
  for (const key of path) {
    const next = current[key];
    if (!isTomlTable(next)) return undefined;
    current = next;
  }
  return current;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

/** A `members` and `exclude` pair of globs, the shape uv and Cargo both declare a workspace with. */
function tomlWorkspaceGlobs(manifest: string, path: readonly string[]): WorkspaceGlobs | undefined {
  const doc = parseToml(manifest);
  if (doc === undefined) return undefined;
  const workspace = tomlTableAt(doc, path);
  if (workspace === undefined) return undefined;
  const members = workspace['members'];
  const exclude = workspace['exclude'] ?? [];
  if (!isStringArray(members) || !isStringArray(exclude)) return undefined;
  return { include: members, exclude };
}

/** pyproject.toml's [tool.uv.workspace] table. */
function uvWorkspaceGlobs(manifest: string): WorkspaceGlobs | undefined {
  return tomlWorkspaceGlobs(manifest, ['tool', 'uv', 'workspace']);
}

/** The PEP 503 name pyproject.toml's [project] table declares. */
function pep621ProjectName(manifest: string): string | undefined {
  const doc = parseToml(manifest);
  const name = doc === undefined ? undefined : tomlTableAt(doc, ['project'])?.['name'];
  return typeof name === 'string' ? pep503(name) : undefined;
}

/** A PEP 735 include-group reference, the one table a dependency group may hold. */
function isIncludeGroup(item: TomlValue): boolean {
  if (!isTomlTable(item)) return false;
  const keys = Object.keys(item);
  return keys.length === 1 && keys[0] === 'include-group' && typeof item['include-group'] === 'string';
}

/**
 * pyproject.toml's [project] and [dependency-groups] tables, the PEP 621
 * form both uv and poetry 2 read, added to the specs by requirement name.
 */
function readProjectTables(doc: TomlTable, specs: Map<string, string>): boolean {
  const requirements: string[] = [];
  const push = (value: TomlValue): boolean => {
    if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
      return false;
    }
    requirements.push(...(value as string[]));
    return true;
  };
  const project = doc['project'];
  if (project !== undefined) {
    if (!isTomlTable(project)) return false;
    const dependencies = project['dependencies'];
    if (dependencies !== undefined && !push(dependencies)) return false;
    const optional = project['optional-dependencies'];
    if (optional !== undefined) {
      if (!isTomlTable(optional)) return false;
      for (const group of Object.values(optional)) {
        if (!push(group)) return false;
      }
    }
  }
  const dependencyGroups = doc['dependency-groups'];
  if (dependencyGroups !== undefined) {
    if (!isTomlTable(dependencyGroups)) return false;
    for (const group of Object.values(dependencyGroups)) {
      if (!Array.isArray(group)) return false;
      if (!push(group.filter((item) => !isIncludeGroup(item)))) return false;
    }
  }
  for (const requirement of requirements) {
    const name = requirementName(requirement);
    if (name !== undefined) specs.set(name, requirement);
  }
  return true;
}

/** pyproject.toml's [project], [dependency-groups] and [tool.uv] tables, where uv records direct dependencies. */
function readPep621Manifests(texts: readonly string[]): Map<string, string> | undefined {
  const specs = new Map<string, string>();
  for (const text of texts) {
    const doc = parseToml(text);
    if (doc === undefined) return undefined;
    if (!readProjectTables(doc, specs)) return undefined;
    const tool = doc['tool'];
    if (tool !== undefined) {
      if (!isTomlTable(tool)) return undefined;
      const uv = tool['uv'];
      if (uv !== undefined) {
        if (!isTomlTable(uv)) return undefined;
        const dev = uv['dev-dependencies'];
        if (dev !== undefined) {
          if (!Array.isArray(dev) || !dev.every((item) => typeof item === 'string')) return undefined;
          for (const requirement of dev as string[]) {
            const name = requirementName(requirement);
            if (name !== undefined) specs.set(name, requirement);
          }
        }
      }
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

/** pyproject.toml's [project] tables and the [tool.poetry] tables, where poetry names its direct dependencies. */
function readPoetryManifests(texts: readonly string[]): Map<string, string> | undefined {
  const specs = new Map<string, string>();
  for (const text of texts) {
    const doc = parseToml(text);
    if (doc === undefined) return undefined;
    if (!readProjectTables(doc, specs)) return undefined;
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
  return (dependencies as string[]).map((dependency) => pep503(dependency.split(/[ ?]/)[0]!));
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
        if (typeof spec === 'string') {
          specs.set(pep503(name), spec);
          continue;
        }
        if (!isTomlTable(spec)) return false;
        const renamed = spec['package'];
        if (renamed !== undefined && typeof renamed !== 'string') return false;
        specs.set(pep503(typeof renamed === 'string' ? renamed : name), stableStringify(spec));
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

/** The package names the Cargo.toml files declare for the project itself. */
function cargoProjectNames(texts: readonly string[]): Set<string> {
  const names = new Set<string>();
  for (const text of texts) {
    const doc = parseToml(text);
    if (doc === undefined) continue;
    const pkg = doc['package'];
    if (!isTomlTable(pkg)) continue;
    const name = pkg['name'];
    if (typeof name === 'string') names.add(pep503(name));
  }
  return names;
}

/**
 * Cargo.lock records the project and each workspace member with no
 * source and no path, under the name its own Cargo.toml declares.
 */
function cargoProjectOf(
  manifests: readonly string[],
  members: readonly WorkspaceMember[],
): (entry: TomlTable) => string | undefined {
  const dirs = new Map<string, string>();
  for (const member of members) {
    for (const name of cargoProjectNames([member.manifest])) dirs.set(name, member.dir);
  }
  for (const name of cargoProjectNames(manifests)) dirs.set(name, '.');
  return (entry) => {
    const name = entry['name'];
    if (entry['source'] !== undefined || typeof name !== 'string') return undefined;
    return dirs.get(pep503(name));
  };
}

/** Cargo.toml's [workspace] table. */
function cargoWorkspaceGlobs(manifest: string): WorkspaceGlobs | undefined {
  return tomlWorkspaceGlobs(manifest, ['workspace']);
}

/** The one package name a Cargo.toml declares, normalized. */
function cargoProjectName(manifest: string): string | undefined {
  const [name] = cargoProjectNames([manifest]);
  return name;
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
      const dependencies = raw['dependencies'];
      if (dependencies === undefined) continue;
      if (!isRecord(dependencies)) return undefined;
      for (const dependency of Object.keys(dependencies)) {
        recordEdge(index, name, dependency.toLowerCase());
      }
    }
  }
  const libraries = doc['libraries'];
  if (isRecord(libraries)) index.roots.set('libraries section', stableStringify(libraries));
  return index;
}

/** File extensions that carry a NuGet project's PackageReference entries. */
const NUGET_PROJECT_PATTERN = /\.(?:csproj|vbproj|fsproj)$/;

/** Lists a directory inside a copy; empty when it does not exist. */
type ListDir = (relativeDir: string) => Promise<readonly string[]>;

/** The member directories a workspace declaration names, as globs relative to the root manifest's directory. */
interface WorkspaceGlobs {
  readonly include: readonly string[];
  readonly exclude: readonly string[];
}

/** How many workspace members one side reads before ignoring the rest, whose records then stay named. */
const MAX_MEMBERS = 500;
/** How deep a `**` glob walks below where it starts. */
const MAX_GLOB_DEPTH = 8;

/**
 * A glob's path segments, `.` and empty ones dropped; undefined for an
 * absolute glob or one that climbs out with `..`, so a member is always
 * below the root.
 */
function globSegments(glob: string): readonly string[] | undefined {
  if (glob.startsWith('/')) return undefined;
  const segments = glob.split('/').filter((segment) => segment !== '' && segment !== '.');
  return segments.includes('..') || segments.length === 0 ? undefined : segments;
}

/** True when one character matches a bracket class's body: characters and ranges, `!` or `^` negating. */
function classMatches(body: string, char: string): boolean {
  const negated = body.startsWith('!') || body.startsWith('^');
  const items = negated ? body.slice(1) : body;
  let matched = false;
  for (let i = 0; i < items.length; i++) {
    if (items[i + 1] === '-' && i + 2 < items.length) {
      if (char >= items[i]! && char <= items[i + 2]!) matched = true;
      i += 2;
    } else if (items[i] === char) {
      matched = true;
    }
  }
  return matched !== negated;
}

/**
 * How many pattern characters match the name's character at this
 * position — one, or a whole bracket class — and 0 when it does not
 * match; `*` is the caller's.
 */
function patternStep(pattern: string, at: number, char: string): number {
  const token = pattern[at];
  if (token === '?') return 1;
  if (token === '[') {
    const close = pattern.indexOf(']', at + 2);
    if (close > at) return classMatches(pattern.slice(at + 1, close), char) ? close + 1 - at : 0;
  }
  return token === char ? 1 : 0;
}

/**
 * True when a name matches one glob segment: `*`, `?` and bracket
 * classes, never across a slash. Matched by backtracking only to the
 * last `*`, so a hostile glob costs at most the product of the lengths.
 */
function segmentMatches(pattern: string, name: string): boolean {
  let p = 0;
  let n = 0;
  let starP = -1;
  let starN = 0;
  while (n < name.length) {
    if (pattern[p] === '*') {
      starP = p++;
      starN = n;
      continue;
    }
    const step = p < pattern.length ? patternStep(pattern, p, name[n]!) : 0;
    if (step > 0) {
      p += step;
      n++;
      continue;
    }
    if (starP < 0) return false;
    p = starP + 1;
    n = ++starN;
  }
  while (pattern[p] === '*') p++;
  return p === pattern.length;
}

/** True when a directory's segments match a glob's, `**` standing for any number of directories. */
function pathMatches(glob: readonly string[], parts: readonly string[]): boolean {
  const failed = new Set<string>();
  const match = (g: number, p: number): boolean => {
    if (g === glob.length) return p === parts.length;
    if (failed.has(`${g},${p}`)) return false;
    const matched =
      glob[g] === '**'
        ? match(g + 1, p) || (p < parts.length && match(g, p + 1))
        : p < parts.length && segmentMatches(glob[g]!, parts[p]!) && match(g + 1, p + 1);
    if (!matched) failed.add(`${g},${p}`);
    return matched;
  };
  return match(0, 0);
}

/** True when a directory, or one it is inside, matches the glob: an excluded directory takes its subtree with it. */
function matchesOrUnder(glob: readonly string[], dir: string): boolean {
  const parts = dir.split('/');
  return parts.some((_, i) => pathMatches(glob, parts.slice(0, i + 1)));
}

function joinDir(dir: string, name: string): string {
  return dir === '' ? name : `${dir}/${name}`;
}

/** A directory relative to the lock file's, as a path in the copy. */
function dirBeside(lockDir: string, dir: string): string {
  return dir === '' ? lockDir : under(lockDir, dir);
}

/** Every directory at or below one, `node_modules` aside, down to the glob depth limit. */
async function descendants(lockDir: string, dir: string, list: ListDir): Promise<string[]> {
  const found = [dir];
  let level = [dir];
  for (let depth = 0; depth < MAX_GLOB_DEPTH && found.length < MAX_MEMBERS; depth++) {
    const next: string[] = [];
    for (const parent of level) {
      for (const name of await list(dirBeside(lockDir, parent))) {
        if (name !== 'node_modules') next.push(joinDir(parent, name));
      }
    }
    found.push(...next);
    level = next;
  }
  return found;
}

/**
 * The paths a glob's segments name below the lock file's directory,
 * walked one segment at a time: a plain segment is taken as named, a
 * pattern matched against the directory's listing, and `**` expanded to
 * every directory below. A path that is a file, or missing, is kept here
 * and dropped later when no member manifest is found in it.
 */
async function expandGlob(
  lockDir: string,
  segments: readonly string[],
  list: ListDir,
): Promise<string[]> {
  let current = [''];
  for (const segment of segments) {
    const next = new Set<string>();
    for (const dir of current) {
      if (segment === '**') {
        for (const below of await descendants(lockDir, dir, list)) next.add(below);
      } else if (!/[*?[]/.test(segment)) {
        next.add(joinDir(dir, segment));
      } else {
        for (const name of await list(dirBeside(lockDir, dir))) {
          if (segmentMatches(segment, name)) next.add(joinDir(dir, name));
        }
      }
    }
    current = [...next].slice(0, MAX_MEMBERS);
  }
  return current.filter((dir) => dir !== '');
}

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

const PACKAGE_TAGS = /<Package(?:Reference|Version)\b[^>]*>/g;
const INCLUDE_ATTRIBUTE = /\b(?:Include|Update)="([^"]*)"/;
const VERSION_ATTRIBUTE = /\bVersion="([^"]*)"/;
const VERSION_OVERRIDE_ATTRIBUTE = /\bVersionOverride="([^"]*)"/;

/** Project files' PackageReference and central PackageVersion entries, by package name (lowercase). */
function readNugetManifests(texts: readonly string[]): Map<string, string> | undefined {
  const specs = new Map<string, string>();
  for (const text of texts) {
    for (const tag of text.match(PACKAGE_TAGS) ?? []) {
      const include = INCLUDE_ATTRIBUTE.exec(tag);
      if (include === null) continue;
      const version = VERSION_ATTRIBUTE.exec(tag) ?? VERSION_OVERRIDE_ATTRIBUTE.exec(tag);
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
  /** The manifest the check reads, named for blind spots; a workspace member's manifest has this name too. */
  readonly manifestName: string;
  /** What a confirmed label of this format cannot see. */
  readonly blindSpot: string;
  /**
   * Reads the lock file; the root manifests' texts and the declared
   * members tell its own records of the workspace's projects apart.
   */
  readLock(
    text: string,
    manifests: readonly string[],
    members: readonly WorkspaceMember[],
  ): LockIndex | undefined;
  manifestsIn(lockDir: string, list: ListDir): Promise<readonly string[]>;
  readManifests(texts: readonly string[]): Map<string, string> | undefined;
  /** The member globs the root manifest's own workspace declaration names; absent for a format with no workspaces. */
  readonly workspaceGlobs?: (rootManifest: string) => WorkspaceGlobs | undefined;
  /** The package name a manifest declares for its own project, compared as the lock file records it. */
  readonly projectName?: (manifest: string) => string | undefined;
}

/** A manifest fixed beside the lock file, whatever directory it is in. */
function manifestBeside(name: string): (lockDir: string) => Promise<readonly string[]> {
  return async (lockDir: string) => [under(lockDir, name)];
}

const CLOSURE_BLIND_SPOT =
  'the closure follows package names through the lock file\u2019s own recorded edges, so an unrelated change inside the closure cannot be told apart';

const WORKSPACE_BLIND_SPOT =
  'workspace members are only the directories the root manifest\u2019s workspace declaration names, and the lock\u2019s own record of the root or a member is accepted only when the pull request also changes that project\u2019s manifest, the record names no dependency that manifest does not declare, and it points at no source but the project\u2019s own folder';

const NPM_FORMAT: LockfileFormat = {
  name: 'package-lock.json',
  manifestName: 'package.json',
  blindSpot: `Parse-only: the resolver is not re-run and hashes are not re-checked against the registry; ${WORKSPACE_BLIND_SPOT}; ${CLOSURE_BLIND_SPOT}.`,
  readLock: (text, _manifests, members) => readNpmLock(text, members),
  manifestsIn: manifestBeside('package.json'),
  readManifests: readNpmManifests,
  workspaceGlobs: npmWorkspaceGlobs,
  projectName: npmProjectName,
};

const UV_FORMAT: LockfileFormat = {
  name: 'uv.lock',
  manifestName: 'pyproject.toml',
  blindSpot: `Parse-only: the resolver is not re-run and hashes are not re-checked against the registry; ${WORKSPACE_BLIND_SPOT}; ${CLOSURE_BLIND_SPOT}.`,
  readLock: (text, _manifests, members) => readTomlPackages(text, uvEdges, uvProjectOf(members)),
  manifestsIn: manifestBeside('pyproject.toml'),
  readManifests: readPep621Manifests,
  workspaceGlobs: uvWorkspaceGlobs,
  projectName: pep621ProjectName,
};

const POETRY_FORMAT: LockfileFormat = {
  name: 'poetry.lock',
  manifestName: 'pyproject.toml',
  blindSpot: `Parse-only: the resolver is not re-run and hashes are not re-checked against the registry; ${CLOSURE_BLIND_SPOT}.`,
  readLock: (text: string) => readTomlPackages(text, poetryEdges),
  manifestsIn: manifestBeside('pyproject.toml'),
  readManifests: readPoetryManifests,
};

const CARGO_FORMAT: LockfileFormat = {
  name: 'Cargo.lock',
  manifestName: 'Cargo.toml',
  blindSpot: `Parse-only: the resolver is not re-run and checksums are not re-checked against the registry; ${WORKSPACE_BLIND_SPOT}; ${CLOSURE_BLIND_SPOT}.`,
  readLock: (text, manifests, members) =>
    readTomlPackages(text, cargoEdges, cargoProjectOf(manifests, members)),
  manifestsIn: manifestBeside('Cargo.toml'),
  readManifests: readCargoManifests,
  workspaceGlobs: cargoWorkspaceGlobs,
  projectName: cargoProjectName,
};

const NUGET_FORMAT: LockfileFormat = {
  name: 'packages.lock.json',
  manifestName: 'project files or Directory.Packages.props',
  blindSpot: `Parse-only: restore is not re-run and content hashes are not re-checked; ${CLOSURE_BLIND_SPOT}.`,
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

/** One workspace member a side declares: its directory beside the lock file and its manifest's text. */
export interface WorkspaceMember {
  /** The member's directory, relative to the lock file's, in forward slashes. */
  readonly dir: string;
  readonly manifest: string;
}

/** One side of the lock file's story: its text, its manifests' texts and its workspace members. */
export interface LockfileSide {
  /** The lock file's content; null when this side has no such file. */
  readonly lock: string | null;
  /** The content of every root manifest that side reads, in read order. */
  readonly manifests: readonly string[];
  /** The members the root manifest's workspace declaration names on that side, by directory. */
  readonly members: readonly WorkspaceMember[];
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

/** True when both sides carry exactly the same fingerprints, whatever the order. */
function fingerprintsEqual(before: ReadonlySet<string>, after: ReadonlySet<string>): boolean {
  if (before.size !== after.size) return false;
  for (const fingerprint of before) {
    if (!after.has(fingerprint)) return false;
  }
  return true;
}

function versionMapsEqual(
  oldVersions: ReadonlyMap<string, ReadonlySet<string>>,
  newVersions: ReadonlyMap<string, ReadonlySet<string>>,
): boolean {
  if (oldVersions.size !== newVersions.size) return false;
  for (const [version, fingerprints] of oldVersions) {
    const after = newVersions.get(version);
    if (after === undefined || !fingerprintsEqual(fingerprints, after)) return false;
  }
  return true;
}

/** How one changed entry is named: `name old → new`, or `name@version`. */
function describeChange(
  name: string,
  oldVersions: ReadonlyMap<string, ReadonlySet<string>>,
  newVersions: ReadonlyMap<string, ReadonlySet<string>>,
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
  for (const [version, fingerprints] of newVersions) {
    const before = oldVersions.get(version);
    if (before !== undefined && !fingerprintsEqual(before, fingerprints)) {
      parts.push(`${label(version)} (content changed)`);
    }
  }
  return parts.join(', ');
}

function changedEntries(oldIndex: LockIndex, newIndex: LockIndex): ChangedEntry[] {
  const names = [...new Set([...oldIndex.versions.keys(), ...newIndex.versions.keys()])].sort();
  const changed: ChangedEntry[] = [];
  for (const name of names) {
    const oldVersions = oldIndex.versions.get(name) ?? new Map<string, Set<string>>();
    const newVersions = newIndex.versions.get(name) ?? new Map<string, Set<string>>();
    if (versionMapsEqual(oldVersions, newVersions)) continue;
    changed.push({ name, display: describeChange(name, oldVersions, newVersions) });
  }
  return changed;
}

/** Changed entries no package name covers: NuGet's libraries section. */
function changedRoots(oldIndex: LockIndex, newIndex: LockIndex): ChangedEntry[] {
  const keys = [...new Set([...oldIndex.roots.keys(), ...newIndex.roots.keys()])].sort();
  const changed: ChangedEntry[] = [];
  for (const key of keys) {
    const before = oldIndex.roots.get(key);
    const after = newIndex.roots.get(key);
    if (before === after) continue;
    const name = `the ${key} entry`;
    const note = before === undefined ? 'added' : after === undefined ? 'removed' : 'content changed';
    changed.push({ name, display: `${name} (${note})` });
  }
  return changed;
}

/** What one side's manifest of one workspace project tells the check. */
interface ProjectManifest {
  /** The manifest's text, compared across sides to tell whether the pull request changed it. */
  readonly text: string;
  /** Its direct dependencies' specs, by name. */
  readonly specs: ReadonlyMap<string, string>;
  /** The package name it declares for the project itself. */
  readonly name: string | undefined;
}

/**
 * True when one side's record of a project follows from that side's
 * manifest: the record is absent, or the manifest exists, the record is
 * local, names only dependencies the manifest declares, and carries the
 * manifest's own package name.
 */
function recordFollows(
  record: ProjectRecord | undefined,
  manifest: ProjectManifest | undefined,
): boolean {
  if (record === undefined) return true;
  if (manifest === undefined || !record.local) return false;
  if (![...record.edges].every((edge) => manifest.specs.has(edge))) return false;
  return manifest.name === undefined || record.name === undefined || record.name === manifest.name;
}

/**
 * Changed project records: one stays explained only when the pull request
 * changes that project's manifest and each side's record follows from that
 * side's manifest. A record of a directory no manifest is read for — not
 * the root, and not a declared member — is never explained.
 */
function changedProjects(
  oldIndex: LockIndex,
  newIndex: LockIndex,
  oldManifests: ReadonlyMap<string, ProjectManifest>,
  newManifests: ReadonlyMap<string, ProjectManifest>,
): ChangedEntry[] {
  const dirs = [...new Set([...oldIndex.projects.keys(), ...newIndex.projects.keys()])].sort();
  const changed: ChangedEntry[] = [];
  for (const dir of dirs) {
    const before = oldIndex.projects.get(dir);
    const after = newIndex.projects.get(dir);
    if (before !== undefined && after !== undefined && before.fingerprint === after.fingerprint) {
      continue;
    }
    const oldManifest = oldManifests.get(dir);
    const newManifest = newManifests.get(dir);
    const explained =
      oldManifest?.text !== newManifest?.text &&
      recordFollows(before, oldManifest) &&
      recordFollows(after, newManifest);
    if (explained) continue;
    const name = (after ?? before)!.display;
    const note = before === undefined ? 'added' : after === undefined ? 'removed' : 'content changed';
    changed.push({ name, display: `${name} (${note})` });
  }
  return changed;
}

/** Runs one lock or manifest reader, treating a throw as unreadable content. */
function readSafely<T>(read: () => T): T | undefined {
  try {
    return read();
  } catch {
    return undefined;
  }
}

/**
 * One side's project manifests by directory: the root manifests at '.',
 * when the side has any, and each declared member's manifest — or the
 * first of them that did not parse.
 */
function projectManifests(
  format: LockfileFormat,
  side: LockfileSide,
): { manifests: Map<string, ProjectManifest> } | { unreadable: string } {
  const groups: [string, readonly string[], string][] = [];
  if (side.manifests.length > 0) groups.push(['.', side.manifests, format.manifestName]);
  for (const member of side.members) {
    groups.push([member.dir, [member.manifest], `${member.dir}/${format.manifestName}`]);
  }
  const manifests = new Map<string, ProjectManifest>();
  for (const [dir, texts, label] of groups) {
    const specs = readSafely(() => format.readManifests(texts));
    if (specs === undefined) return { unreadable: label };
    const name = texts.length === 1 ? readSafely(() => format.projectName?.(texts[0]!)) : undefined;
    manifests.set(dir, { text: texts.join('\0'), specs, name });
  }
  return { manifests };
}

/**
 * The parse-only check itself: every changed lock entry must belong to the
 * dependency closure of the changed manifest entries — each manifest, the
 * root's and every workspace member's, compared with its own other side,
 * and the closure walked through the lock file's own edges, on the side
 * where the entry lives — and every changed record of a workspace project
 * must follow from that project's changed manifest. A change the
 * manifests do not explain keeps the check's outcome at `unexplained`
 * with the entries named; a lock file or manifest outside the format
 * keeps it at `no check`.
 */
export function confirmLockfileChange(
  format: LockfileFormat,
  lockName: string,
  oldSide: LockfileSide,
  newSide: LockfileSide,
): LockfileCheck {
  const oldLock = oldSide.lock;
  const oldIndex =
    oldLock === null
      ? emptyIndex()
      : readSafely(() => format.readLock(oldLock, oldSide.manifests, oldSide.members));
  if (oldIndex === undefined) {
    return { outcome: 'no check', blindSpot: `no check for this lockfile: the base ${lockName} did not parse` };
  }
  const newLock = newSide.lock;
  const newIndex =
    newLock === null
      ? emptyIndex()
      : readSafely(() => format.readLock(newLock, newSide.manifests, newSide.members));
  if (newIndex === undefined) {
    return { outcome: 'no check', blindSpot: `no check for this lockfile: the head ${lockName} did not parse` };
  }
  if (oldSide.manifests.length === 0 && newSide.manifests.length === 0) {
    return {
      outcome: 'no check',
      blindSpot: `no check for this lockfile: no ${format.manifestName} beside it names its dependencies`,
    };
  }
  const oldProjects = projectManifests(format, oldSide);
  if ('unreadable' in oldProjects) {
    return { outcome: 'no check', blindSpot: `no check for this lockfile: its ${oldProjects.unreadable} did not parse` };
  }
  const newProjects = projectManifests(format, newSide);
  if ('unreadable' in newProjects) {
    return { outcome: 'no check', blindSpot: `no check for this lockfile: its ${newProjects.unreadable} did not parse` };
  }
  const noSpecs = new Map<string, string>();
  const changedDirects = new Set<string>();
  for (const dir of new Set([...oldProjects.manifests.keys(), ...newProjects.manifests.keys()])) {
    const oldSpecs = oldProjects.manifests.get(dir)?.specs ?? noSpecs;
    const newSpecs = newProjects.manifests.get(dir)?.specs ?? noSpecs;
    for (const name of new Set([...oldSpecs.keys(), ...newSpecs.keys()])) {
      if (oldSpecs.get(name) !== newSpecs.get(name)) changedDirects.add(name);
    }
  }
  const explained = new Set<string>([
    ...closureFrom([...changedDirects], newIndex.edges),
    ...closureFrom([...changedDirects], oldIndex.edges),
  ]);
  const unexplained = changedEntries(oldIndex, newIndex).filter(
    (entry) => !explained.has(entry.name),
  );
  if (changedDirects.size === 0) {
    unexplained.push(...changedRoots(oldIndex, newIndex));
  }
  unexplained.push(
    ...changedProjects(oldIndex, newIndex, oldProjects.manifests, newProjects.manifests),
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

/** Reads one file inside a copy by its path there; null when it is not there or would leave the copy. */
type ReadText = (relativePath: string) => Promise<string | null>;

function readTextIn(copyRoot: string): ReadText {
  return async (relativePath) => {
    const absolute = pathInCopy(copyRoot, relativePath);
    return absolute === undefined ? null : await readTextOrNull(absolute);
  };
}

/** Lists one directory inside a copy, dot files aside; a missing directory reads empty. */
function listDirIn(copyRoot: string): ListDir {
  return async (relativeDir) => {
    // The copy root itself is the repository root's directory, which
    // pathInCopy's containment guard would reject (it admits only strict
    // children), so resolve it directly; deeper directories stay guarded.
    const absolute =
      relativeDir === '.' || relativeDir === ''
        ? resolve(copyRoot)
        : pathInCopy(copyRoot, relativeDir);
    if (absolute === undefined) return [];
    try {
      return (await readdir(absolute)).filter((name) => !name.startsWith('.'));
    } catch {
      return [];
    }
  };
}

/** One workspace member found inside a copy, with its manifest's path there. */
interface FoundMember extends WorkspaceMember {
  readonly path: string;
}

/**
 * The workspace members the root manifest beside a lock file declares,
 * inside one copy: its globs expanded by listing directories, the
 * excluded ones and the root itself dropped, and each kept only where
 * the member's manifest exists. Files are read and listed; nothing runs.
 */
async function workspaceMembers(
  format: LockfileFormat,
  lockDir: string,
  rootManifests: readonly string[],
  list: ListDir,
  read: ReadText,
): Promise<FoundMember[]> {
  const rootManifest = rootManifests[0];
  if (format.workspaceGlobs === undefined || rootManifest === undefined) return [];
  const globs = readSafely(() => format.workspaceGlobs!(rootManifest));
  if (globs === undefined) return [];
  const excluded = globs.exclude.map(globSegments).filter((segments) => segments !== undefined);
  const dirs = new Set<string>();
  for (const glob of globs.include) {
    const segments = globSegments(glob);
    if (segments === undefined) continue;
    for (const dir of await expandGlob(lockDir, segments, list)) {
      if (dirs.size >= MAX_MEMBERS) break;
      if (!excluded.some((exclude) => matchesOrUnder(exclude, dir))) dirs.add(dir);
    }
  }
  const members: FoundMember[] = [];
  for (const dir of [...dirs].sort()) {
    const path = under(lockDir, `${dir}/${format.manifestName}`);
    const manifest = await read(path);
    if (manifest !== null) members.push({ dir, path, manifest });
  }
  return members;
}

/** Reads one side of a lock file's story inside one copy of the repository. */
async function readSide(
  copyRoot: string,
  lockPath: string,
  format: LockfileFormat,
): Promise<LockfileSide> {
  const read = readTextIn(copyRoot);
  const list = listDirIn(copyRoot);
  const lock = await read(lockPath);
  const lockDir = dirname(lockPath);
  const manifests: string[] = [];
  for (const relative of await format.manifestsIn(lockDir, list)) {
    const text = await read(relative);
    if (text !== null) manifests.push(text);
  }
  const members = await workspaceMembers(format, lockDir, manifests, list, read);
  return { lock, manifests, members: members.map(({ dir, manifest }) => ({ dir, manifest })) };
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
 * The manifest paths the lock file checks read beside the lock files
 * among `changedPaths` — the root manifests and the manifests of the
 * workspace members they declare — as paths in one copy of the
 * repository, so a caller that copies what a review reads — seeding or
 * recording a case — carries them even when the change leaves the
 * manifest itself untouched.
 */
export async function lockfileManifests(
  changedPaths: readonly string[],
  copyRoot: string,
): Promise<readonly string[]> {
  const list = listDirIn(copyRoot);
  const read = readTextIn(copyRoot);
  const manifests = new Set<string>();
  for (const path of changedPaths) {
    const format = lockfileFormatFor(path);
    if (format === undefined) continue;
    const lockDir = dirname(path);
    const roots: string[] = [];
    for (const manifest of await format.manifestsIn(lockDir, list)) {
      manifests.add(manifest);
      const text = await read(manifest);
      if (text !== null) roots.push(text);
    }
    for (const member of await workspaceMembers(format, lockDir, roots, list, read)) {
      manifests.add(member.path);
    }
  }
  return [...manifests].sort();
}

/**
 * Runs the parse-only check on every part a check exists for, reading both
 * versions of the lock file, its manifests and its workspace members'
 * manifests from the read-only copies — never by running a package
 * manager (the no-process tests prove it). Returns the assessments by
 * part path; the noise rules attach each one only where the name rule's
 * claim stands, so a renamed or linguist-declared lock file keeps its own
 * label.
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
        overrides.set(part.path, assessmentFor(format, basename(part.path), oldSide, newSide));
      }),
  );
  return overrides;
}
