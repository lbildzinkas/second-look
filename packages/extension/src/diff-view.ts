import * as vscode from 'vscode';
import { filesOfPart, type FileSlice, type Part, type ReviewResult } from '@second-look/engine';
import { partFiles, type PartFile } from './change-copies.js';
import { partsInReadingOrder } from './tree.js';

/** The editor's own command that opens the multi-file diff editor. */
export const OPEN_CHANGES_COMMAND = 'vscode.changes' as const;

/** A run of lines, 0-based and inclusive at both ends. */
export interface LineRun {
  startLine: number;
  endLine: number;
}

/** Where a part's changed lines sit, so the editor can scroll and mark them. */
export interface PartMarking {
  /** The part's first hunk, on the side that carries its lines. */
  reveal?: { side: 'base' | 'head'; run: LineRun };
  /** The added lines, to mark on the head side. */
  additions: LineRun[];
  /** The deleted lines, to mark on the base side. */
  deletions: LineRun[];
}

/**
 * Works out where one file's share of a part sits from its hunks: one run
 * per stretch of added lines on the head side and of deleted lines on the
 * base side, and the first hunk as the place to scroll to — on the head
 * side when the hunk has lines there, else on the base side. Binary files
 * and pure renames have no hunks, so they mark nothing and scroll nowhere.
 */
export function partMarking(part: FileSlice): PartMarking {
  const additions: LineRun[] = [];
  const deletions: LineRun[] = [];
  for (const hunk of part.hunks) {
    extendRun(additions, hunk.lines.filter((line) => line.kind === 'addition'), (line) => line.newLineNumber);
    extendRun(deletions, hunk.lines.filter((line) => line.kind === 'deletion'), (line) => line.oldLineNumber);
  }
  const first = part.hunks[0];
  const reveal =
    first === undefined
      ? undefined
      : first.newLines > 0
        ? { side: 'head' as const, run: run(first.newStart, first.newLines) }
        : { side: 'base' as const, run: run(first.oldStart, first.oldLines) };
  return { reveal, additions, deletions };
}

/** Adds one run per stretch of consecutive numbered lines. */
function extendRun(
  runs: LineRun[],
  lines: ReadonlyArray<{ newLineNumber?: number; oldLineNumber?: number }>,
  lineOf: (line: { newLineNumber?: number; oldLineNumber?: number }) => number | undefined,
): void {
  let current: LineRun | undefined;
  for (const line of lines) {
    const number = lineOf(line);
    if (number === undefined) continue;
    const zeroBased = number - 1;
    if (current !== undefined && zeroBased === current.endLine + 1) {
      current.endLine = zeroBased;
      continue;
    }
    current = { startLine: zeroBased, endLine: zeroBased };
    runs.push(current);
  }
}

/** The 0-based run of a 1-based hunk span. */
function run(start: number, lines: number): LineRun {
  return { startLine: start - 1, endLine: start + lines - 2 };
}

function range(run: LineRun): vscode.Range {
  return new vscode.Range(run.startLine, 0, run.endLine, Number.MAX_SAFE_INTEGER);
}

/** Collects the runs one side of a file must mark, across its parts. */
function addPending(pending: Map<string, vscode.Range[]>, uri: vscode.Uri, runs: LineRun[]): void {
  const key = uri.toString();
  pending.set(key, [...(pending.get(key) ?? []), ...runs.map(range)]);
}

/** One entry of the diff editor's change list: label, original, modified. */
export type ChangeTriple = [label: vscode.Uri, original: vscode.Uri, modified: vscode.Uri];

/** The files as the editor's changes command wants them: label, base, head. */
export function changeTriples(files: readonly PartFile[]): ChangeTriple[] {
  return files.map((file) => [file.modified, file.original, file.modified]);
}

/**
 * Opens one part in the editor's multi-file diff: exactly its files, base
 * on the left and head on the right, served read-only from the engine's
 * cache, with its lines marked and the editor scrolled to its first hunk.
 */
