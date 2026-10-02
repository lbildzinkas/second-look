import { describe, expect, it } from 'vitest';
import type { Hunk } from '@second-look/engine';
import {
  changeTriples,
  OPEN_CHANGES_COMMAND,
  openWholeChangeInDiffEditor,
  partMarking,
  PartMarker,
} from '../src/diff-view.js';
import { changeUri, emptyChangeUri, partFiles } from '../src/change-copies.js';
import { stub } from './vscode-stub.js';
import { mixedResult, part, result } from './results.js';

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

/** A hunk whose changed lines are all one kind, on that side only. */
function hunkOf(kind: 'addition' | 'deletion', start: number, count: number): Hunk {
  return {
    oldStart: start,
    oldLines: kind === 'deletion' ? count : 0,
    newStart: start,
    newLines: kind === 'addition' ? count : 0,
    entities: [],
    lines: Array.from({ length: count }, (_, index) =>
      kind === 'addition'
        ? { kind, newLineNumber: start + index, text: 'added' }
        : { kind, oldLineNumber: start + index, text: 'gone' },
    ),
  };
}

/** A range as the editor double records it: only its 0-based line span. */
interface MarkedRange {
  start: { line: number };
  end: { line: number };
}

/** An editor double that records the decorations and reveals it receives. */
function editorOn(uri: unknown) {
  const marked: MarkedRange[] = [];
  const revealed: MarkedRange[] = [];
  const spanOf = (range: { start: { line: number }; end: { line: number } }): MarkedRange => ({
    start: { line: range.start.line },
    end: { line: range.end.line },
  });
  return {
    document: { uri },
    marked,
    revealed,
    setDecorations(_type: unknown, ranges: { start: { line: number }; end: { line: number } }[]): void {
      marked.push(...ranges.map(spanOf));
    },
    revealRange(range: { start: { line: number }; end: { line: number } }): void {
      revealed.push(spanOf(range));
    },
  };
}

describe('PartMarker', () => {
  it('marks every part of one file when the whole change opens, and scrolls to the first', async () => {
    const send = part('src/retry.py', { hunks: [hunkOf('addition', 5, 3)], additions: 3 });
    const sign = part('src/retry.py', { hunks: [hunkOf('addition', 20, 2)], additions: 2 });
    const review = result([send, sign]);
    const marker = new PartMarker();
    const editor = editorOn(partFiles(review.copies, send)[0]!.modified);
    try {
      await openWholeChangeInDiffEditor(review, marker);
      stub.fireVisibleTextEditors([editor]);
    } finally {
      marker.dispose();
    }

    expect(editor.marked).toEqual([
      { start: { line: 4 }, end: { line: 6 } },
      { start: { line: 19 }, end: { line: 20 } },
    ]);
    expect(editor.revealed).toEqual([{ start: { line: 4 }, end: { line: 6 } }]);
    expect(stub.executedCommands.map((command) => command.id)).toEqual([OPEN_CHANGES_COMMAND]);
  });

  it('marks the base side of every deleting part of one file', async () => {
    const first = part('src/old.ts', { hunks: [hunkOf('deletion', 8, 2)], deletions: 2 });
    const second = part('src/old.ts', { hunks: [hunkOf('deletion', 30, 4)], deletions: 4 });
    const review = result([first, second]);
    const marker = new PartMarker();
    const editor = editorOn(partFiles(review.copies, first)[0]!.original);
    try {
      await openWholeChangeInDiffEditor(review, marker);
      stub.fireVisibleTextEditors([editor]);
    } finally {
      marker.dispose();
    }

    expect(editor.marked).toEqual([
      { start: { line: 7 }, end: { line: 8 } },
      { start: { line: 29 }, end: { line: 32 } },
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
