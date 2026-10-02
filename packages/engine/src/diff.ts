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

const DIFF_GIT = /^diff --git (.*)$/;
const OLD_MODE = /^old mode (\d+)$/;
const NEW_MODE = /^new mode (\d+)$/;
const DELETED_FILE_MODE = /^deleted file mode (\d+)$/;
const NEW_FILE_MODE = /^new file mode (\d+)$/;
const RENAME_FROM = /^rename from (.+)$/;
const RENAME_TO = /^rename to (.+)$/;
const COPY_FROM = /^copy from (.+)$/;
const COPY_TO = /^copy to (.+)$/;
const BINARY_FILES =
  /^Binary files (a\/.+|\/dev\/null|"a\/(?:[^"\\]|\\.)*") and (b\/.+|\/dev\/null|"b\/(?:[^"\\]|\\.)*") differ$/;
const OLD_PATH = /^--- (a\/.+|\/dev\/null|"a\/(?:[^"\\]|\\.)*")$/;
const NEW_PATH = /^\+\+\+ (b\/.+|\/dev\/null|"b\/(?:[^"\\]|\\.)*")$/;
const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/;

/** Bytes for the escapes git writes inside a C-quoted path. */
const ESCAPED_BYTES: Readonly<Record<string, number>> = {
  '"': 0x22,
  '\\': 0x5c,
  a: 0x07,
  b: 0x08,
  f: 0x0c,
  n: 0x0a,
  r: 0x0d,
  t: 0x09,
  v: 0x0b,
};

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder();

/**
 * Decodes one path token of a diff header. Unquoted tokens pass through;
 * quoted tokens unwrap git's C quoting (core.quotePath), whose octal
 * escapes reassemble the path's UTF-8 bytes. Undefined for a malformed
 * quoted token. Also used for the pattern token of a `.gitattributes`
 * line, which uses the same quoting.
 */
export function decodePathToken(token: string): string | undefined {
  if (!token.startsWith('"')) {
    return token;
  }
  if (token.length < 2 || !token.endsWith('"')) {
    return undefined;
  }
  const bytes: number[] = [];
  for (let i = 1; i < token.length - 1; i++) {
    const ch = token[i]!;
    if (ch !== '\\') {
      bytes.push(...utf8Encoder.encode(ch));
      continue;
    }
    const escaped = token[i + 1];
    if (escaped === undefined) {
      return undefined;
    }
    const byte = ESCAPED_BYTES[escaped];
    if (byte !== undefined) {
      bytes.push(byte);
      i++;
      continue;
    }
    if (escaped < '0' || escaped > '7') {
      return undefined;
    }
    let value = 0;
    let digits = 0;
    while (digits < 3) {
      const digit = token[i + 1 + digits];
      if (digit === undefined || digit < '0' || digit > '7') {
        break;
      }
      value = value * 8 + Number(digit);
      digits++;
    }
    bytes.push(value);
    i += digits;
  }
  return utf8Decoder.decode(Uint8Array.from(bytes));
}

/** A token's bare path when it decodes with the given prefix, else undefined. */
function barePath(token: string, prefix: 'a/' | 'b/'): string | undefined {
  const decoded = decodePathToken(token);
  if (decoded === undefined || !decoded.startsWith(prefix)) {
    return undefined;
  }
  return decoded.slice(prefix.length);
}

/**
 * Reads one side of a two-sided header (`---`, `+++`, `Binary files … and
 * …`): `/dev/null` means the side is absent, any other token yields its
 * bare path. Null when the token is not a decodable `a/…`/`b/…` path.
 */
function sideHeaderPath(token: string, prefix: 'a/' | 'b/'): string | undefined | null {
  if (token === '/dev/null') {
    return undefined;
  }
  const path = barePath(token, prefix);
  return path === undefined ? null : path;
}

/**
 * Splits the two path tokens of a `diff --git` line. Quoted tokens wrap
 * their own `a/` or `b/` prefix; a bare pair splits at the first ` b/`,
 * which stays ambiguous for paths that themselves contain ` b/`, so the
 * header paths keep precedence.
 */