export async function openPartInDiffEditor(
  part: Part,
  result: ReviewResult,
  marker: PartMarker,
): Promise<void> {
  const files = partFiles(result.copies, part);
  marker.mark(markedFiles(part, files));
  const title = part.name ?? part.path;
  await vscode.commands.executeCommand(OPEN_CHANGES_COMMAND, title, changeTriples(files));
}

/** Each of a part's files with its share of the part, to mark in the diff editor. */
function markedFiles(part: Part, files: readonly PartFile[]): { part: FileSlice; file: PartFile }[] {
  return filesOfPart(part).map((slice, index) => ({ part: slice, file: files[index]! }));
}

/**
 * Opens the whole change in one multi-file diff, in the side bar's reading
 * order: the importance groups in order, the parts the engine has
 * not ranked yet, and the noise last. Every part's lines are marked as its
 * files become visible, and the first part scrolls to its first hunk.
 */
export async function openWholeChangeInDiffEditor(
  result: ReviewResult,
  marker: PartMarker,
): Promise<void> {
  const parts = partsInReadingOrder(result);
  const files = parts.map((part) => partFiles(result.copies, part));
  marker.mark(parts.flatMap((part, index) => markedFiles(part, files[index]!)));
  const title = `${result.pullRequest.title} (#${result.pullRequest.number})`;
  await vscode.commands.executeCommand(OPEN_CHANGES_COMMAND, title, changeTriples(files.flat()));
}

/**
 * Marks each part's changed lines and scrolls to the first part's first
 * hunk, wherever the diff editor shows them. The multi-file diff opens its
 * files as the reviewer moves through them, so the marks wait for each
 * side to become visible and then settle on it: additions on the head
 * side, deletions on the base side.
 */
export class PartMarker {
  private readonly markedLines = vscode.window.createTextEditorDecorationType({
    backgroundColor: { id: 'editor.wordHighlightBackground' },
    overviewRulerColor: { id: 'editorOverviewRuler.wordHighlightForeground' },
  });

  private readonly editorsChanged: vscode.Disposable;

  private pending = new Map<string, vscode.Range[]>();

  private reveal: { uri: vscode.Uri; range: vscode.Range } | undefined;

  constructor() {
    this.editorsChanged = vscode.window.onDidChangeVisibleTextEditors((editors) =>
      this.applyTo(editors),
    );
  }

  /** Marks these files' shares of their parts; an earlier request's marks are replaced. */
  mark(entries: ReadonlyArray<{ part: FileSlice; file: PartFile }>): void {
    for (const editor of vscode.window.visibleTextEditors) {
      editor.setDecorations(this.markedLines, []);
    }
    const pending = new Map<string, vscode.Range[]>();
    let reveal: { uri: vscode.Uri; range: vscode.Range } | undefined;
    for (const { part, file } of entries) {
      const marking = partMarking(part);
      if (marking.additions.length > 0) {
        addPending(pending, file.modified, marking.additions);
      }
      if (marking.deletions.length > 0) {
        addPending(pending, file.original, marking.deletions);
      }
      if (reveal === undefined && marking.reveal !== undefined) {
        reveal = {
          uri: marking.reveal.side === 'head' ? file.modified : file.original,
          range: range(marking.reveal.run),
        };
      }
    }
    this.pending = pending;
    this.reveal = reveal;
    this.applyTo(vscode.window.visibleTextEditors);
  }

  dispose(): void {
    this.editorsChanged.dispose();
    this.markedLines.dispose();
  }

  private applyTo(editors: readonly vscode.TextEditor[]): void {
    for (const editor of editors) {
      const key = editor.document.uri.toString();
      const ranges = this.pending.get(key);
      if (ranges !== undefined) {
        editor.setDecorations(this.markedLines, ranges);
        this.pending.delete(key);
      }
      if (this.reveal !== undefined && key === this.reveal.uri.toString()) {
        editor.revealRange(this.reveal.range, vscode.TextEditorRevealType.InCenter);
        this.reveal = undefined;
      }
    }
  }
}
