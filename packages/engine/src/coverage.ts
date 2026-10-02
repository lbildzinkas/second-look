import type { ParsedDiff } from './diff.js';
import { filesOfPart } from './parts.js';
import type { Part, FileSlice } from './protocol.js';

/** One way the part assignment failed to cover the diff exactly. */
export interface CoverageProblem {
  /** The file the problem was found in. */
  file: string;
  /** Plain description of the uncovered or double-covered change. */
  description: string;
}

/** Outcome of the coverage check. */
export interface CoverageReport {
  ok: boolean;
  problems: CoverageProblem[];
}

/** Which side of the diff a line number belongs to. */
type Side = 'old' | 'new';

/** Identifies one changed line: `"old:12"` or `"new:34"`. */
type LineId = string;

function lineId(side: Side, line: number): LineId {
  return `${side}:${line}`;
}

/**
 * Collects the changed lines one part contributes on one side: deletions
 * with their old-side line numbers, additions with their new-side ones.
 * Context lines are not changed lines and contribute nothing.
 */
function changedLinesOnSide(part: FileSlice, side: Side): LineId[] {
  const ids: LineId[] = [];
  for (const hunk of part.hunks) {
    for (const line of hunk.lines) {
      if (side === 'old' && line.kind === 'deletion' && line.oldLineNumber !== undefined) {
        ids.push(lineId('old', line.oldLineNumber));
      }
      if (side === 'new' && line.kind === 'addition' && line.newLineNumber !== undefined) {
        ids.push(lineId('new', line.newLineNumber));
      }
    }
  }
  return ids;
}

/**
 * Proves every changed line of the diff belongs to exactly one part.
 *
 * Deletions are matched under the file's previous path, additions under its
 * current path, exactly as the diff numbers them. The check fails when a
 * changed line is claimed by no part, by more than one part, when a part
 * claims a line the diff does not contain, or when a changed file has no
 * part (or a part matches no file).
 */
export function validateCoverage(diff: ParsedDiff, parts: Part[]): CoverageReport {
  const problems: CoverageProblem[] = [];

  // Every changed line of the parsed diff, by the path it is numbered under.
  const diffLines = new Map<string, Set<LineId>>();
  const record = (path: string, id: LineId): void => {
    let ids = diffLines.get(path);
    if (!ids) {
      ids = new Set();
      diffLines.set(path, ids);
    }
    ids.add(id);
  };
  for (const file of diff.files) {
    for (const id of changedLinesOnSide(file, 'old')) {
      record(file.previousPath ?? file.path, id);
    }
    for (const id of changedLinesOnSide(file, 'new')) {
      record(file.path, id);
    }
  }

  // Every changed line each part claims, watched for double claims.
  const claims = new Map<string, Map<LineId, number>>();
  for (const [partIndex, part] of parts.entries()) {
    for (const file of filesOfPart(part)) {
      for (const side of ['old', 'new'] as const) {
        const path = side === 'old' ? file.previousPath ?? file.path : file.path;
        let byLine = claims.get(path);
        if (!byLine) {
          byLine = new Map();
          claims.set(path, byLine);
        }
        for (const id of changedLinesOnSide(file, side)) {
          const owner = byLine.get(id);
          if (owner !== undefined && owner !== partIndex) {
            problems.push({
              file: path,
              description: `changed line ${id} belongs to more than one part`,
            });
          }
          byLine.set(id, partIndex);
        }
      }
    }
  }

  // Every changed line must be claimed by some part.
  for (const [path, ids] of diffLines) {
    const claimed = claims.get(path);
    for (const id of ids) {
      if (!claimed?.has(id)) {
        problems.push({
          file: path,
          description: `changed line ${id} belongs to no part`,
        });
      }
    }
  }

  // Every claim must point at a line the diff really contains.
  for (const [path, byLine] of claims) {
    const real = diffLines.get(path);
    for (const id of byLine.keys()) {
      if (!real?.has(id)) {
        problems.push({
          file: path,
          description: `a part claims changed line ${id} that the diff does not contain`,
        });
      }
    }
  }

  // Every changed file must have a part, and every part must match a file.
  const diffPaths = new Set<string>();
  for (const file of diff.files) {
    diffPaths.add(file.path);
    if (file.previousPath !== undefined) {
      diffPaths.add(file.previousPath);
    }
  }
  const partPaths = new Set<string>();
  for (const file of parts.flatMap(filesOfPart)) {
    partPaths.add(file.path);
    if (file.previousPath !== undefined) {
      partPaths.add(file.previousPath);
    }
  }
  for (const path of diffPaths) {
    if (!partPaths.has(path)) {
      problems.push({ file: path, description: 'changed file belongs to no part' });
    }
  }
  for (const path of partPaths) {
    if (!diffPaths.has(path)) {
      problems.push({ file: path, description: 'part matches no file in the diff' });
    }
  }

  return { ok: problems.length === 0, problems };
}
