import type { Entity, Hunk, Part } from './protocol.js';

/** How many entity names a part's name lists before it counts the rest. */
const NAMED_ENTITIES = 3;

/** The group every hunk outside all entities joins, one per file. */
const TOP_LEVEL = 'top level';

function entityKey(entity: Entity): string {
  return `${entity.kind} ${entity.name}`;
}

/** The entities of some hunks, each once, in order of first appearance. */
export function entitiesOf(hunks: readonly Hunk[]): Entity[] {
  const entities = new Map<string, Entity>();
  for (const entity of hunks.flatMap((hunk) => hunk.entities)) {
    if (!entities.has(entity.name)) entities.set(entity.name, entity);
  }
  return [...entities.values()];
}

/**
 * Names a part after the entities its hunks touch and its file; hunks
 * outside every entity are top-level code, and a file whose entities could
 * not be named keeps its bare path.
 */
function partName(file: Part, hunks: readonly Hunk[]): string {
  const names = entitiesOf(hunks).map((entity) => entity.name);
  if (names.length > 0) {
    const listed = names.slice(0, NAMED_ENTITIES).join(', ');
    const rest = names.length - NAMED_ENTITIES;
    return `${listed}${rest > 0 ? ` and ${rest} more` : ''} in ${file.path}`;
  }
  const named = hunks.length > 0 && !file.syntax.checksNotRun.some((c) => c.check === 'entities');
  return named ? `top-level code in ${file.path}` : file.path;
}

/** A part holding some of a file's hunks, with its own name and line counts. */
function partOf(file: Part, hunks: Hunk[]): Part {
  const count = (kind: 'addition' | 'deletion'): number =>
    hunks.reduce((sum, hunk) => sum + hunk.lines.filter((line) => line.kind === kind).length, 0);
  return {
    ...file,
    name: partName(file, hunks),
    hunks,
    additions: count('addition'),
    deletions: count('deletion'),
  };
}

/**
 * Splits one file into parts: hunks that touch a shared entity join one
 * part, directly or through other hunks, and the hunks outside every
 * entity form one more. Parts follow their first hunk's diff order, and a
 * file without hunks, such as a binary or a pure rename, is one part.
 */
function splitFile(file: Part): Part[] {
  if (file.hunks.length === 0) return [partOf(file, [])];
  // Union-find over the hunks; a group's root is its first hunk.
  const root = file.hunks.map((_, index) => index);
  const find = (index: number): number => {
    while (root[index] !== index) index = root[index] = root[root[index]!]!;
    return index;
  };
  const firstHunkWith = new Map<string, number>();
  file.hunks.forEach((hunk, index) => {
    const keys = hunk.entities.length === 0 ? [TOP_LEVEL] : hunk.entities.map(entityKey);
    for (const key of keys) {
      const seen = firstHunkWith.get(key);
      if (seen === undefined) {
        firstHunkWith.set(key, index);
        continue;
      }
      const [a, b] = [find(seen), find(index)];
      root[Math.max(a, b)] = Math.min(a, b);
    }
  });
  const groups = new Map<number, Hunk[]>();
  file.hunks.forEach((hunk, index) => {
    const group = find(index);
    groups.set(group, [...(groups.get(group) ?? []), hunk]);
  });
  return [...groups.values()].map((hunks) => partOf(file, hunks));
}

/**
 * Groups the hunks of every file into parts named after the entities they
 * touch, keeping the files' diff order. Each part repeats its file's own
 * fields and counts only its own lines; every changed line lands in
 * exactly one part, which the coverage validator proves.
 */
export function groupParts(files: readonly Part[]): Part[] {
  return files.flatMap(splitFile);
}
