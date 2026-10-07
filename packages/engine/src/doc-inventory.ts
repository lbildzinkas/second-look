import { StringDecoder } from 'node:string_decoder';
import { inflateSync } from 'node:zlib';

/**
 * The published documentation inventories the companion reads to link a
 * library API to its documentation at the pinned version: a Sphinx
 * inventory (`objects.inv`) for a Python library, and the .NET API
 * reference's cross-reference map (`.xrefmap.json`) for .NET's own APIs
 * and the packages documented beside them. Both are untrusted data from
 * the web: they are parsed, never run, and every size is capped.
 */

/** One object a Sphinx inventory documents: its role and the page it lives on, relative to the inventory. */
export interface SphinxObject {
  /** The domain and role, such as `py:class`. */
  role: string;
  /** The page and anchor, relative to the folder the inventory sits in. */
  uri: string;
}

/** A parsed Sphinx inventory: the project and version its header names, and its Python objects by name. */
export interface SphinxInventory {
  project: string;
  version: string;
  objects: Map<string, SphinxObject>;
}

/** The most a Sphinx inventory may inflate to; far above any real one. */
export const MAX_SPHINX_INVENTORY_BYTES = 64 * 1024 * 1024;

const SPHINX_HEADER = '# Sphinx inventory version 2';

/** One line of the inflated body: `name domain:role priority uri dispname`, the name possibly holding spaces. */
const SPHINX_LINE = /^(.+?)\s+(\S+?:\S+)\s+(-?\d+)\s+(\S*)\s+(.*)$/;

/**
 * Parses a Sphinx inventory, version 2: four header lines naming the
 * project and its version, then the zlib-compressed object lines. Only
 * the Python domain's objects are kept. Throws on any other format, or a
 * body that inflates past {@link MAX_SPHINX_INVENTORY_BYTES}.
 */
