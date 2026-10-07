import { readFile } from 'node:fs/promises';
import { pathInCopy } from './archive.js';
import { docsUrlProblem, downloadBody, publicDocsFetch, readAll } from './doc-fetch.js';
import {
  frameworkMoniker,
  packageMonikers,
  parseSphinxInventory,
  scanXrefMap,
  sphinxVersionMatches,
  xrefLink,
  type SphinxInventory,
} from './doc-inventory.js';
import { suggestDocLinks, type DocSuggestionOptions } from './doc-suggestions.js';
import { extensionOf, languageForPath } from './languages.js';
import { normalizePackageName, pythonPins, type LibraryPin } from './library-fetch.js';
import { nugetPins, type NuGetPin } from './nuget-fetch.js';
import { filesOfPart } from './parts.js';
import { pinFilesIn } from './pin-files.js';
import type { DocLink, DocLinks, DocUse, LibraryApi, Part } from './protocol.js';

/**
 * Version-matched documentation links: each library API a change uses,
 * in Python and C#, linked to its documentation at the version the
 * project pins — first from the library's published inventory, a Sphinx
 * inventory for a Python library and the .NET API reference's
 * cross-reference map for .NET, read only when it documents that very
 * version; then, for the APIs no inventory linked, the links the agent
 * suggests, labelled as such and never fetched. Every other language
 * still flows through the review and gets a note saying no link is
 * looked for (ADR 0001).
 */

/** The .NET API reference's cross-reference map, published beside its pages. */
export const DOTNET_XREF_MAP = 'https://learn.microsoft.com/en-us/dotnet/.xrefmap.json';

/** The only host .NET API reference pages are linked on. */
const DOTNET_DOCS_ORIGIN = 'https://learn.microsoft.com';

/** What one PyPI answer, one Sphinx inventory and the cross-reference map may take, downloaded and inflated. */
const PYPI_LIMITS = { downloaded: 16 * 1024 * 1024, inflated: 64 * 1024 * 1024 };
const SPHINX_LIMITS = { downloaded: 16 * 1024 * 1024, inflated: 64 * 1024 * 1024 };
const XREF_LIMITS = { downloaded: 64 * 1024 * 1024, inflated: 1024 * 1024 * 1024 };

/** At most this many APIs are linked, and this many libraries' inventories looked for, per change. */
const MAX_APIS = 60;
const MAX_LIBRARIES = 12;

export interface DocLinksOptions {
  /** The read-only head copy, where the pins and the changed files are read. */
  headRoot: string;
  /** Fetch implementation; tests inject recorded inventories so no test touches the network. */
  fetch?: typeof fetch;
  /** The agent that suggests links for the APIs no inventory linked; none is asked without it. */
  agent?: Omit<DocSuggestionOptions, 'root'>;
  /** Hears when the agent starts suggesting. */
  onSuggesting?: () => void;
}

/** One reference to a library name on an added line, before it is resolved to an API. */
interface Reference {
  /** The dotted name as the line writes it, such as `httpx.Client`. */
  chain: string;
  use: DocUse;
}

/** The head-side added lines of each changed file of the parts, by path, in line order. */
function addedLines(parts: readonly Part[]): Map<string, { line: number; text: string }[]> {
  const files = new Map<string, { line: number; text: string }[]>();
  for (const file of parts.flatMap(filesOfPart)) {
    if (file.isBinary || file.changeKind === 'deletion') continue;
    const lines = files.get(file.path) ?? [];
    for (const hunk of file.hunks) {
      for (const line of hunk.lines) if (line.kind === 'addition' && line.newLineNumber !== undefined) lines.push({ line: line.newLineNumber, text: line.text });
    }
    files.set(file.path, lines.sort((a, b) => a.line - b.line));
  }
  return files;
}

async function headText(headRoot: string, path: string): Promise<string> {
  const absolute = pathInCopy(headRoot, path);
  return absolute === undefined ? '' : readFile(absolute, 'utf8').catch(() => '');
}

