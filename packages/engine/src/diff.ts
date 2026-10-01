import type { DiffLine, Hunk, Part } from './protocol.js';

/** The result of parsing a whole pull request diff. */
export interface ParsedDiff {
  /** One entry per file the diff touches, in diff order. */
  files: Part[];
}

/** One file while it is still being parsed; becomes a {@link Part} at the end. */
interface CurrentFile {
  part: Part;
  /** Path from the `---` or `Binary files ... and` header, when present. */
  oldHeaderPath?: string;
  /** Path from the `+++` or `and ... differ` header, when present. */
  newHeaderPath?: string;
  /** True while skipping the base85 payload of a `GIT binary patch`. */
  inBinaryPatch: boolean;
}

const DIFF_GIT = /^diff --git a\/(.*?) b\/(.*)$/;
const OLD_MODE = /^old mode (\d+)$/;
const NEW_MODE = /^new mode (\d+)$/;
const DELETED_FILE_MODE = /^deleted file mode (\d+)$/;
const NEW_FILE_MODE = /^new file mode (\d+)$/;
const RENAME_FROM = /^rename from (.+)$/;
const RENAME_TO = /^rename to (.+)$/;
const BINARY_FILES = /^Binary files a\/(.*) and b\/(.*) differ$/;
const OLD_PATH = /^--- (a\/.+|\/dev\/null)$/;
const NEW_PATH = /^\+\+\+ (b\/.+|\/dev\/null)$/;
const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/;

/**
 * Parses a unified diff, as GitHub returns it for the diff media type, into
 * typed files and hunks.
 *
 * Handles renames (pure and with edits), additions, deletions, binary files
 * (`Binary files ... differ` and `GIT binary patch`), mode-only changes, and
 * files that end without a final newline. Large patches that the REST file
 * list truncates arrive intact from the diff endpoint and parse the same way.
 *
 * Paths are taken from the `rename to`/`rename from` headers when present,
 * otherwise from the `---`/`+++` headers, and only as a fallback from the
 * `diff --git` line, whose `a/... b/...` form is ambiguous for paths that
 * themselves contain ` b/`.
 */
