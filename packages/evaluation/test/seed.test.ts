import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reviewChange } from '@second-look/engine';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CaptureStream } from '../../engine/test/helpers.js';
import { caseInput, loadCase } from '../src/case.js';
import { runCli } from '../src/cli.js';
import { seedCase } from '../src/seed.js';
import { scoresOf, tallyCase } from '../src/score.js';

/**
 * The source tree a mutant is seeded from: a public-style Python project
 * with one module and a second file that names its function, so the
 * name-based reference counts have something to count.
 */
const SHOP = `def total(prices):
    amount = 0
    for price in prices:
        amount += price
    if amount > 0:
        return amount
    return 0
`;
const REPORT = `from shop import total


def line(prices):
    return f"total: {total(prices)}"
`;
const README = `# Shop

Totals price lists.
`;
/** The mutant: the compound assignment flips, so prices are subtracted. */
const SHOP_MUTANT_DIFF = `diff --git a/src/shop.py b/src/shop.py
index 1111111..2222222 100644
--- a/src/shop.py
+++ b/src/shop.py
@@ -1,6 +1,6 @@
 def total(prices):
     amount = 0
     for price in prices:
-        amount += price
+        amount -= price
     if amount > 0:
         return amount
`;
const SHOP_MUTATED = SHOP.replace('amount += price', 'amount -= price');
/** The same mutant wrapped with benign edits from the same project. */
const WRAPPED_DIFF = `diff --git a/src/shop.py b/src/shop.py
index 1111111..3333333 100644
--- a/src/shop.py
+++ b/src/shop.py
@@ -1,6 +1,6 @@
 def total(prices):
     amount = 0
     for price in prices:
-        amount += price
+        amount -= price
     if amount > 0:
         return amount
diff --git a/src/report.py b/src/report.py
index 4444444..5555555 100644
--- a/src/report.py
+++ b/src/report.py
@@ -4,2 +4,2 @@
 def line(prices):
-    return f"total: {total(prices)}"
+    return f"sum: {total(prices)}"
diff --git a/README.md b/README.md
index 6666666..7777777 100644
--- a/README.md
+++ b/README.md
@@ -1,3 +1,3 @@
 # Shop
 
-Totals price lists.
+Totals a list of prices.
`;
const LOCKFILE = `{
  "lockfileVersion": 2,
  "packages": {}
}
`;
/** The same mutant wrapped with a lockfile touch, a noise-rule file. */
const LOCKFILE_WRAP_DIFF = `diff --git a/src/shop.py b/src/shop.py
index 1111111..3333333 100644
--- a/src/shop.py
+++ b/src/shop.py
@@ -1,6 +1,6 @@
 def total(prices):
     amount = 0
     for price in prices:
-        amount += price
+        amount -= price
     if amount > 0:
         return amount
diff --git a/package-lock.json b/package-lock.json
index 8888888..9999999 100644
--- a/package-lock.json
+++ b/package-lock.json
@@ -1,3 +1,3 @@
 {
-  "lockfileVersion": 2,
+  "lockfileVersion": 3,
   "packages": {}
`;

