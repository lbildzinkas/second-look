import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { positionComments } from '../src/positions.js';
import type { Comment } from '../src/protocol.js';

/** Two files, the first with two hunks, the second restarting the count. */
const MULTI_HUNK_DIFF = [
  'diff --git a/one.txt b/one.txt',
  'index 1111111..2222222 100644',
  '--- a/one.txt',
  '+++ b/one.txt',
  '@@ -1,3 +1,3 @@',
  ' keep',
  '-old 2',
  '+new 2',
  ' keep',
  '@@ -10,3 +10,3 @@',
  ' keep',
  '-old 11',
  '+new 11',
  ' keep',
  'diff --git a/two.txt b/two.txt',
  'index 3333333..4444444 100644',
  '--- a/two.txt',
  '+++ b/two.txt',
  '@@ -5,2 +5,2 @@',
  ' ctx',
  '-changed',
  '+changed too',
  '',
].join('\n');

/** The old side's last line, mid-hunk, ends without a newline; additions follow. */
const MARKER_MID_HUNK_DIFF = [
  'diff --git a/tail.txt b/tail.txt',
  'index 1111111..2222222 100644',
  '--- a/tail.txt',
  '+++ b/tail.txt',
  '@@ -1,2 +1,3 @@',
  ' top',
  '-end',
  '\\ No newline at end of file',
  '+new middle',
  '+new end',
  '',
].join('\n');

/** A comment on one line of one.txt or two.txt. */
function lineComment(
  path: string,
  side: 'base' | 'head',
  line: number,
  body = 'a comment',
): Comment {
  return { kind: 'line', path, side, line, body };
}

describe('positionComments', () => {
  it('counts from the first hunk header: the line below it is position 1', () => {
    const [first, second] = positionComments(MULTI_HUNK_DIFF, [
      lineComment('one.txt', 'base', 2),
      lineComment('one.txt', 'head', 2),
    ]);

    expect(first).toEqual({ path: 'one.txt', body: 'a comment', position: 2 });
    expect(second).toEqual({ path: 'one.txt', body: 'a comment', position: 3 });
  });

  it('continues the count through a second hunk, counting its header', () => {
    // Hunk one holds four body lines at positions 1 to 4; the second
    // header sits at position 5, so its first body line is position 6.
    const [context, deleted, added] = positionComments(MULTI_HUNK_DIFF, [
      lineComment('one.txt', 'head', 10),
      lineComment('one.txt', 'base', 11),
      lineComment('one.txt', 'head', 11),
    ]);

    expect(context!.position).toBe(6);
    expect(deleted!.position).toBe(7);
    expect(added!.position).toBe(8);
  });

  it('restarts the count at each file', () => {
    const [context, deleted, added] = positionComments(MULTI_HUNK_DIFF, [
      lineComment('two.txt', 'base', 5),
      lineComment('two.txt', 'base', 6),
      lineComment('two.txt', 'head', 6),
    ]);

    expect(context!.position).toBe(1);
    expect(deleted!.position).toBe(2);
    expect(added!.position).toBe(3);
  });

  it('finds the same line on either side when it is context', () => {
    const [onBase, onHead] = positionComments(MULTI_HUNK_DIFF, [
      lineComment('one.txt', 'base', 12),
      lineComment('one.txt', 'head', 12),
    ]);

    expect(onBase!.position).toBe(9);
    expect(onHead!.position).toBe(9);
  });

  it('counts a no-newline marker mid-hunk as its own position, shifting the lines after it', () => {
    // The marker follows the deleted line it annotates: that line keeps
    // position 2, the marker takes the slot below it, and the additions
    // start at position 4 — one more than a marker-less patch would say.
    const [annotated, firstAfter, lastAfter] = positionComments(MARKER_MID_HUNK_DIFF, [
      lineComment('tail.txt', 'base', 2),
      lineComment('tail.txt', 'head', 2),
      lineComment('tail.txt', 'head', 3),
    ]);

    expect(annotated!.position).toBe(2);
    expect(firstAfter!.position).toBe(4);
    expect(lastAfter!.position).toBe(5);
  });

  it('maps a comment on a whole part to the file, with no position', () => {
    expect(positionComments(MULTI_HUNK_DIFF, [{ kind: 'part', path: 'two.txt', body: 'whole part' }])).toEqual([
      { path: 'two.txt', body: 'whole part', subjectType: 'file' },
    ]);
  });

  it('reports every unmappable comment at once, and maps nothing', () => {
    expect(() =>
      positionComments(MULTI_HUNK_DIFF, [
        lineComment('three.txt', 'head', 1),
        lineComment('one.txt', 'head', 99),
        lineComment('one.txt', 'base', 4), // The old side shows lines 1 to 3 only.
        { kind: 'part', path: 'three.txt', body: 'no such file' },
      ]),
    ).toThrow(
      'comments could not be mapped to the diff: ' +
        'comment 1: the diff touches no file at three.txt; ' +
        'comment 2: the diff shows no line 99 on the head side of one.txt; ' +
        'comment 3: the diff shows no line 4 on the base side of one.txt; ' +
        'comment 4: the diff touches no file at three.txt',
    );
  });

  describe('against the recorded pull request 42 diff', () => {
    const diff = readFileSync(
      fileURLToPath(new URL('./fixtures/pull-42.diff', import.meta.url)),
      'utf8',
    );

    it('maps comments on the renamed file by its new-side path, on both sides', () => {
      // src/config.ts became src/settings.ts; the deleted line is the
      // second body line, the added line the third.
      const [onBase, onHead] = positionComments(diff, [
        lineComment('src/settings.ts', 'base', 3),
        lineComment('src/settings.ts', 'head', 3),
      ]);

      expect(onBase).toEqual({ path: 'src/settings.ts', body: 'a comment', position: 2 });
      expect(onHead).toEqual({ path: 'src/settings.ts', body: 'a comment', position: 3 });
    });

    it('maps comments on an added and a deleted file', () => {
      const [added, deleted] = positionComments(diff, [
        lineComment('src/fresh.ts', 'head', 1),
        lineComment('src/legacy.ts', 'base', 2),
      ]);

      expect(added!.position).toBe(1);
      expect(deleted!.position).toBe(2);
    });

    it('maps a comment on the file whose last line lacks a final newline', () => {
      // notes.txt ends without a newline; the added "last line" is the
      // third body line, with the marker taking the slot after it.
      const [added] = positionComments(diff, [lineComment('notes.txt', 'head', 2)]);

      expect(added!.position).toBe(3);
    });

    it('refuses a line comment on a pure rename, which has no hunks', () => {
      expect(() =>
        positionComments(diff, [lineComment('src/util/format.ts', 'head', 1)]),
      ).toThrow('the diff shows no line 1 on the head side of src/util/format.ts');
    });
  });
});