export function parseDiff(diff: string): ParsedDiff {
  const files: Part[] = [];
  const lines = diff.split('\n');
  let current: CurrentFile | undefined;
  let hunk: Hunk | undefined;
  let oldLine = 0;
  let newLine = 0;
  // How many old-side and new-side lines the current hunk still expects;
  // a context line consumes one of each, a deletion one old, an addition one
  // new. They decide when a hunk's body is complete, so the empty string
  // left by the diff's final newline is skipped instead of becoming a
  // phantom context line.
  let oldRemaining = 0;
  let newRemaining = 0;
  let lastDiffLine: DiffLine | undefined;

  const startFile = (gitNewPath: string): CurrentFile => {
    if (current) {
      finishFile(current);
    }
    const file: CurrentFile = {
      part: {
        path: gitNewPath,
        changeKind: 'modification',
        isBinary: false,
        oldMissingFinalNewline: false,
        newMissingFinalNewline: false,
        hunks: [],
        additions: 0,
        deletions: 0,
      },
      inBinaryPatch: false,
    };
    files.push(file.part);
    hunk = undefined;
    lastDiffLine = undefined;
    return file;
  };

  const pushLine = (diffLine: DiffLine): void => {
    hunk?.lines.push(diffLine);
    lastDiffLine = diffLine;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;

    if (line === '' && hunk === undefined) {
      // A blank line between file sections, or the empty final line left
      // by the diff's trailing newline when the file has no hunks.
      continue;
    }

    let match = DIFF_GIT.exec(line);
    if (match) {
      current = startFile(match[2]!);
      continue;
    }

    if (!current) {
      throw new Error(
        `unexpected line before any 'diff --git' header at line ${i + 1}: ${line}`,
      );
    }

    const part = current.part;

    if (current.inBinaryPatch) {
      // Base85 payload of a GIT binary patch; everything until the next
      // `diff --git` belongs to the payload.
      continue;
    }

    if (line === 'GIT binary patch') {
      part.isBinary = true;
      current.inBinaryPatch = true;
      hunk = undefined;
      lastDiffLine = undefined;
      continue;
    }

    if (line.startsWith('\\')) {
      // "\ No newline at end of file" applies to the line before it, on the
      // side whose file lacks the final newline: deletions and context mark
      // the old side, additions and context the new side.
      if (lastDiffLine) {
        lastDiffLine.endsWithoutNewline = true;
        if (lastDiffLine.kind === 'deletion' || lastDiffLine.kind === 'context') {
          part.oldMissingFinalNewline = true;
        }
        if (lastDiffLine.kind === 'addition' || lastDiffLine.kind === 'context') {
          part.newMissingFinalNewline = true;
        }
      }
      continue;
    }

    match = OLD_MODE.exec(line);
    if (match) {
      part.oldMode = match[1];
      hunk = undefined;
      lastDiffLine = undefined;
      continue;
    }

    match = NEW_MODE.exec(line);
    if (match) {
      part.newMode = match[1];
      hunk = undefined;
      lastDiffLine = undefined;
      continue;
    }

    match = DELETED_FILE_MODE.exec(line);
    if (match) {
      part.oldMode = match[1];
      part.changeKind = 'deletion';
      hunk = undefined;
      lastDiffLine = undefined;
      continue;
    }

    match = NEW_FILE_MODE.exec(line);
    if (match) {
      part.newMode = match[1];
      part.changeKind = 'addition';
      hunk = undefined;
      lastDiffLine = undefined;
      continue;
    }

    if (/^(similarity|dissimilarity) index /.test(line) || line.startsWith('index ')) {
      // Carried in the diff but not needed by any part field yet.
      hunk = undefined;
      lastDiffLine = undefined;
      continue;
    }

    match = RENAME_FROM.exec(line);
    if (match) {
      part.previousPath = match[1]!;
      part.changeKind = 'rename';
      hunk = undefined;
      lastDiffLine = undefined;
      continue;
    }

    match = RENAME_TO.exec(line);
    if (match) {
      part.path = match[1]!;
      part.changeKind = 'rename';
      hunk = undefined;
      lastDiffLine = undefined;
      continue;
    }

    match = BINARY_FILES.exec(line);
    if (match) {
      part.isBinary = true;
      current.oldHeaderPath = match[1];
      current.newHeaderPath = match[2];
      hunk = undefined;
      lastDiffLine = undefined;
      continue;
    }

    match = OLD_PATH.exec(line);
    if (match) {
      current.oldHeaderPath = match[1] === '/dev/null' ? undefined : match[1]!.slice(2);
      hunk = undefined;
      lastDiffLine = undefined;
      continue;
    }

    match = NEW_PATH.exec(line);
    if (match) {
      current.newHeaderPath = match[1] === '/dev/null' ? undefined : match[1]!.slice(2);
      hunk = undefined;
      lastDiffLine = undefined;
      continue;
    }

    match = HUNK_HEADER.exec(line);
    if (match) {
      hunk = {
        oldStart: Number(match[1]),
        oldLines: match[2] === undefined ? 1 : Number(match[2]),
        newStart: Number(match[3]),
        newLines: match[4] === undefined ? 1 : Number(match[4]),
        heading: match[5] === '' ? undefined : match[5],
        lines: [],
      };
      part.hunks.push(hunk);
      oldLine = hunk.oldStart;
      newLine = hunk.newStart;
      oldRemaining = hunk.oldLines;
      newRemaining = hunk.newLines;
      lastDiffLine = undefined;
      continue;
    }

    if (hunk && (oldRemaining > 0 || newRemaining > 0)) {
      const prefix = line[0]!;
      const text = line.slice(1);
      if (prefix === '-' && oldRemaining > 0) {
        pushLine({ kind: 'deletion', oldLineNumber: oldLine, text });
        oldLine++;
        oldRemaining--;
        part.deletions++;
      } else if (prefix === '+' && newRemaining > 0) {
        pushLine({ kind: 'addition', newLineNumber: newLine, text });
        newLine++;
        newRemaining--;
        part.additions++;
      } else {
        // A context line, written as ' ' plus content; tolerate a fully
        // empty line as context with empty content.
        const contextText = prefix === ' ' ? text : line;
        pushLine({
          kind: 'context',
          oldLineNumber: oldLine,
          newLineNumber: newLine,
          text: contextText,
        });
        oldLine++;
        newLine++;
        oldRemaining--;
        newRemaining--;
      }
      continue;
    }

    if (hunk) {
      // The hunk's counts are exhausted: anything left here is a separator
      // between sections, such as the empty final line of the diff.
      continue;
    }

    throw new Error(`unexpected line outside any hunk at line ${i + 1}: ${line}`);
  }

  if (current) {
    finishFile(current);
  }
  return { files };
}

/** Applies the header paths to a finished file, in precedence order. */
function finishFile(current: CurrentFile): void {
  const { part } = current;
  if (current.newHeaderPath !== undefined) {
    part.path = current.newHeaderPath;
  } else if (part.changeKind === 'deletion' && current.oldHeaderPath !== undefined) {
    part.path = current.oldHeaderPath;
  }
}
