import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pullRequestCacheDir, removeCopy } from '../src/cache.js';
import { parseDiff } from '../src/diff.js';
import type { PullRequestRef } from '../src/github.js';
import type { Part, ReviewedMarks } from '../src/protocol.js';
import {
  NO_MARKS,
  REVIEWED_MARKS_FILE,
  applyMark,
  isMarkedPart,
  markedPart,
  partContentHash,
  partPieces,
  partsLeft,
  readReviewedMarks,
  reviewedState,
  saveReviewedMark,
  wholeFilesReviewed,
} from '../src/reviewed-marks.js';
import { temporaryCacheDir } from './helpers.js';

const NOW = new Date('2026-10-06T12:00:00Z');

/** The diff before the push: a cart total edited, a helper added, and a two-hunk config change. */
const BEFORE = `diff --git a/web/cart.ts b/web/cart.ts
index 1111111..2222222 100644
--- a/web/cart.ts
+++ b/web/cart.ts
@@ -10,3 +10,3 @@ export class Cart {
   total(): number {
-    return this.items.length;
+    return this.items.reduce((sum, item) => sum + item.price, 0);
   }
diff --git a/web/money.ts b/web/money.ts
new file mode 100644
index 0000000..3333333
--- /dev/null
+++ b/web/money.ts
@@ -0,0 +1,2 @@
+export const cents = (value: number): number => Math.round(value * 100);
+export const euros = (value: number): number => value / 100;
diff --git a/config/app.json b/config/app.json
index 4444444..5555555 100644
--- a/config/app.json
+++ b/config/app.json
@@ -2,3 +2,3 @@
   "name": "shop",
-  "currency": "USD",
+  "currency": "EUR",
   "debug": false
@@ -20,3 +20,3 @@
   "cache": {
-    "ttl": 60
+    "ttl": 300
   }
`;

/** The same change after a push that edits only the cart total, and adds lines above it. */
const AFTER = `diff --git a/web/cart.ts b/web/cart.ts
index 1111111..6666666 100644
--- a/web/cart.ts
+++ b/web/cart.ts
@@ -12,3 +12,3 @@ export class Cart {
   total(): number {
-    return this.items.length;
+    return this.items.reduce((sum, item) => sum + item.price * item.quantity, 0);
   }
diff --git a/web/money.ts b/web/money.ts
new file mode 100644
index 0000000..3333333
--- /dev/null
+++ b/web/money.ts
@@ -0,0 +1,2 @@
+export const cents = (value: number): number => Math.round(value * 100);
+export const euros = (value: number): number => value / 100;
diff --git a/config/app.json b/config/app.json
index 4444444..5555555 100644
--- a/config/app.json
+++ b/config/app.json
@@ -40,3 +40,3 @@
   "name": "shop",
-  "currency": "USD",
+  "currency": "EUR",
   "debug": false
@@ -58,3 +58,3 @@
   "cache": {
-    "ttl": 60
+    "ttl": 300
   }
`;

/** Names each parsed file as its part, the way the engine does before printing. */
function partsOf(diff: string): Part[] {
  return parseDiff(diff).files.map((file) => ({ ...file, name: `top-level code in ${file.path}` }));
}

/** Splits a file's part into one part per hunk, each named after the file and the hunk's place. */
function splitByHunk(part: Part): Part[] {
  return part.hunks.map((hunk, index) => ({ ...part, name: `${part.path} hunk ${index + 1}`, hunks: [hunk] }));
}

function mark(marks: ReviewedMarks, part: Part, reviewed = true): ReviewedMarks {
  return applyMark(marks, markedPart(part), reviewed, NOW);
}

function markAll(parts: readonly Part[]): ReviewedMarks {
  return parts.reduce((marks, part) => mark(marks, part), NO_MARKS);
}

