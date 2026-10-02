import { describe, expect, it } from 'vitest';
import { validateCoverage } from '../src/coverage.js';
import { parseDiff } from '../src/diff.js';
import { groupParts } from '../src/parts.js';
import type { Part } from '../src/protocol.js';
import { analysePart } from '../src/syntax.js';

const CART_BASE = `import { tax } from './tax';

export function subtotal(items: number[]): number {
  return items.reduce((sum, item) => sum + item, 0);
}

function round(value: number): number {
  return Math.round(value);
}

export function total(items: number[]): number {
  return round(subtotal(items));
}
`;

const CART_HEAD = `import { tax } from './tax';
import { fee } from './fee';

export function subtotal(items: number[]): number {
  return items.reduce((sum, item) => sum + item, 0) + fee;
}

function round(value: number): number {
  return Math.round(value);
}

export function total(items: number[]): number {
  return round(subtotal(items) * tax);
}
`;

/** Three hunks: an import, a change in subtotal, and one in total. */
const CART_DIFF = `diff --git a/web/cart.ts b/web/cart.ts
index 1111111..2222222 100644
--- a/web/cart.ts
+++ b/web/cart.ts
@@ -1,2 +1,3 @@
 import { tax } from './tax';
+import { fee } from './fee';
 
@@ -3,3 +4,3 @@ import { tax } from './tax';
 export function subtotal(items: number[]): number {
-  return items.reduce((sum, item) => sum + item, 0);
+  return items.reduce((sum, item) => sum + item, 0) + fee;
 }
@@ -11,3 +12,3 @@ function round(value: number): number {
 export function total(items: number[]): number {
-  return round(subtotal(items));
+  return round(subtotal(items) * tax);
 }
diff --git a/notes.md b/notes.md
index 3333333..4444444 100644
--- a/notes.md
+++ b/notes.md
@@ -1 +1 @@
-old
+new
`;

/** The cart diff, parsed and run through the syntax pass. */
async function cartFiles(): Promise<{ files: Part[]; diff: ReturnType<typeof parseDiff> }> {
  const diff = parseDiff(CART_DIFF);
  await analysePart(diff.files[0]!, { base: CART_BASE, head: CART_HEAD });
  await analysePart(diff.files[1]!, { base: 'old\n', head: 'new\n' });
  return { files: diff.files, diff };
}

/** A file whose hunks name the given entities, one list per hunk. */
function fileWithHunks(path: string, entitiesPerHunk: string[][]): Part {
  return {
    path,
    changeKind: 'modification',
    isBinary: false,
    oldMissingFinalNewline: false,
    newMissingFinalNewline: false,
    hunks: entitiesPerHunk.map((names, index) => ({
      oldStart: index * 10 + 1,
      oldLines: 1,
      newStart: index * 10 + 1,
      newLines: 1,
      lines: [
        { kind: 'deletion', oldLineNumber: index * 10 + 1, text: 'old' },
        { kind: 'addition', newLineNumber: index * 10 + 1, text: 'new' },
      ],
      entities: names.map((name) => ({ kind: 'function', name, public: false, change: 'body' })),
    })),
    additions: entitiesPerHunk.length,
    deletions: entitiesPerHunk.length,
    syntax: {
      language: 'typescript',
      formattingOnly: { status: 'not-checked', reason: '' },
      checksNotRun: [],
    },
  };
}

describe('groupParts', () => {
  it('splits a file into parts named after the entities its hunks touch', async () => {
    const { files } = await cartFiles();
    const parts = groupParts(files);
    expect(parts.map((part) => part.name)).toEqual([
      'top-level code in web/cart.ts',
      'subtotal in web/cart.ts',
      'total in web/cart.ts',
      'notes.md',
    ]);
    expect(parts.map((part) => [part.additions, part.deletions])).toEqual([
      [1, 0],
      [1, 1],
      [1, 1],
      [1, 1],
    ]);
    // Each part repeats its file's own fields.
    expect(parts.slice(0, 3).every((part) => part.path === 'web/cart.ts')).toBe(true);
    expect(parts[1]!.syntax).toBe(files[0]!.syntax);
  });

  it('joins hunks that share an entity, directly or through another hunk', () => {
    const file = fileWithHunks('a.ts', [['a'], ['b'], ['a', 'c'], ['c', 'b'], ['d'], []]);
    const parts = groupParts([file]);
    expect(parts.map((part) => part.name)).toEqual([
      'a, b, c in a.ts',
      'd in a.ts',
      'top-level code in a.ts',
    ]);
    expect(parts[0]!.hunks.map((hunk) => hunk.oldStart)).toEqual([1, 11, 21, 31]);
  });

  it('names a part after at most three entities, then counts the rest', () => {
    const parts = groupParts([fileWithHunks('a.ts', [['a', 'b', 'c', 'd', 'e']])]);
    expect(parts[0]!.name).toBe('a, b, c and 2 more in a.ts');
  });

  it('keeps the bare path when entities could not be named, and one part for a file without hunks', () => {
    const ruby = fileWithHunks('deploy.rb', [[], []]);
    ruby.syntax.checksNotRun = [{ check: 'entities', reason: 'no grammar for ".rb" files' }];
    const binary = { ...fileWithHunks('logo.png', []), isBinary: true };
    const parts = groupParts([ruby, binary]);
    expect(parts.map((part) => [part.name, part.hunks.length])).toEqual([
      ['deploy.rb', 2],
      ['logo.png', 0],
    ]);
  });
});

describe('coverage of the grouped parts', () => {
  it('proves every changed line is in exactly one part', async () => {
    const { files, diff } = await cartFiles();
    expect(validateCoverage(diff, groupParts(files))).toEqual({ ok: true, problems: [] });
  });

  it('fails when a changed line is in no part', async () => {
    const { files, diff } = await cartFiles();
    const parts = groupParts(files);
    const kept = parts.filter((part) => part.name !== 'total in web/cart.ts');
    const report = validateCoverage(diff, kept);
    expect(report.ok).toBe(false);
    expect(report.problems).toContainEqual({
      file: 'web/cart.ts',
      description: 'changed line new:13 belongs to no part',
    });
  });

  it('fails when a changed line is in two parts', async () => {
    const { files, diff } = await cartFiles();
    const parts = groupParts(files);
    parts[2] = { ...parts[2]!, hunks: [...parts[2]!.hunks, parts[1]!.hunks[0]!] };
    const report = validateCoverage(diff, parts);
    expect(report.ok).toBe(false);
    expect(report.problems).toContainEqual({
      file: 'web/cart.ts',
      description: 'changed line new:5 belongs to more than one part',
    });
  });
});
