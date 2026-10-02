import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { entitiesOf } from './parts.js';
import type { Entity, Novelty, Part, PartRole, PartSignals } from './protocol.js';

/** Files larger than this are not searched for names. */
const MAX_SEARCH_BYTES = 1_000_000;

/** Directory names (lowercase) that hold tests and what they read. */
const TEST_DIRECTORIES: ReadonlySet<string> = new Set([
  'test',
  'tests',
  '__tests__',
  'spec',
  'specs',
  'testdata',
  '__snapshots__',
]);

/** A .NET test project folder, such as `Shop.Tests` or `Shop.UnitTests`. */
const TEST_PROJECT = /\.(unit|integration|functional|acceptance)?tests?$/i;

/** Basenames of test files across the common ecosystems. */
const TEST_FILES: readonly RegExp[] = [
  /[._](test|spec)\.[^.]+$/i,
  /^test_.+\.py$/,
  /^conftest\.py$/,
  /Tests?\.(cs|java|kt|scala|swift|vb|fs)$/,
];

/** An identifier in any language's text, for the name-based reference count. */
const IDENTIFIER = /[\p{L}_$][\p{L}\p{N}_$]*/gu;

/** Whether a path is a test, by its folders and basename. */
export function roleOf(path: string): PartRole {
  const segments = path.split('/');
  const name = segments.pop() ?? path;
  const inTestFolder = segments.some(
    (segment) => TEST_DIRECTORIES.has(segment.toLowerCase()) || TEST_PROJECT.test(segment),
  );
  return inTestFolder || TEST_FILES.some((pattern) => pattern.test(name)) ? 'test' : 'code';
}

/** Whether the part's code is new, changed or removed; see {@link Novelty}. */
export function noveltyOf(part: Part): Novelty {
  if (part.changeKind === 'addition') return 'new';
  if (part.changeKind === 'deletion') return 'removed';
  const changes = part.hunks.flatMap((hunk) => hunk.entities.map((entity) => entity.change));
  if (changes.length === 0) return 'changed';
  if (part.deletions === 0 && changes.every((change) => change === 'added')) return 'new';
  if (part.additions === 0 && changes.every((change) => change === 'removed')) return 'removed';
  return 'changed';
}

/** The public entities the part adds, removes or redeclares, in order of first appearance. */
export function publicSurfaceOf(part: Part): string[] {
  const names = part.hunks
    .flatMap((hunk) => hunk.entities)
    .filter((entity) => entity.public && entity.change !== 'body')
    .map((entity) => entity.name);
  return [...new Set(names)];
}

/**
 * The name other code uses for an entity: its own name, or its type's for
 * a dunder method such as `Store.__init__`, which callers never write.
 */
function referenceName(entity: Entity): string {
  const segments = entity.name.split('.');
  const own = segments.at(-1)!;
  return /^__\w+__$/.test(own) && segments.length > 1 ? segments.at(-2)! : own;
}

/** The names the part's reference count searches for. */
export function referenceNamesOf(part: Part): string[] {
  return [...new Set(entitiesOf(part.hunks).map(referenceName))];
}

/**
 * Finds which files of a copy mention each name as a whole word. Reads
 * every regular file once, skipping binaries and files larger than
 * {@link MAX_SEARCH_BYTES}; the paths are forward-slash, relative to the
 * copy. Name-based: a mention is a matching identifier, whatever it means.
 */
export async function filesNaming(
  copyDir: string,
  names: ReadonlySet<string>,
): Promise<Map<string, Set<string>>> {
  const found = new Map<string, Set<string>>([...names].map((name) => [name, new Set()]));
  if (names.size === 0) return found;
  const entries = await readdir(copyDir, { recursive: true, withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const absolute = join(entry.parentPath, entry.name);
    if ((await stat(absolute)).size > MAX_SEARCH_BYTES) continue;
    const content = await readFile(absolute);
    if (content.includes(0)) continue;
    const path = relative(copyDir, absolute).split(sep).join('/');
    for (const [identifier] of content.toString('utf8').matchAll(IDENTIFIER)) {
      found.get(identifier)?.add(path);
    }
  }
  return found;
}

/**
 * Sets every part's signals: new versus changed code, test versus code,
 * size, public surface change, and how many other files in the head copy
 * mention its entity names, counted by name and labelled so.
 */
export async function signalParts(parts: readonly Part[], headCopy: string): Promise<Part[]> {
  const namesByPart = parts.map(referenceNamesOf);
  const files = await filesNaming(headCopy, new Set(namesByPart.flat()));
  return parts.map((part, index) => {
    const names = namesByPart[index]!;
    const referring = new Set(names.flatMap((name) => [...(files.get(name) ?? [])]));
    referring.delete(part.path);
    const signals: PartSignals = {
      novelty: noveltyOf(part),
      role: roleOf(part.path),
      changedLines: part.additions + part.deletions,
      publicSurface: publicSurfaceOf(part),
      references: { basis: 'name-based', names, files: referring.size },
    };
    return { ...part, signals };
  });
}