export function parseSphinxInventory(bytes: Uint8Array, maxBytes = MAX_SPHINX_INVENTORY_BYTES): SphinxInventory {
  const buffer = Buffer.from(bytes);
  const header: string[] = [];
  let at = 0;
  for (let line = 0; line < 4; line++) {
    const end = buffer.indexOf(0x0a, at);
    if (end < 0) throw new Error('not a Sphinx inventory: its header ends early');
    header.push(buffer.subarray(at, end).toString('utf8').trim());
    at = end + 1;
  }
  if (header[0] !== SPHINX_HEADER) throw new Error(`not a Sphinx inventory version 2: its first line is ${JSON.stringify(header[0]!.slice(0, 80))}`);
  if (!/zlib/.test(header[3]!)) throw new Error('the Sphinx inventory is not compressed with zlib');
  let body: string;
  try {
    body = inflateSync(buffer.subarray(at), { maxOutputLength: maxBytes }).toString('utf8');
  } catch (error) {
    throw new Error(`the Sphinx inventory's body cannot be read: ${error instanceof Error ? error.message : String(error)}`);
  }
  const objects = new Map<string, SphinxObject>();
  for (const line of body.split('\n')) {
    const match = SPHINX_LINE.exec(line.trim());
    if (match === null) continue;
    const [, name, role, , location] = match as unknown as [string, string, string, string, string];
    if (!role.startsWith('py:') || objects.has(name)) continue;
    objects.set(name, { role, uri: location.endsWith('$') ? `${location.slice(0, -1)}${name}` : location });
  }
  return {
    project: header[1]!.replace(/^# Project:\s*/, ''),
    version: header[2]!.replace(/^# Version:\s*/, ''),
    objects,
  };
}

/** A version's leading release numbers, and anything after them; undefined when it starts with none. */
function release(version: string): { numbers: string[]; rest: string } | undefined {
  const match = /^v?(\d+(?:\.(?:\d+|x|\*))*)(.*)$/i.exec(version.trim());
  return match === null ? undefined : { numbers: match[1]!.split('.'), rest: match[2]! };
}

/**
 * True when the version a Sphinx inventory names documents the version a
 * project pins: the inventory's release numbers, at least major and minor,
 * agree with the pin's, an `x` matching any number and a missing number
 * counting as 0 — `23.1` documents `23.1.0`, `8.1.x` documents `8.1.7`,
 * `8.5.x` does not document `8.1.7` — and an inventory of a pre-release
 * or development version documents only that exact version.
 */
export function sphinxVersionMatches(inventoryVersion: string, pinnedVersion: string): boolean {
  const documented = release(inventoryVersion);
  const pinned = release(pinnedVersion);
  if (documented === undefined || pinned === undefined) return false;
  if (documented.rest.trim() !== '') return inventoryVersion.trim().replace(/^v/i, '') === pinnedVersion.trim().replace(/^v/i, '');
  if (documented.numbers.length < Math.min(2, pinned.numbers.length)) return false;
  const length = Math.max(documented.numbers.length, pinned.numbers.length);
  for (let index = 0; index < length; index++) {
    const ours = documented.numbers[index];
    if (ours === undefined) return true;
    if (ours === 'x' || ours === '*') continue;
    if (Number(ours) !== Number(pinned.numbers[index] ?? '0')) return false;
  }
  return true;
}

/** One API the .NET cross-reference map documents: its page, and the documentation versions (monikers) it is in. */
export interface XrefEntry {
  uid: string;
  href: string;
  monikers: string[];
}

/** The most one entry of the map may take; far above any real one. */
const MAX_XREF_ENTRY_CHARS = 1024 * 1024;

/** The entry's fields, when it is one with a uid, an https link and its monikers. */
function xrefEntry(text: string): XrefEntry | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  const { uid, href, monikers } = (value ?? {}) as Record<string, unknown>;
  if (typeof uid !== 'string' || typeof href !== 'string' || !href.startsWith('https://')) return undefined;
  const versions = Array.isArray(monikers) ? monikers.filter((each): each is string => typeof each === 'string') : [];
  return { uid, href, monikers: versions };
}

/** The uid an entry's text names first, read without parsing the whole entry. */
function firstUid(text: string): string | undefined {
  const match = /"uid"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(text);
  if (match === null) return undefined;
  try {
    return JSON.parse(`"${match[1]!}"`) as string;
  } catch {
    return undefined;
  }
}

/**
 * Reads the .NET API reference's cross-reference map as it streams in —
 * `{"references":[{"uid":…,"href":…,"monikers":[…]},…],…}`, hundreds of
 * megabytes once inflated — and keeps only the entries whose uid is
 * wanted, so the map is never held whole. Every object two levels down is
 * an entry; strings are skipped whatever they hold. Throws on an entry
 * larger than any real one.
 */
export async function scanXrefMap(text: AsyncIterable<Uint8Array>, wanted: ReadonlySet<string>): Promise<Map<string, XrefEntry>> {
  const found = new Map<string, XrefEntry>();
  const decoder = new StringDecoder('utf8');
  let depth = 0;
  let inString = false;
  let escaped = false;
  let entry: string[] | undefined;
  let entryLength = 0;
  const finish = (piece: string): void => {
    const whole = [...entry!, piece].join('');
    entry = undefined;
    const uid = firstUid(whole);
    if (uid === undefined || !wanted.has(uid) || found.has(uid)) return;
    const parsed = xrefEntry(whole);
    if (parsed !== undefined) found.set(uid, parsed);
  };
  for await (const chunk of text) {
    const piece = decoder.write(Buffer.from(chunk));
    let start = entry === undefined ? -1 : 0;
    for (let index = 0; index < piece.length; index++) {
      const code = piece.charCodeAt(index);
      if (inString) {
        if (escaped) escaped = false;
        else if (code === 0x5c) escaped = true;
        else if (code === 0x22) inString = false;
        continue;
      }
      if (code === 0x22) inString = true;
      else if (code === 0x7b || code === 0x5b) {
        depth++;
        if (code === 0x7b && depth === 3 && entry === undefined) {
          entry = [];
          entryLength = 0;
          start = index;
        }
      } else if (code === 0x7d || code === 0x5d) {
        depth--;
        if (code === 0x7d && depth === 2 && entry !== undefined) {
          finish(piece.slice(start, index + 1));
          start = -1;
        }
      }
    }
    if (entry !== undefined) {
      const rest = piece.slice(Math.max(start, 0));
      entryLength += rest.length;
      if (entryLength > MAX_XREF_ENTRY_CHARS) throw new Error('the cross-reference map holds an entry larger than any real one');
      entry.push(rest);
    }
  }
  return found;
}

/**
 * The documentation version (moniker) of a .NET target framework, as the
 * API reference names it: `net8.0` → `net-8.0`, `netcoreapp3.1` →
 * `netcore-3.1`, `netstandard2.0` → `netstandard-2.0`, `net48` →
 * `netframework-4.8`, `net472` → `netframework-4.7.2`; undefined for one
 * it does not know. A platform suffix such as `-windows` is dropped.
 */
export function frameworkMoniker(targetFramework: string): string | undefined {
  const tfm = targetFramework.trim().toLowerCase().replace(/-.*$/, '');
  const modern = /^net(\d+)\.(\d+)$/.exec(tfm);
  if (modern) return Number(modern[1]) >= 5 ? `net-${Number(modern[1])}.${Number(modern[2])}` : undefined;
  const core = /^netcoreapp(\d+\.\d+)$/.exec(tfm);
  if (core) return `netcore-${core[1]}`;
  const standard = /^netstandard(\d+\.\d+)$/.exec(tfm);
  if (standard) return `netstandard-${standard[1]}`;
  const framework = /^net(\d)(\d)(\d)?$/.exec(tfm);
  if (framework) return `netframework-${framework[1]}.${framework[2]}${framework[3] ? `.${framework[3]}` : ''}`;
  return undefined;
}

/**
 * The documentation versions a pinned package's APIs are looked for in, best first:
 * the API reference documents the packages that ship with .NET under its
 * version's package moniker (`net-8.0-pp` for 8.x), and in the framework's own
 * (`net-8.0`) when the same API also ships in the box. A package whose
 * major version is not a .NET version has none.
 */
export function packageMonikers(version: string): string[] {
  const major = /^(\d+)\./.exec(version.trim())?.[1];
  if (major === undefined || Number(major) < 5) return [];
  return [`net-${Number(major)}.0-pp`, `net-${Number(major)}.0`];
}

/**
 * The link to an entry's page at the first of the wanted documentation
 * versions it is in, as the API reference's `view` parameter selects it;
 * undefined when it is in none of them, so no link names another version.
 */
export function xrefLink(entry: XrefEntry, monikers: readonly string[]): string | undefined {
  const moniker = monikers.find((each) => entry.monikers.includes(each));
  if (moniker === undefined) return undefined;
  const url = new URL(entry.href);
  url.searchParams.set('view', moniker);
  return url.toString();
}
