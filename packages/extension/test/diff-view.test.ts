import { describe, expect, it } from 'vitest';
import { changeTriples, partMarking } from '../src/diff-view.js';
import { changeUri, emptyChangeUri, partFiles } from '../src/change-copies.js';
import { mixedResult, part } from './results.js';

describe('partMarking', () => {
  it('marks each stretch of added lines on the head side and deleted lines on the base side', () => {
    const marking = partMarking(mixedResult().parts[0]!);

    expect(marking.additions).toEqual([{ startLine: 4, endLine: 10 }]);
    expect(marking.deletions).toEqual([{ startLine: 4, endLine: 5 }]);
  });

  it('scrolls to the first hunk, on the head side when it has lines there', () => {
    expect(partMarking(mixedResult().parts[0]!).reveal).toEqual({
      side: 'head',
      run: { startLine: 2, endLine: 12 },
    });
  });

  it('scrolls a hunk with no head lines to the base side', () => {
    const marking = partMarking(
      part('src/gone.ts', {
        changeKind: 'deletion',
        hunks: [
          {
            oldStart: 10,
            oldLines: 3,
            newStart: 0,
            newLines: 0,
            entities: [],
            lines: [
              { kind: 'deletion', oldLineNumber: 10, text: 'a' },
              { kind: 'deletion', oldLineNumber: 11, text: 'b' },
              { kind: 'deletion', oldLineNumber: 12, text: 'c' },
            ],
          },
        ],
      }),
    );

    expect(marking.reveal).toEqual({ side: 'base', run: { startLine: 9, endLine: 11 } });
    expect(marking.additions).toEqual([]);
    expect(marking.deletions).toEqual([{ startLine: 9, endLine: 11 }]);
  });

  it('marks nothing for a binary file or a pure rename, which have no hunks', () => {
    expect(partMarking(part('logo.png', { isBinary: true }))).toEqual({
      reveal: undefined,
      additions: [],
      deletions: [],
    });
    expect(partMarking(mixedResult().parts[6]!)).toEqual({
      reveal: undefined,
      additions: [],
      deletions: [],
    });
  });

  it('splits runs where the changed lines are not consecutive', () => {
    const marking = partMarking(
      part('src/spaced.ts', {
        hunks: [
          {
            oldStart: 1,
            oldLines: 5,
            newStart: 1,
            newLines: 5,
            entities: [],
            lines: [
              { kind: 'addition', newLineNumber: 2, text: 'x' },
              { kind: 'context', oldLineNumber: 1, newLineNumber: 3, text: ' ' },
              { kind: 'addition', newLineNumber: 4, text: 'y' },
              { kind: 'addition', newLineNumber: 5, text: 'z' },
            ],
          },
        ],
      }),
    );

    expect(marking.additions).toEqual([
      { startLine: 1, endLine: 1 },
      { startLine: 3, endLine: 4 },
    ]);
  });
});

describe('changeTriples', () => {
  it('hands the editor each file as label, base and head', () => {
    const copies = mixedResult().copies;
    const files = partFiles(copies, part('src/retry.py'));

    expect(changeTriples(files)).toEqual([
      [
        changeUri('head', copies.head.commit, 'src/retry.py'),
        changeUri('base', copies.base.commit, 'src/retry.py'),
        changeUri('head', copies.head.commit, 'src/retry.py'),
      ],
    ]);
  });

  it('labels an addition with its head side', () => {
    const copies = mixedResult().copies;
    const files = partFiles(copies, part('src/new.ts', { changeKind: 'addition' }));

    expect(changeTriples(files)[0]![1]).toEqual(emptyChangeUri('src/new.ts'));
  });
});