/** Every dotted name a line writes that no `.` precedes, with the last name of each as a reader hovers it. */
function chains(text: string, path: string, line: number, first: RegExp): Reference[] {
  return [...text.matchAll(/(?<![\w.])([A-Za-z_]\w*(?:\s*\.\s*[A-Za-z_]\w*)*)/g)].flatMap((match) => {
    const chain = match[1]!.replace(/\s+/g, '');
    if (!first.test(chain)) return [];
    return [{ chain, use: { path, line, name: chain.split('.').pop()! } }];
  });
}

/** A line with its string literals blanked and its comment, after `marker`, dropped. */
function codeOf(text: string, marker: string): string {
  const blanked = text.replace(/(["'])(?:\\.|(?!\1).)*\1/g, (literal) => ' '.repeat(literal.length));
  const comment = blanked.indexOf(marker);
  return comment < 0 ? blanked : blanked.slice(0, comment);
}

/** The names a Python file imports, each local name with the full name it stands for. */
export function pythonImports(text: string): Map<string, string> {
  const names = new Map<string, string>();
  const joined = text.replace(/^(\s*from\s+[\w.]+\s+import\s*)\(([^)]*)\)/gm, (_all, head: string, list: string) => `${head}${list.replace(/\s+/g, ' ')}`);
  for (const [, module, list] of joined.matchAll(/^\s*from\s+([A-Za-z_][\w.]*)\s+import\s+([^#\n]+)/gm)) {
    for (const item of list!.split(',')) {
      const [name, alias] = item.trim().split(/\s+as\s+/);
      if (name !== undefined && /^[A-Za-z_]\w*$/.test(name)) names.set((alias ?? name).trim(), `${module}.${name}`);
    }
  }
  for (const [, list] of joined.matchAll(/^\s*import\s+([^#\n]+)/gm)) {
    for (const item of list!.split(',')) {
      const [module, alias] = item.trim().split(/\s+as\s+/);
      if (module === undefined || !/^[A-Za-z_][\w.]*$/.test(module)) continue;
      if (alias !== undefined) names.set(alias.trim(), module);
      else names.set(module.split('.')[0]!, module.split('.')[0]!);
    }
  }
  return names;
}

/** The pinned Python library a full name's top module belongs to: the pin named like the module. */
function pythonPinOf(name: string, pins: readonly LibraryPin[]): LibraryPin | undefined {
  const module = normalizePackageName(name.split('.')[0]!);
  return pins.find((pin) => normalizePackageName(pin.name) === module);
}

/** The pinned Python library APIs the added lines name through the file's imports, by full name. */
async function pythonApis(parts: readonly Part[], headRoot: string): Promise<{ apis: Map<string, { pin: LibraryPin; uses: DocUse[] }>; files: number }> {
  const apis = new Map<string, { pin: LibraryPin; uses: DocUse[] }>();
  const files = [...addedLines(parts)].filter(([path]) => extensionOf(path) === '.py');
  if (files.length === 0) return { apis, files: 0 };
  const pins = await pythonPins(headRoot);
  for (const [path, lines] of files) {
    const imports = pythonImports(await headText(headRoot, path));
    for (const { line, text } of lines) {
      if (/^\s*(?:from|import)\s/.test(text)) continue;
      for (const reference of chains(codeOf(text, '#'), path, line, /^[A-Za-z_]/)) {
        const [head, ...rest] = reference.chain.split('.');
        const imported = imports.get(head!);
        if (imported === undefined || rest.length === 0 && imported === head) continue;
        const api = [imported, ...rest].join('.');
        const pin = pythonPinOf(api, pins);
        if (pin === undefined) continue;
        const entry = apis.get(api) ?? { pin, uses: [] };
        if (!entry.uses.some((use) => use.line === line && use.path === path && use.name === reference.use.name)) entry.uses.push(reference.use);
        apis.set(api, entry);
      }
    }
  }
  return { apis, files: files.length };
}

/** The roots a Python library's documentation lives under, as PyPI names them for the pinned release. */
export function pythonDocsUrls(info: unknown): string[] {
  const { project_urls: projectUrls, docs_url: docsUrl, home_page: homePage } = (info ?? {}) as Record<string, unknown>;
  const named = typeof projectUrls === 'object' && projectUrls !== null ? Object.entries(projectUrls as Record<string, unknown>) : [];
  const key = (name: string): string => name.toLowerCase().replace(/[^a-z]/g, '');
  const urls = [
    ...named.filter(([name]) => ['documentation', 'docs'].includes(key(name))).map(([, url]) => url),
    docsUrl,
    ...[homePage, ...named.filter(([name]) => key(name) === 'homepage').map(([, url]) => url)].filter(
      (url) => typeof url === 'string' && /^https:\/\/[^/]+\.readthedocs\.io(?:\/|$)/.test(url),
    ),
  ];
  return [...new Set(urls.filter((url): url is string => typeof url === 'string' && docsUrlProblem(url) === undefined))];
}

/**
 * Where a Sphinx inventory of a version may sit under a documentation
 * root, in the order they are tried: the version's own folder as Read the
 * Docs names it (`en/1.2.3/`, `en/v1.2.3/`, `en/1.2.x/`), then the stable
 * and latest folders and the root itself, which count only when the
 * inventory there documents the same version.
 */
export function sphinxInventoryUrls(docsUrl: string, version: string): string[] {
  const url = new URL(docsUrl);
  const path = url.pathname.includes('/en/') ? url.pathname.slice(0, url.pathname.indexOf('/en/') + 1) : url.pathname.replace(/[^/]*$/, '');
  const root = `${url.origin}${path}`;
  const [major, minor] = version.split('.');
  const folders = [version, `v${version}`, ...(minor === undefined ? [] : [`${major}.${minor}.x`]), 'stable', 'latest'].map((folder) => `en/${encodeURIComponent(folder)}/`);
  return [...new Set([...folders, ''].map((folder) => `${root}${folder}objects.inv`))];
}

/** The Sphinx inventory that documents a pin's version, with where it was read, or why none was found. */
async function pythonInventory(pin: LibraryPin, fetchFn: typeof fetch): Promise<{ inventory: SphinxInventory; url: string } | { why: string }> {
  const what = `${pin.name} ${pin.version}`;
  try {
    const answer = await downloadBody(
      await fetchFn(`https://pypi.org/pypi/${encodeURIComponent(normalizePackageName(pin.name))}/${encodeURIComponent(pin.version)}/json`, { redirect: 'manual' }),
      `PyPI's record of ${what}`,
      PYPI_LIMITS,
    );
    if (answer === undefined) return { why: `PyPI has no release ${what}` };
    const roots = pythonDocsUrls((JSON.parse((await readAll(answer)).toString('utf8')) as { info?: unknown }).info);
    if (roots.length === 0) return { why: `PyPI names no https documentation site for ${what}` };
    const seen: string[] = [];
    for (const url of roots.flatMap((root) => sphinxInventoryUrls(root, pin.version))) {
      try {
        const body = await downloadBody(await fetchFn(url, { redirect: 'manual' }), url, SPHINX_LIMITS);
        if (body === undefined) continue;
        const inventory = parseSphinxInventory(await readAll(body));
        if (sphinxVersionMatches(inventory.version, pin.version)) return { inventory, url };
        seen.push(`${url} documents ${inventory.version}`);
      } catch {
        // An unreadable place is one more place without the inventory.
      }
    }
    const tried = seen.length > 0 ? `; ${seen.join('; ')}` : '';
    return { why: `no Sphinx inventory under ${roots.join(' or ')} documents ${pin.version}${tried}` };
  } catch (error) {
    return { why: `its documentation could not be looked for: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/** A link to an inventory object's page, only on the inventory's own https site. */
function sphinxLink(inventoryUrl: string, uri: string): string | undefined {
  try {
    const link = new URL(uri, inventoryUrl);
    return link.origin === new URL(inventoryUrl).origin && link.protocol === 'https:' ? link.href : undefined;
  } catch {
    return undefined;
  }
}

/** One C# file's usings, its own declared type names, and the dotted names and members its added lines write. */
interface CSharpFile {
  path: string;
  usings: string[];
  declared: Set<string>;
  /** Capitalised dotted names, such as `Stream` or `Path.Combine`, with whether each is written as a type rather than a call. */
  references: (Reference & { typeLike: boolean })[];
  /** Members written on a value, such as `CopyTo` in `input.CopyTo(stream)`. */
  members: Reference[];
  /** Every capitalised name the head file writes, the types an added line's members may belong to. */
  named: Set<string>;
}

async function cSharpFile(path: string, lines: { line: number; text: string }[], headRoot: string): Promise<CSharpFile> {
  const text = await headText(headRoot, path);
  const code = text.split('\n').map((line) => codeOf(line, '//')).join('\n');
  const usings = [...code.matchAll(/^\s*(?:global\s+)?using\s+(?!static\b)([A-Za-z_][\w.]*)\s*;/gm)].map((match) => match[1]!);
  const declared = new Set([...code.matchAll(/\b(?:class|struct|interface|enum|record|delegate|namespace)\s+([A-Za-z_][\w.]*)/g)].flatMap((match) => match[1]!.split('.')));
  const references: CSharpFile['references'] = [];
  const members: Reference[] = [];
  for (const { line, text: added } of lines) {
    if (/^\s*(?:(?:global\s+)?using\s+(?:static\s+)?[\w.]+\s*(?:=\s*[^;]+)?;|namespace\s)/.test(added)) continue;
    const stripped = codeOf(added, '//');
    for (const reference of chains(stripped, path, line, /^[A-Z]/)) {
      const at = stripped.indexOf(reference.chain);
      const after = stripped.slice(at + reference.chain.length).trimStart();
      references.push({ ...reference, typeLike: !after.startsWith('(') || /\bnew\s+$/.test(stripped.slice(0, at)) });
    }
    for (const match of stripped.matchAll(/(?:[a-z_]\w*|\)|\])\s*\.\s*([A-Z]\w*)/g)) members.push({ chain: match[1]!, use: { path, line, name: match[1]! } });
  }
  const named = new Set([...code.matchAll(/(?<![\w.])([A-Z]\w*)/g)].map((match) => match[1]!).filter((name) => !declared.has(name)));
  return { path, usings, declared, references, members, named };
}

/** A project's target framework, by the project file nearest the changed file, as its first `TargetFramework(s)` names it. */
async function targetFramework(headRoot: string, path: string, projects: readonly string[]): Promise<{ framework: string; project: string } | undefined> {
  const folder = (file: string): string => file.replace(/[^/]*$/, '');
  const nearest = projects
    .filter((project) => path.startsWith(folder(project)))
    .sort((a, b) => folder(b).length - folder(a).length);
  for (const project of nearest) {
    const text = await headText(headRoot, project);
    const declared = /<TargetFrameworks?>\s*([^<;\s]+)/i.exec(text.replace(/<!--[\s\S]*?-->/g, ''))?.[1];
    if (declared !== undefined) return { framework: declared, project };
  }
  return undefined;
}

/** True when a package holds a namespace's APIs: named as the namespace, or as an enclosing one. */
function packageHolds(pin: NuGetPin, namespace: string): boolean {
  const name = pin.name.toLowerCase();
  const space = namespace.toLowerCase();
  return space === name || space.startsWith(`${name}.`);
}

/** True when a package is named inside a namespace, as `Microsoft.IO.RecyclableMemoryStream` is inside `Microsoft.IO`. */
function packageWithin(pin: NuGetPin, namespace: string): boolean {
  return namespace.includes('.') && pin.name.toLowerCase().startsWith(`${namespace.toLowerCase()}.`);
}

/** The .NET APIs the added lines of the C# files name, linked through the cross-reference map, and the package APIs it does not hold. */
async function dotnetLinks(parts: readonly Part[], headRoot: string, fetchFn: typeof fetch): Promise<{ links: DocLink[]; unlinked: LibraryApi[]; notes: string[] }> {
  const empty = { links: [], unlinked: [], notes: [] };
  const sources = [...addedLines(parts)].filter(([path]) => extensionOf(path) === '.cs');
  if (sources.length === 0) return empty;
  const projects = await pinFilesIn(headRoot, (name) => /\.csproj$/i.test(name));
  const pins = await nugetPins(headRoot);
  const files: (CSharpFile & { framework?: { framework: string; project: string; moniker?: string } })[] = [];
  for (const [path, lines] of sources) {
    const framework = await targetFramework(headRoot, path, projects);
    const moniker = framework === undefined ? undefined : frameworkMoniker(framework.framework);
    files.push({ ...(await cSharpFile(path, lines, headRoot)), ...(framework ? { framework: { ...framework, ...(moniker ? { moniker } : {}) } } : {}) });
  }
  if (files.every((file) => file.framework === undefined) && pins.length === 0) {
    return { ...empty, notes: ['.NET: no project file names a target framework and nothing pins a package, so no .NET API is linked'] };
  }
  // Every uid an added name may be, under each using of its file.
  const candidates = (file: CSharpFile, chain: string): string[] => [chain, ...file.usings.map((using) => `${using}.${chain}`)].flatMap((uid) => [uid, `${uid}*`]);
  const memberCandidates = (file: CSharpFile, member: string): string[] =>
    [...file.named].flatMap((type) => [type, ...file.usings.map((using) => `${using}.${type}`)].map((owner) => `${owner}.${member}*`));
  const wanted = new Set(files.flatMap((file) => [...file.references.flatMap((each) => candidates(file, each.chain)), ...file.members.flatMap((each) => memberCandidates(file, each.chain))]));
  let map: Map<string, { uid: string; href: string; monikers: string[] }>;
  try {
    const body = await downloadBody(await fetchFn(DOTNET_XREF_MAP, { redirect: 'manual' }), "the .NET API reference's cross-reference map", XREF_LIMITS);
    if (body === undefined) throw new Error(`${DOTNET_XREF_MAP} is not there`);
    map = await scanXrefMap(body, wanted);
  } catch (error) {
    return { ...empty, notes: [`.NET: the API reference's cross-reference map could not be read, so no .NET API is linked: ${error instanceof Error ? error.message : String(error)}`] };
  }
  const links = new Map<string, DocLink>();
  const unlinked = new Map<string, LibraryApi>();
  const versionless = new Set<string>();
  const add = (into: Map<string, LibraryApi | DocLink>, api: LibraryApi | DocLink, use: DocUse): void => {
    const known = into.get(api.api);
    if (known === undefined) into.set(api.api, { ...api, uses: [use] });
    else if (!known.uses.some((each) => each.path === use.path && each.line === use.line && each.name === use.name)) known.uses.push(use);
  };
  const link = (file: (typeof files)[number], uid: string, use: DocUse): boolean => {
    const entry = map.get(uid);
    if (entry === undefined || !entry.href.startsWith(`${DOTNET_DOCS_ORIGIN}/`)) return false;
    const api = uid.replace(/\*$/, '');
    const pin = pins.find((each) => packageHolds(each, api.split('.').slice(0, -1).join('.')));
    const choices = [
      ...(pin === undefined ? [] : packageMonikers(pin.version).map((moniker) => ({ moniker, library: pin.name, version: pin.version, pinnedBy: pin.pinnedBy, ecosystem: 'NuGet' as const }))),
      ...(file.framework?.moniker === undefined ? [] : [{ moniker: file.framework.moniker, library: '.NET', version: file.framework.framework, pinnedBy: file.framework.project, ecosystem: '.NET' as const }]),
    ];
    const choice = choices.find((each) => entry.monikers.includes(each.moniker));
    if (choice === undefined) {
      versionless.add(api);
      return true;
    }
    const { moniker, ...pinned } = choice;
    add(links as Map<string, DocLink>, { api, ...pinned, uses: [], url: xrefLink(entry, [moniker])!, from: 'inventory', inventory: DOTNET_XREF_MAP }, use);
    return true;
  };
  for (const file of files) {
    for (const reference of file.references) {
      if (file.declared.has(reference.chain.split('.')[0]!)) continue;
      if (candidates(file, reference.chain).some((uid) => link(file, uid, reference.use))) continue;
      // A type the map does not hold, under the one using a pinned package is named within: that package's API, linked by no inventory.
      if (!reference.typeLike || reference.chain.includes('.')) continue;
      const holders = file.usings.flatMap((using) => pins.filter((pin) => packageHolds(pin, using) || packageWithin(pin, using)).map((pin) => ({ using, pin })));
      if (holders.length !== 1) continue;
      const { using, pin } = holders[0]!;
      add(unlinked, { api: `${using}.${reference.chain}`, library: pin.name, version: pin.version, pinnedBy: pin.pinnedBy, ecosystem: 'NuGet', uses: [] }, reference.use);
    }
    for (const member of file.members) {
      const found = [...new Set(memberCandidates(file, member.chain).filter((uid) => map.has(uid)))];
      if (found.length === 1) link(file, found[0]!, member.use);
    }
  }
  const notes = [`.NET: read the API reference's cross-reference map, ${DOTNET_XREF_MAP}`];
  if (versionless.size > 0) notes.push(`.NET: the API reference documents ${[...versionless].sort().join(', ')}, but not at the version pinned, so no link is given`);
  return { links: [...links.values()], unlinked: [...unlinked.values()], notes };
}

/** The changed code files of languages no documentation link is looked for in, by extension. */
function otherLanguages(parts: readonly Part[]): string[] {
  const extensions = parts.flatMap(filesOfPart).flatMap((file) => {
    const extension = extensionOf(file.path);
    return languageForPath(file.path) !== undefined && extension !== '.py' && extension !== '.cs' ? [extension] : [];
  });
  return [...new Set(extensions)].sort();
}

/**
 * Finds the documentation links of the library APIs a change's added
 * lines use: Python names imported from a library a lock file pins, and
 * C# names under a using, .NET's own at the project's target framework
 * and a pinned package's at its version. Each is linked from the
 * library's published inventory, read only where it documents the pinned
 * version; the agent, when given, then suggests links for the rest,
 * which come after every inventory link, labelled as its suggestions.
 * Nothing here throws for a library: what could not be read is a note.
 */
export async function findDocLinks(parts: readonly Part[], options: DocLinksOptions): Promise<DocLinks> {
  const fetchFn = options.fetch ?? publicDocsFetch();
  const notes: string[] = [];
  const links: DocLink[] = [];
  const unlinked: LibraryApi[] = [];

  const python = await pythonApis(parts, options.headRoot);
  const libraries = new Map<LibraryPin, [string, DocUse[]][]>();
  for (const [api, { pin, uses }] of python.apis) libraries.set(pin, [...(libraries.get(pin) ?? []), [api, uses]]);
  for (const [index, [pin, apis]] of [...libraries].entries()) {
    const pinned = { library: pin.name, version: pin.version, pinnedBy: pin.pinnedBy, ecosystem: 'PyPI' as const };
    const found = index < MAX_LIBRARIES ? await pythonInventory(pin, fetchFn) : { why: `more than ${MAX_LIBRARIES} libraries are used, so its documentation was not looked for` };
    if ('why' in found) {
      notes.push(`${pin.name} ${pin.version}: ${found.why}`);
      unlinked.push(...apis.map(([api, uses]) => ({ api, ...pinned, uses })));
      continue;
    }
    notes.push(`${pin.name} ${pin.version}: read the Sphinx inventory at ${found.url}, which documents ${found.inventory.version}`);
    for (const [api, uses] of apis) {
      const object = found.inventory.objects.get(api);
      const url = object === undefined ? undefined : sphinxLink(found.url, object.uri);
      if (url !== undefined) links.push({ api, ...pinned, uses, url, from: 'inventory', inventory: found.url });
      else unlinked.push({ api, ...pinned, uses });
    }
  }

  const dotnet = await dotnetLinks(parts, options.headRoot, fetchFn);
  links.push(...dotnet.links);
  unlinked.push(...dotnet.unlinked);
  notes.push(...dotnet.notes);
  const others = otherLanguages(parts);
  if (others.length > 0) notes.push(`Library APIs are linked to their documentation in Python and C# only; the change's ${others.join(', ')} files are not read for them`);

  const shown = links.slice(0, MAX_APIS);
  const rest = unlinked.slice(0, Math.max(0, MAX_APIS - shown.length));
  if (options.agent === undefined || rest.length === 0) return { links: shown, unlinked: rest, notes };
  options.onSuggesting?.();
  const suggested = await suggestDocLinks(rest, { ...options.agent, root: options.headRoot });
  const linked = new Set(suggested.links.map((link) => link.api));
  return {
    links: [...shown, ...suggested.links],
    unlinked: rest.filter((api) => !linked.has(api.api)),
    notes,
    suggestions: suggested.suggestions,
  };
}
