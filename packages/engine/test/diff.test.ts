import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseDiff } from '../src/diff.js';

function fixture(name: string): string {
  return readFileSync(
    fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)),
    'utf8',
  );
}

describe('parseDiff', () => {
  it('parses a pure rename with no edits', () => {
    const { files } = parseDiff(fixture('rename-pure.diff'));
    expect(files).toHaveLength(1);
    const file = files[0]!;
    expect(file.changeKind).toBe('rename');
    expect(file.path).toBe('new-name.ts');
    expect(file.previousPath).toBe('old-name.ts');
    expect(file.hunks).toHaveLength(0);
    expect(file.additions).toBe(0);
    expect(file.deletions).toBe(0);
    expect(file.isBinary).toBe(false);
  });

  it('parses a rename with edits, numbering lines on both paths', () => {
    const { files } = parseDiff(fixture('rename-with-edit.diff'));
    const file = files[0]!;
    expect(file.changeKind).toBe('rename');
    expect(file.path).toBe('src/settings.ts');
    expect(file.previousPath).toBe('src/config.ts');
    expect(file.hunks).toHaveLength(1);
    expect(file.additions).toBe(1);
    expect(file.deletions).toBe(1);
    const lines = file.hunks[0]!.lines;
    expect(lines.map((line) => line.kind)).toEqual([
      'context',
      'deletion',
      'addition',
      'context',
    ]);
    expect(lines[1]!.oldLineNumber).toBe(3);
    expect(lines[1]!.newLineNumber).toBeUndefined();
    expect(lines[2]!.oldLineNumber).toBeUndefined();
    expect(lines[2]!.newLineNumber).toBe(3);
  });

  it('parses a deleted file', () => {
    const { files } = parseDiff(fixture('deletion.diff'));
    const file = files[0]!;
    expect(file.changeKind).toBe('deletion');
    expect(file.path).toBe('src/legacy.ts');
    expect(file.previousPath).toBeUndefined();
    expect(file.oldMode).toBe('100644');
    expect(file.deletions).toBe(3);
    expect(file.additions).toBe(0);
    expect(file.hunks[0]!.lines.every((line) => line.kind === 'deletion')).toBe(true);
    expect(file.hunks[0]!.lines.map((line) => line.oldLineNumber)).toEqual([1, 2, 3]);
  });

  it('parses a new file', () => {
    const { files } = parseDiff(fixture('new-file.diff'));
    const file = files[0]!;
    expect(file.changeKind).toBe('addition');
    expect(file.path).toBe('src/fresh.ts');
    expect(file.newMode).toBe('100644');
    expect(file.additions).toBe(2);
    expect(file.hunks[0]!.newStart).toBe(1);
    expect(file.hunks[0]!.lines[1]!.newLineNumber).toBe(2);
  });

  it('parses a mode-only change with no hunks', () => {
    const { files } = parseDiff(fixture('mode-change.diff'));
    const file = files[0]!;
    expect(file.changeKind).toBe('modification');
    expect(file.path).toBe('scripts/run.sh');
    expect(file.oldMode).toBe('100644');
    expect(file.newMode).toBe('100755');
    expect(file.hunks).toHaveLength(0);
    expect(file.additions + file.deletions).toBe(0);
  });

  it('parses a binary file marked with "Binary files ... differ"', () => {
    const { files } = parseDiff(fixture('binary.diff'));
    const file = files[0]!;
    expect(file.isBinary).toBe(true);
    expect(file.path).toBe('assets/logo.png');
    expect(file.hunks).toHaveLength(0);
    expect(file.additions + file.deletions).toBe(0);
  });

  it('parses an added binary file whose old side is /dev/null', () => {
    const { files } = parseDiff(fixture('binary-added.diff'));
    const file = files[0]!;
    expect(file.isBinary).toBe(true);
    expect(file.changeKind).toBe('addition');
    expect(file.path).toBe('assets/shot.png');
    expect(file.hunks).toHaveLength(0);
    expect(file.additions + file.deletions).toBe(0);
  });

  it('parses a deleted binary file whose new side is /dev/null', () => {
    const { files } = parseDiff(fixture('binary-deleted.diff'));
    const file = files[0]!;
    expect(file.isBinary).toBe(true);
    expect(file.changeKind).toBe('deletion');
    expect(file.path).toBe('assets/old-logo.png');
    expect(file.hunks).toHaveLength(0);
    expect(file.additions + file.deletions).toBe(0);
  });

  it('decodes C-quoted paths in diff --git, ---/+++ and rename headers', () => {
    const { files } = parseDiff(fixture('quoted-path.diff'));
    expect(files.map((file) => file.path)).toEqual(['\u00fcber.md', 'docs/neu \u2605.md']);
    const edited = files[0]!;
    expect(edited.changeKind).toBe('modification');
    expect(edited.additions).toBe(1);
    expect(edited.deletions).toBe(1);
    expect(edited.hunks[0]!.lines.map((line) => line.text)).toEqual(['alt', 'neu']);
    const renamed = files[1]!;
    expect(renamed.changeKind).toBe('rename');
    expect(renamed.previousPath).toBe('docs/alt.md');
    expect(renamed.hunks).toHaveLength(0);
  });

  it('parses a copied file like a rename, with a copy change kind', () => {
    const { files } = parseDiff(fixture('copy.diff'));
    const file = files[0]!;
    expect(file.changeKind).toBe('copy');
    expect(file.path).toBe('lib/greet-copy.js');
    expect(file.previousPath).toBe('lib/greet.js');
    expect(file.additions).toBe(1);
    expect(file.deletions).toBe(1);
    expect(file.hunks[0]!.lines[1]!.oldLineNumber).toBe(2);
    expect(file.hunks[0]!.lines[2]!.newLineNumber).toBe(2);
  });

  it('parses a binary file carried as a GIT binary patch', () => {
    const { files } = parseDiff(fixture('git-binary-patch.diff'));
    const file = files[0]!;
    expect(file.isBinary).toBe(true);
    expect(file.path).toBe('assets/font.ttf');
    expect(file.hunks).toHaveLength(0);
  });

  it('marks the old side when only it lacks the final newline', () => {
    const { files } = parseDiff(fixture('no-final-newline.diff'));
    const oldSide = files[0]!;
    expect(oldSide.path).toBe('notes-old.txt');
    expect(oldSide.oldMissingFinalNewline).toBe(true);
    expect(oldSide.newMissingFinalNewline).toBe(false);
    const markerLine = oldSide.hunks[0]!.lines[1]!;
    expect(markerLine.kind).toBe('deletion');
    expect(markerLine.endsWithoutNewline).toBe(true);
  });

  it('marks the new side when only it lacks the final newline', () => {
    const { files } = parseDiff(fixture('no-final-newline.diff'));
    const newSide = files[1]!;
    expect(newSide.path).toBe('notes-new.txt');
    expect(newSide.oldMissingFinalNewline).toBe(false);
    expect(newSide.newMissingFinalNewline).toBe(true);
    const markerLine = newSide.hunks[0]!.lines[2]!;
    expect(markerLine.kind).toBe('addition');
    expect(markerLine.endsWithoutNewline).toBe(true);
  });

  it('parses a large lockfile-sized patch without losing lines', () => {
    const { files } = parseDiff(fixture('large-lock.diff'));
    expect(files).toHaveLength(1);
    const file = files[0]!;
    expect(file.path).toBe('package-lock.json');
    expect(file.additions).toBe(2500);
    expect(file.deletions).toBe(3);
    const lines = file.hunks[0]!.lines;
    expect(lines).toHaveLength(2510);
    const additions = lines.filter((line) => line.kind === 'addition');
    expect(additions).toHaveLength(2500);
    // Every addition carries a new-side number, none an old-side number.
    expect(additions.every((line) => line.newLineNumber !== undefined)).toBe(true);
    expect(additions.every((line) => line.oldLineNumber === undefined)).toBe(true);
    // Numbers are dense from the hunk start.
    const numbers = additions.map((line) => line.newLineNumber!);
    expect(numbers[0]).toBe(4391);
    expect(numbers[numbers.length - 1]).toBe(6890);
  });

  it('parses a combined pull request diff in file order', () => {
    const { files } = parseDiff(fixture('pull-42.diff'));
    expect(files.map((file) => file.path)).toEqual([
      'README.md',
      'src/settings.ts',
      'src/legacy.ts',
      'src/fresh.ts',
      'assets/logo.png',
      'notes.txt',
      'scripts/run.sh',
      'package-lock.json',
    ]);
    expect(files[0]!.hunks[0]!.heading).toBe('Dependencies');
    expect(files[1]!.changeKind).toBe('rename');
    expect(files[2]!.changeKind).toBe('deletion');
    expect(files[3]!.changeKind).toBe('addition');
    expect(files[4]!.isBinary).toBe(true);
    expect(files[5]!.newMissingFinalNewline).toBe(true);
    expect(files[6]!.newMode).toBe('100755');
    expect(files[7]!.additions).toBe(48);
  });

  it('rejects input that is not a diff', () => {
    expect(() => parseDiff('this is not a diff\n')).toThrow(/diff --git/);
  });
});
