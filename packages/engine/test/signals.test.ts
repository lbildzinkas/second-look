import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ChangeKind, Entity, Part } from '../src/protocol.js';
import {
  filesNaming,
  noveltyOf,
  publicSurfaceOf,
  referenceNamesOf,
  roleOf,
  signalParts,
} from '../src/signals.js';
import { temporaryCacheDir } from './helpers.js';

/** A one-hunk part touching the given entities, with the given line counts. */
function partWith(options: {
  path?: string;
  changeKind?: ChangeKind;
  entities?: Entity[];
  additions?: number;
  deletions?: number;
}): Part {
  const additions = options.additions ?? 1;
  const deletions = options.deletions ?? 1;
  return {
    name: 'a part',
    path: options.path ?? 'src/cart.ts',
    changeKind: options.changeKind ?? 'modification',
    isBinary: false,
    oldMissingFinalNewline: false,
    newMissingFinalNewline: false,
    hunks: [
      {
        oldStart: 1,
        oldLines: deletions,
        newStart: 1,
        newLines: additions,
        lines: [
          ...Array.from({ length: deletions }, (_, i) => ({
            kind: 'deletion' as const,
            oldLineNumber: i + 1,
            text: 'old',
          })),
          ...Array.from({ length: additions }, (_, i) => ({
            kind: 'addition' as const,
            newLineNumber: i + 1,
            text: 'new',
          })),
        ],
        entities: options.entities ?? [],
      },
    ],
    additions,
    deletions,
    syntax: { formattingOnly: { status: 'not-checked', reason: '' }, checksNotRun: [] },
  };
}

function entity(name: string, change: Entity['change'], isPublic = true): Entity {
  return { kind: 'function', name, public: isPublic, change };
}

describe('test versus code', () => {
  it.each([
    ['tests/test_cart.py', 'test'],
    ['app/test_cart.py', 'test'],
    ['app/conftest.py', 'test'],
    ['src/cart.test.ts', 'test'],
    ['src/cart.spec.tsx', 'test'],
    ['src/__tests__/cart.ts', 'test'],
    ['cart/cart_test.go', 'test'],
    ['spec/cart_spec.rb', 'test'],
    ['src/Shop.Tests/CartTests.cs', 'test'],
    ['src/Shop.UnitTests/Helpers.cs', 'test'],
    ['src/test/java/CartTest.java', 'test'],
    ['pkg/testdata/input.json', 'test'],
    ['src/__snapshots__/cart.test.ts.snap', 'test'],
    ['src/cart.ts', 'code'],
    ['src/Contest.cs', 'code'],
    ['src/latest/version.ts', 'code'],
    ['app/testing_tools.py', 'code'],
    ['README.md', 'code'],
  ])('reads %s as %s', (path, role) => {
    expect(roleOf(path)).toBe(role);
  });
});

describe('new versus changed code', () => {
  it('reads an added file as new and a deleted one as removed', () => {
    expect(noveltyOf(partWith({ changeKind: 'addition', deletions: 0 }))).toBe('new');
    expect(noveltyOf(partWith({ changeKind: 'deletion', additions: 0 }))).toBe('removed');
  });

  it('reads added entities with no removed line as new', () => {
    const part = partWith({ entities: [entity('a', 'added'), entity('b', 'added')], deletions: 0 });
    expect(noveltyOf(part)).toBe('new');
  });

  it('reads removed entities with no added line as removed', () => {
    expect(noveltyOf(partWith({ entities: [entity('a', 'removed')], additions: 0 }))).toBe(
      'removed',
    );
  });

  it('reads anything else as changed', () => {
    expect(noveltyOf(partWith({ entities: [entity('a', 'body')] }))).toBe('changed');
    expect(noveltyOf(partWith({ entities: [entity('a', 'added'), entity('b', 'body')] }))).toBe(
      'changed',
    );
    // An added entity next to a removed line is a rewrite, not new code.
    expect(noveltyOf(partWith({ entities: [entity('a', 'added')] }))).toBe('changed');
    expect(noveltyOf(partWith({ deletions: 0 }))).toBe('changed');
  });
});

describe('size', () => {
  it('counts added and removed lines', async () => {
    const [part] = await signalParts([partWith({ additions: 7, deletions: 3 })], emptyCopy());
    expect(part!.signals!.changedLines).toBe(10);
  });
});

describe('public surface change', () => {
  it('lists public entities that are added, removed or redeclared, once each', () => {
    const part = partWith({
      entities: [
        entity('added', 'added'),
        entity('removed', 'removed'),
        entity('redeclared', 'declaration'),
        entity('redeclared', 'declaration'),
        entity('bodyOnly', 'body'),
        entity('privateHelper', 'declaration', false),
      ],
    });
    expect(publicSurfaceOf(part)).toEqual(['added', 'removed', 'redeclared']);
  });

  it('is empty when only bodies change', () => {
    expect(publicSurfaceOf(partWith({ entities: [entity('a', 'body')] }))).toEqual([]);
  });
});

let copy: string;
const copies: string[] = [];

function emptyCopy(): string {
  const dir = temporaryCacheDir();
  copies.push(dir);
  return dir;
}

beforeEach(() => {
  copy = emptyCopy();
  mkdirSync(join(copy, 'web', 'nested'), { recursive: true });
  writeFileSync(join(copy, 'web', 'cart.ts'), 'export class Cart { total() { return 1; } }\n');
  writeFileSync(join(copy, 'web', 'checkout.ts'), 'cart.total();\n');
  writeFileSync(join(copy, 'web', 'nested', 'view.tsx'), '<Total value={cart.total()} />\n');
  writeFileSync(join(copy, 'app.py'), 'subtotal = totals + total_price\n');
  writeFileSync(join(copy, 'logo.bin'), Buffer.from([0x74, 0x6f, 0x74, 0x61, 0x6c, 0x00]));
  writeFileSync(join(copy, 'huge.txt'), `total ${'x'.repeat(1_000_001)}`);
});

afterEach(() => {
  for (const dir of copies.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('references by name', () => {
  it('finds the files that mention a name as a whole word', async () => {
    const found = await filesNaming(copy, new Set(['total', 'Cart', 'missing']));
    expect([...found.get('total')!].sort()).toEqual([
      'web/cart.ts',
      'web/checkout.ts',
      'web/nested/view.tsx',
    ]);
    expect([...found.get('Cart')!]).toEqual(['web/cart.ts']);
    expect(found.get('missing')!.size).toBe(0);
  });

  it("searches each entity's own name, and the type's for a dunder method", () => {
    const part = partWith({
      entities: [
        entity('Cart.total', 'body'),
        entity('Store.__init__', 'body'),
        entity('other.total', 'body'),
        entity('__main__', 'body'),
      ],
    });
    expect(referenceNamesOf(part)).toEqual(['total', 'Store', '__main__']);
  });

  it('counts other files only, and labels the count name-based', async () => {
    const part = partWith({ path: 'web/cart.ts', entities: [entity('Cart.total', 'body')] });
    const [signalled] = await signalParts([part], copy);
    expect(signalled!.signals).toEqual({
      novelty: 'changed',
      role: 'code',
      changedLines: 2,
      publicSurface: [],
      references: { basis: 'name-based', names: ['total'], files: 2 },
    });
  });

  it('counts nothing for a part without entities, and still labels the count', async () => {
    const [signalled] = await signalParts([partWith({ path: 'notes.md' })], copy);
    expect(signalled!.signals!.references).toEqual({ basis: 'name-based', names: [], files: 0 });
  });
});