function splitDiffGitPaths(rest: string): { oldToken: string; newToken: string } | undefined {
  if (rest.startsWith('"')) {
    let end = -1;
    for (let i = 1; i < rest.length; i++) {
      const ch = rest[i]!;
      if (ch === '\\') {
        i++;
      } else if (ch === '"') {
        end = i;
        break;
      }
    }
    if (end === -1 || rest[end + 1] !== ' ') {
      return undefined;
    }
    return { oldToken: rest.slice(0, end + 1), newToken: rest.slice(end + 2) };
  }
  const quotedAt = rest.indexOf(' "');
  const splitAt = quotedAt !== -1 ? quotedAt : rest.indexOf(' b/');
  if (splitAt === -1) {
    return undefined;
  }
  return { oldToken: rest.slice(0, splitAt), newToken: rest.slice(splitAt + 1) };
}

/**
 * Parses a unified diff, as GitHub returns it for the diff media type, into
 * typed files and hunks.
 *
 * Handles renames and copies (pure and with edits), additions, deletions,
 * binary files (`Binary files ... differ` with either side absent and
 * `GIT binary patch`), mode-only changes, and files that end without a
 * final newline. Large patches that the REST file list truncates arrive
 * intact from the diff endpoint and parse the same way. Paths that git
 * C-quotes (core.quotePath) are decoded in every header they appear in.
 *
 * Paths are taken from the `rename to`/`rename from` (or `copy to`/`copy
 * from`) headers when present, otherwise from the `---`/`+++` headers or
 * the sides of the `Binary files` line, and only as a fallback from the
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
      const tokens = splitDiffGitPaths(match[1]!);
      const newPath = tokens === undefined ? undefined : barePath(tokens.newToken, 'b/');
      if (tokens !== undefined && newPath !== undefined &&
          barePath(tokens.oldToken, 'a/') !== undefined) {
        current = startFile(newPath);
        continue;
      }
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
      const path = decodePathToken(match[1]!);
      if (path !== undefined) {
        part.previousPath = path;
        part.changeKind = 'rename';
        hunk = undefined;
        lastDiffLine = undefined;
        continue;
      }
    }

    match = RENAME_TO.exec(line);
    if (match) {
      const path = decodePathToken(match[1]!);
      if (path !== undefined) {
        part.path = path;
        part.changeKind = 'rename';
        hunk = undefined;
        lastDiffLine = undefined;
        continue;
      }
    }

    match = COPY_FROM.exec(line);
    if (match) {
      const path = decodePathToken(match[1]!);
      if (path !== undefined) {
        part.previousPath = path;
        part.changeKind = 'copy';
        hunk = undefined;
        lastDiffLine = undefined;
        continue;
      }
    }

    match = COPY_TO.exec(line);
    if (match) {
      const path = decodePathToken(match[1]!);
      if (path !== undefined) {
        part.path = path;
        part.changeKind = 'copy';
        hunk = undefined;
        lastDiffLine = undefined;
        continue;
      }
    }

    match = BINARY_FILES.exec(line);
    if (match) {
      const oldPath = sideHeaderPath(match[1]!, 'a/');
      const newPath = sideHeaderPath(match[2]!, 'b/');
      if (oldPath !== null && newPath !== null) {
        part.isBinary = true;
        current.oldHeaderPath = oldPath;
        current.newHeaderPath = newPath;
        if (oldPath === undefined) {
          part.changeKind = 'addition';
        } else if (newPath === undefined) {
          part.changeKind = 'deletion';
        }
        hunk = undefined;
        lastDiffLine = undefined;
        continue;
      }
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

    match = OLD_PATH.exec(line);
    if (match) {
      const path = sideHeaderPath(match[1]!, 'a/');
      if (path !== null) {
        current.oldHeaderPath = path;
        hunk = undefined;
        lastDiffLine = undefined;
        continue;
      }
    }

    match = NEW_PATH.exec(line);
    if (match) {
      const path = sideHeaderPath(match[1]!, 'b/');
      if (path !== null) {
        current.newHeaderPath = path;
        hunk = undefined;
        lastDiffLine = undefined;
        continue;
      }
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
