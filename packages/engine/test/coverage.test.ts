import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { validateCoverage } from '../src/coverage.js';
import { parseDiff } from '../src/diff.js';

function fixture(name: string): string {
  return readFileSync(
    fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)),
    'utf8',
  );
}

describe('validateCoverage', () => {
  it('proves full coverage for every recorded fixture', () => {
    for (const name of [
      'rename-pure.diff',
      'rename-with-edit.diff',
      'deletion.diff',
      'new-file.diff',
      'mode-change.diff',
      'binary.diff',
      'git-binary-patch.diff',
      'no-final-newline.diff',
      'large-lock.diff',
      'pull-42.diff',
    ]) {
      const parsed = parseDiff(fixture(name));
      const report = validateCoverage(parsed, parsed.files);
      expect(report.problems, name).toEqual([]);
      expect(report.ok, name).toBe(true);
    }
  });

  it('reports a changed line that belongs to no part', () => {
    const parsed = parseDiff(fixture('deletion.diff'));
    const report = validateCoverage(parsed, []);
    expect(report.ok).toBe(false);
    expect(report.problems.some((p) => /belongs to no part/.test(p.description))).toBe(
      true,
    );
    expect(report.problems.some((p) => p.file === 'src/legacy.ts')).toBe(true);
  });

  it('reports a changed line that belongs to more than one part', () => {
    const parsed = parseDiff(fixture('deletion.diff'));
    const doubled = [...parsed.files, parsed.files[0]!];
    const report = validateCoverage(parsed, doubled);
    expect(report.ok).toBe(false);
    expect(
      report.problems.some((p) => /belongs to more than one part/.test(p.description)),
    ).toBe(true);
  });

  it('reports a part claiming a line the diff does not contain', () => {
    const parsed = parseDiff(fixture('deletion.diff'));
    const inflated = structuredClone(parsed.files);
    const hunk = inflated[0]!.hunks[0]!;
    hunk.lines.push({
      kind: 'deletion',
      oldLineNumber: 99,
      text: 'a line the diff never had',
    });
    const report = validateCoverage(parsed, inflated);
    expect(report.ok).toBe(false);
    expect(
      report.problems.some((p) => /does not contain/.test(p.description)),
    ).toBe(true);
  });

  it('reports a part that matches no file in the diff', () => {
    const parsed = parseDiff(fixture('deletion.diff'));
    const extra = structuredClone(parsed.files);
    extra.push({
      path: 'made-up.ts',
      changeKind: 'modification',
      isBinary: false,
      oldMissingFinalNewline: false,
      newMissingFinalNewline: false,
      hunks: [],
      additions: 0,
      deletions: 0,
    });
    const report = validateCoverage(parsed, extra);
    expect(report.ok).toBe(false);
    expect(
      report.problems.some((p) => /matches no file/.test(p.description)),
    ).toBe(true);
  });

  it('numbers rename deletions under the previous path and additions under the new one', () => {
    const parsed = parseDiff(fixture('rename-with-edit.diff'));
    // Dropping the part leaves one problem per side, under two different paths.
    const report = validateCoverage(parsed, []);
    const files = new Set(report.problems.map((p) => p.file));
    expect(files).toEqual(new Set(['src/config.ts', 'src/settings.ts']));
  });
});