describe('content hashes', () => {
  it('leave a part alone when only its line numbers moved', () => {
    const before = partsOf(BEFORE);
    const after = partsOf(AFTER);

    expect(partContentHash(after[1]!)).toBe(partContentHash(before[1]!));
    expect(partContentHash(after[2]!)).toBe(partContentHash(before[2]!));
  });

  it('change when a part’s content changes', () => {
    expect(partContentHash(partsOf(AFTER)[0]!)).not.toBe(partContentHash(partsOf(BEFORE)[0]!));
  });

  it('give each hunk its own piece, and tell identical hunks of one file apart', () => {
    const config = partsOf(BEFORE)[2]!;
    const twice = { ...config, hunks: [config.hunks[1]!, config.hunks[1]!] };

    expect(partPieces(config)).toHaveLength(2);
    expect(new Set(partPieces(twice)).size).toBe(2);
  });

  it('follow a binary file’s blob ids, since no hunk shows its change', () => {
    const binary = (index: string): Part =>
      partsOf(`diff --git a/assets/logo.png b/assets/logo.png\nindex ${index} 100644\nBinary files a/assets/logo.png and b/assets/logo.png differ\n`)[0]!;

    expect(binary('1234567..89abcde').blobs).toEqual({ old: '1234567', new: '89abcde' });
    expect(partContentHash(binary('1234567..89abcde'))).toBe(partContentHash(binary('1234567..89abcde')));
    expect(partContentHash(binary('1234567..fedcba9'))).not.toBe(partContentHash(binary('1234567..89abcde')));
  });

  it('change with the file’s path or mode, which every piece carries', () => {
    const cart = partsOf(BEFORE)[0]!;

    expect(partContentHash({ ...cart, path: 'web/basket.ts' })).not.toBe(partContentHash(cart));
    expect(partContentHash({ ...cart, newMode: '100755' })).not.toBe(partContentHash(cart));
  });
});

describe('reviewed state', () => {
  it('unmarks only the part a push changed, which says it changed since it was marked', () => {
    const marks = markAll(partsOf(BEFORE));
    const after = partsOf(AFTER);

    expect(after.map((part) => reviewedState(part, marks))).toEqual(['changed since marked', 'reviewed', 'reviewed']);
    expect(partsLeft(after, marks)).toBe(1);
  });

  it('reads an unmarked part as not reviewed', () => {
    const [cart, money] = partsOf(BEFORE);
    const marks = mark(NO_MARKS, cart!);

    expect(reviewedState(money!, marks)).toBe('not reviewed');
    expect(partsLeft(partsOf(BEFORE), marks)).toBe(2);
  });

  it('says a marked part changed when the push adds a hunk to it', () => {
    const config = partsOf(BEFORE)[2]!;
    const marks = mark(NO_MARKS, { ...config, hunks: [config.hunks[0]!] });

    expect(reviewedState(config, { marks: marks.marks.map((each) => ({ ...each, name: 'another name' })) })).toBe('changed since marked');
  });

  it('keeps a regrouped part reviewed when every piece of it was marked', () => {
    const config = partsOf(BEFORE)[2]!;
    const marks = markAll(splitByHunk(config));

    expect(reviewedState(config, marks)).toBe('reviewed');
  });

  it('clears exactly the content a part shows when it is unmarked', () => {
    const parts = partsOf(BEFORE);
    const marks = mark(markAll(parts), parts[0]!, false);

    expect(parts.map((part) => reviewedState(part, marks))).toEqual(['not reviewed', 'reviewed', 'reviewed']);
  });

  it('replaces a part’s earlier mark when it is marked again after a change', () => {
    const marks = mark(markAll(partsOf(BEFORE)), partsOf(AFTER)[0]!);

    expect(marks.marks).toHaveLength(3);
    expect(marks.marks.find((each) => each.name === 'top-level code in web/cart.ts')?.hash).toBe(partContentHash(partsOf(AFTER)[0]!));
    expect(reviewedState(partsOf(BEFORE)[0]!, marks)).toBe('changed since marked');
  });
});