let scratch: string;
let source: string;
let casesFolder: string;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'second-look-seed-'));
  source = join(scratch, 'source');
  casesFolder = join(scratch, 'cases');
  mkdirSync(join(source, 'src'), { recursive: true });
  mkdirSync(casesFolder, { recursive: true });
  writeFileSync(join(source, 'src', 'shop.py'), SHOP);
  writeFileSync(join(source, 'src', 'report.py'), REPORT);
  writeFileSync(join(source, 'README.md'), README);
  writeFileSync(join(source, 'package-lock.json'), LOCKFILE);
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe('seedCase', () => {
  it('wraps a mutant as a case with neutral wording and a full expected.json', async () => {
    const folder = await seedCase(SHOP_MUTANT_DIFF, {
      sourceDir: source,
      casesFolder,
      id: 'seeded-shop',
      now: new Date('2026-10-01T00:00:00Z'),
    });

    const record = JSON.parse(readFileSync(join(folder, 'case.json'), 'utf8')) as Record<
      string,
      unknown
    >;
    expect(record).toMatchObject({
      formatVersion: 1,
      id: 'seeded-shop',
      source: (record.pullRequest as Record<string, unknown>).url,
      recordedAt: '2026-10-01T00:00:00.000Z',
      prompts: [],
      gitAttributes: null,
    });
    // Neutral wording: the title, branch and description name only the
    // changed file, never what the edit does.
    expect(record.pullRequest).toMatchObject({
      title: 'Update src/shop.py',
      description: 'Updates src/shop.py.',
      head: 'update-shop',
      base: 'master',
      author: 'contributor-login',
    });
    expect(record.baseCommit).toMatch(/^[0-9a-f]{40}$/);
    expect(record.headCommit).toMatch(/^[0-9a-f]{40}$/);
    expect((record.pullRequest as Record<string, string>).url).toMatch(
      /^https:\/\/github\.com\/example-org\/example-repo\/pull\/\d+$/,
    );
    expect(readFileSync(join(folder, 'change.diff'), 'utf8')).toBe(SHOP_MUTANT_DIFF);
    expect(readFileSync(join(folder, 'base', 'src', 'shop.py'), 'utf8')).toBe(SHOP);
    expect(readFileSync(join(folder, 'head', 'src', 'shop.py'), 'utf8')).toBe(SHOP_MUTATED);
    // The file naming the changed function rides along on the head side,
    // so the name-based reference counts replay.
    expect(existsSync(join(folder, 'head', 'src', 'report.py'))).toBe(true);
    expect(existsSync(join(folder, 'base', 'src', 'report.py'))).toBe(false);

    const expected = JSON.parse(readFileSync(join(folder, 'expected.json'), 'utf8')) as Record<
      string,
      unknown
    >;
    expect(expected['noise']).toEqual({ 'src/shop.py': { label: 'none' } });
    expect(expected['importantParts']).toEqual(['total in src/shop.py']);
    expect(expected['claims']).toEqual([]);
  });

  it('wraps a mutant with benign edits, marking only the fault part important', async () => {
    const folder = await seedCase(WRAPPED_DIFF, {
      sourceDir: source,
      casesFolder,
      id: 'wrapped-shop',
      faultPath: 'src/shop.py',
      now: new Date('2026-10-01T00:00:00Z'),
    });

    const record = JSON.parse(readFileSync(join(folder, 'case.json'), 'utf8')) as Record<
      string,
      unknown
    >;
    expect(record.pullRequest).toMatchObject({
      title: 'Update 3 files',
      description: 'Updates 3 files.',
      head: 'update-3-files',
    });
    expect(readFileSync(join(folder, 'head', 'src', 'shop.py'), 'utf8')).toBe(SHOP_MUTATED);
    expect(readFileSync(join(folder, 'base', 'src', 'report.py'), 'utf8')).toBe(REPORT);
    expect(readFileSync(join(folder, 'head', 'README.md'), 'utf8')).toBe(
      README.replace('Totals price lists.', 'Totals a list of prices.'),
    );

    const expected = JSON.parse(readFileSync(join(folder, 'expected.json'), 'utf8')) as Record<
      string,
      unknown
    >;
    expect(expected['noise']).toEqual({
      'README.md': { label: 'none' },
      'src/report.py': { label: 'none' },
      'src/shop.py': { label: 'none' },
    });
    expect(expected['importantParts']).toEqual(['total in src/shop.py']);
  });

  it("records a wrap's noise-rule file with the label the live review gave it", async () => {
    const folder = await seedCase(LOCKFILE_WRAP_DIFF, {
      sourceDir: source,
      casesFolder,
      id: 'lockfile-wrap',
      faultPath: 'src/shop.py',
    });
    const expected = JSON.parse(readFileSync(join(folder, 'expected.json'), 'utf8')) as Record<
      string,
      unknown
    >;
    expect(expected['noise']).toEqual({
      'package-lock.json': { label: 'lockfile', state: 'claimed' },
      'src/shop.py': { label: 'none' },
    });
    expect(expected['importantParts']).toEqual(['total in src/shop.py']);
  });

  it('marks every part important when no fault path is given', async () => {
    const folder = await seedCase(WRAPPED_DIFF, {
      sourceDir: source,
      casesFolder,
      id: 'unmarked-shop',
    });
    const expected = JSON.parse(readFileSync(join(folder, 'expected.json'), 'utf8')) as Record<
      string,
      unknown
    >;
    expect(expected['importantParts']).toEqual([
      'total in src/shop.py',
      'line in src/report.py',
      'README.md',
    ]);
  });

  it('gives the same mutant the same wrapped pull request', async () => {
    const folders = [
      await seedCase(SHOP_MUTANT_DIFF, { sourceDir: source, casesFolder, id: 'one' }),
      await seedCase(SHOP_MUTANT_DIFF, { sourceDir: source, casesFolder, id: 'two' }),
    ];
    const summaries = folders.map(
      (folder) =>
        (JSON.parse(readFileSync(join(folder, 'case.json'), 'utf8')) as Record<string, unknown>)[
          'pullRequest'
        ],
    );
    expect(summaries[0]).toEqual(summaries[1]);
  });

  it('writes a case whose rank scores measure the fault part', async () => {
    const folder = await seedCase(WRAPPED_DIFF, {
      sourceDir: source,
      casesFolder,
      id: 'seeded-shop',
      faultPath: 'src/shop.py',
    });
    const evaluationCase = await loadCase(folder);
    const review = await reviewChange(await caseInput(evaluationCase));
    const diff = readFileSync(join(folder, 'change.diff'), 'utf8');
    const scores = scoresOf(tallyCase(diff, evaluationCase.expected, review.parts));
    const byName = Object.fromEntries(scores.map((score) => [score.name, score.value]));
    expect(byName['coverage']).toBe(1);
    expect(byName['noise-precision:none']).toBe(1);
    expect(byName['noise-recall:none']).toBe(1);
    expect(byName['rank-median']).toBe(1);
    expect(byName['rank-top-3']).toBe(1);
  });

  it('writes a lone-mutant case too small for the rank scores to count', async () => {
    const folder = await seedCase(SHOP_MUTANT_DIFF, {
      sourceDir: source,
      casesFolder,
      id: 'seeded-shop',
    });
    const evaluationCase = await loadCase(folder);
    const review = await reviewChange(await caseInput(evaluationCase));
    const diff = readFileSync(join(folder, 'change.diff'), 'utf8');
    const scores = scoresOf(tallyCase(diff, evaluationCase.expected, review.parts));
    const byName = Object.fromEntries(scores.map((score) => [score.name, score.value]));
    expect(byName['coverage']).toBe(1);
    expect(byName['rank-median']).toBeUndefined();
    expect(byName['rank-top-3']).toBeUndefined();
  });

  it('derives a clean branch name from a file whose stem starts wide', async () => {
    mkdirSync(join(source, 'src'), { recursive: true });
    writeFileSync(join(source, 'src', '_re.py'), 'def f(x):\n    return x\n');
    const underscore = `diff --git a/src/_re.py b/src/_re.py
--- a/src/_re.py
+++ b/src/_re.py
@@ -1,2 +1,2 @@
 def f(x):
-    return x
+    return -x
`;
    const folder = await seedCase(underscore, { sourceDir: source, casesFolder, id: 'underscore' });
    const record = JSON.parse(readFileSync(join(folder, 'case.json'), 'utf8')) as Record<
      string,
      unknown
    >;
    expect((record.pullRequest as Record<string, string>).head).toBe('update-re');
  });

  it('refuses a diff that does not apply to the source tree', async () => {
    const stranger = SHOP_MUTANT_DIFF.replace('amount = 0', 'amount = 1');
    await expect(
      seedCase(stranger, { sourceDir: source, casesFolder, id: 'stranger' }),
    ).rejects.toThrow('the mutant diff does not apply to src/shop.py');
  });

  it('refuses a fault path the diff does not change', async () => {
    await expect(
      seedCase(SHOP_MUTANT_DIFF, {
        sourceDir: source,
        casesFolder,
        id: 'stranger',
        faultPath: 'src/other.py',
      }),
    ).rejects.toThrow('the diff does not change the fault path: src/other.py');
  });

  it('refuses a binary mutant and a case name already taken', async () => {
    const binary = `diff --git a/src/logo.png b/src/logo.png
Binary files a/src/logo.png and b/src/logo.png differ
`;
    await expect(seedCase(binary, { sourceDir: source, casesFolder, id: 'binary' })).rejects.toThrow(
      'binary file',
    );
    await seedCase(SHOP_MUTANT_DIFF, { sourceDir: source, casesFolder, id: 'taken' });
    await expect(
      seedCase(SHOP_MUTANT_DIFF, { sourceDir: source, casesFolder, id: 'taken' }),
    ).rejects.toThrow('a case already exists');
  });

  it('refuses a case name that is not a usable folder name', async () => {
    await expect(
      seedCase(SHOP_MUTANT_DIFF, { sourceDir: source, casesFolder, id: '../outside' }),
    ).rejects.toThrow('not a usable case name');
  });
});