describe('wholeFilesReviewed', () => {
  it('names a file only once every part holding it is reviewed', () => {
    const [config1, config2] = splitByHunk(partsOf(BEFORE)[2]!);
    const half = mark(NO_MARKS, config1!);

    expect(wholeFilesReviewed([config1!, config2!], half, ['config/app.json'])).toEqual([]);
    expect(wholeFilesReviewed([config1!, config2!], mark(half, config2!), ['config/app.json'])).toEqual(['config/app.json']);
  });

  it('counts a part across files toward each of its files', () => {
    const [cart, money] = partsOf(BEFORE);
    const across: Part = { ...cart!, name: 'Cart.total across files', otherFiles: [money!] };
    const marks = mark(NO_MARKS, across);

    expect(wholeFilesReviewed([across], marks, ['web/cart.ts', 'web/money.ts', 'web/cart.ts'])).toEqual(['web/cart.ts', 'web/money.ts']);
  });

  it('never names a file the parts do not hold', () => {
    expect(wholeFilesReviewed(partsOf(BEFORE), markAll(partsOf(BEFORE)), ['elsewhere.ts'])).toEqual([]);
  });
});

describe('isMarkedPart', () => {
  it('accepts a name with sha256 piece hashes, and nothing else', () => {
    const part = markedPart(partsOf(BEFORE)[0]!);

    expect(isMarkedPart(part)).toBe(true);
    expect(isMarkedPart({ ...part, pieces: [] })).toBe(false);
    expect(isMarkedPart({ ...part, pieces: ['../../etc'] })).toBe(false);
    expect(isMarkedPart({ ...part, name: '' })).toBe(false);
  });
});

describe('the local per-pull-request store', () => {
  const ref: PullRequestRef = { owner: 'example-org', repo: 'example-repo', number: 42 };
  let cacheDir: string;

  beforeAll(() => {
    cacheDir = temporaryCacheDir();
  });

  afterAll(async () => {
    await removeCopy(cacheDir);
  });

  it('holds no marks before any is made', async () => {
    expect(await readReviewedMarks(temporaryCacheDir(), ref)).toEqual(NO_MARKS);
  });

  it('keeps marks across restarts, keyed by the part’s content hash', async () => {
    const [cart, money] = partsOf(BEFORE);
    await saveReviewedMark(cacheDir, ref, markedPart(cart!), true, NOW);
    const answered = await saveReviewedMark(cacheDir, ref, markedPart(money!), true, NOW);

    // A fresh read stands for an engine started again: only the file is shared.
    const read = await readReviewedMarks(cacheDir, ref);
    expect(read).toEqual(answered);
    expect(read.marks.map((each) => each.name)).toEqual(['top-level code in web/cart.ts', 'top-level code in web/money.ts']);
    const stored = JSON.parse(await readFile(join(pullRequestCacheDir(cacheDir, ref), REVIEWED_MARKS_FILE), 'utf8')) as {
      version: number;
      marks: Record<string, { name: string; markedAt: string }>;
    };
    expect(stored.version).toBe(1);
    expect(stored.marks[partContentHash(cart!)]).toMatchObject({ name: 'top-level code in web/cart.ts', markedAt: NOW.toISOString() });
  });

  it('applies marks made in quick succession one after another', async () => {
    const other = { ...ref, number: 43 };
    const parts = partsOf(BEFORE);
    await Promise.all(parts.map((part) => saveReviewedMark(cacheDir, other, markedPart(part), true, NOW)));

    expect(partsLeft(parts, await readReviewedMarks(cacheDir, other))).toBe(0);
  });

  it('reads a store it cannot parse as holding no marks', async () => {
    const broken = { ...ref, number: 44 };
    await saveReviewedMark(cacheDir, broken, markedPart(partsOf(BEFORE)[0]!), true, NOW);
    await writeFile(join(pullRequestCacheDir(cacheDir, broken), REVIEWED_MARKS_FILE), '{ not json', 'utf8');

    expect(await readReviewedMarks(cacheDir, broken)).toEqual(NO_MARKS);
  });

  it('leaves out an entry that is not a mark', async () => {
    const odd = { ...ref, number: 45 };
    const saved = await saveReviewedMark(cacheDir, odd, markedPart(partsOf(BEFORE)[0]!), true, NOW);
    const path = join(pullRequestCacheDir(cacheDir, odd), REVIEWED_MARKS_FILE);
    const stored = JSON.parse(await readFile(path, 'utf8')) as { marks: Record<string, unknown> };
    stored.marks['not-a-hash'] = { name: 'x', pieces: [], markedAt: NOW.toISOString() };
    await writeFile(path, JSON.stringify(stored), 'utf8');

    expect(await readReviewedMarks(cacheDir, odd)).toEqual(saved);
  });
});