describe('the seed command', () => {
  async function cli(argv: readonly string[]): Promise<{ code: number; out: string; err: string }> {
    const out = new CaptureStream();
    const err = new CaptureStream();
    const code = await runCli([...argv], {}, { out, err });
    return { code, out: out.text, err: err.text };
  }

  it('seeds a mutant diff into a case folder', async () => {
    const diffFile = join(scratch, 'mutant.diff');
    writeFileSync(diffFile, SHOP_MUTANT_DIFF);
    const seeded = await cli([
      'seed',
      diffFile,
      '--source',
      source,
      '--cases',
      casesFolder,
      '--id',
      'mine',
    ]);
    expect(seeded.err).toBe('');
    expect(seeded.code).toBe(0);
    expect(seeded.out).toContain(`seeded ${join(casesFolder, 'mine')}`);
    expect(existsSync(join(casesFolder, 'mine', 'case.json'))).toBe(true);
  });

  it('passes the fault path through, marking only the fault part important', async () => {
    const diffFile = join(scratch, 'wrapped.diff');
    writeFileSync(diffFile, WRAPPED_DIFF);
    const seeded = await cli([
      'seed',
      diffFile,
      '--source',
      source,
      '--cases',
      casesFolder,
      '--id',
      'wrapped',
      '--fault',
      'src/shop.py',
    ]);
    expect(seeded.err).toBe('');
    expect(seeded.code).toBe(0);
    const expected = JSON.parse(
      readFileSync(join(casesFolder, 'wrapped', 'expected.json'), 'utf8'),
    ) as Record<string, unknown>;
    expect(expected['importantParts']).toEqual(['total in src/shop.py']);
  });

  it('refuses to seed without a source, an id or a cases folder', async () => {
    const diffFile = join(scratch, 'mutant.diff');
    writeFileSync(diffFile, SHOP_MUTANT_DIFF);
    for (const argv of [
      ['seed', diffFile, '--id', 'mine', '--cases', casesFolder],
      ['seed', diffFile, '--source', source, '--cases', casesFolder],
      ['seed', diffFile, '--source', source, '--id', 'mine'],
    ]) {
      const refused = await cli(argv);
      expect(refused.code).toBe(1);
      expect(refused.err).toContain('second-look-eval:');
    }
  });
});
