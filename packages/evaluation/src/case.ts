import { readdir, readFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type {
  NoiseLabel,
  NoiseState,
  PullRequestSummary,
  ReviewInput,
} from '@second-look/engine';

/**
 * The case format. A case is one folder holding a recorded pull request
 * and the results a reviewer expects from it, so a run reads no network:
 *
 * - `case.json` — the {@link CaseRecord}: metadata, description, the
 *   linguist attributes at the head commit, and the prompts it is tied to;
 * - `change.diff` — the full diff;
 * - `base/` and `head/` — the content the review reads from each version:
 *   the changed files, and on the head side every file naming the change's
 *   entities, so the name-based reference counts replay exactly;
 * - `expected.json` — the {@link ExpectedResults}, written by hand.
 */

/** Version of the case format; bump it when a reader must check the shape. */
export const CASE_FORMAT_VERSION = 1;

/** A case's `case.json`. */
export interface CaseRecord {
  formatVersion: typeof CASE_FORMAT_VERSION;
  /** The case's name, which is also its folder's name. */
  id: string;
  /** The pull request URL the case was recorded from. */
  source: string;
  /** When the case was recorded, as an ISO date. */
  recordedAt: string;
  /** Prompts the case is tied to; a case tied to none is model-free. */
  prompts: string[];
  pullRequest: PullRequestSummary;
  /** The root `.gitattributes` at the head commit, or null when there is none. */
  gitAttributes: string | null;
  /** The commits the base and head content were read at. */
  baseCommit: string;
  headCommit: string;
}

/** The noise a reviewer expects on one changed file. */
export type ExpectedNoise = { label: 'none' } | { label: NoiseLabel; state: NoiseState };

/** A case's `expected.json`, written by hand. */
export interface ExpectedResults {
  /**
   * Each changed file's expected noise label and state, by path on the new
   * side; null for a file not labelled yet, which no score counts.
   */
  noise: Record<string, ExpectedNoise | null>;
  /**
   * The parts a reviewer must not miss, each by its name as the engine
   * prints it, or else by its path (the file's first part).
   */
  importantParts: string[];
}

/** A case loaded from its folder. */
export interface EvaluationCase {
  id: string;
  folder: string;
  record: CaseRecord;
  expected: ExpectedResults;
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, 'utf8')) as T;
}

/** Reads one case folder, checking its format version. */
export async function loadCase(folder: string): Promise<EvaluationCase> {
  const record = await readJson<CaseRecord>(join(folder, 'case.json'));
  if (record.formatVersion !== CASE_FORMAT_VERSION) {
    throw new Error(
      `${folder}: case format ${String(record.formatVersion)} is not ${CASE_FORMAT_VERSION}`,
    );
  }
  const expected = await readJson<ExpectedResults>(join(folder, 'expected.json'));
  return { id: record.id, folder, record, expected };
}

/**
 * Loads every case in the given folders: each sub-folder holding a
 * `case.json` is one case. A folder may live outside the repository, so
 * private cases never enter it. Two cases with one id are refused.
 */
export async function loadCases(folders: readonly string[]): Promise<EvaluationCase[]> {
  const cases = new Map<string, EvaluationCase>();
  for (const folder of folders.map((given) => resolve(given))) {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      const caseFolder = join(folder, entry.name);
      if (!entry.isDirectory() || !(await isFile(join(caseFolder, 'case.json')))) continue;
      const loaded = await loadCase(caseFolder);
      const clash = cases.get(loaded.id);
      if (clash) {
        throw new Error(`two cases are named ${loaded.id}: ${clash.folder} and ${caseFolder}`);
      }
      cases.set(loaded.id, loaded);
    }
  }
  return [...cases.values()].sort((a, b) => a.id.localeCompare(b.id));
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/** The review input a case replays, read from its folder alone. */
export async function caseInput(evaluationCase: EvaluationCase): Promise<ReviewInput> {
  const { folder, record } = evaluationCase;
  return {
    pullRequest: record.pullRequest,
    diff: await readFile(join(folder, 'change.diff'), 'utf8'),
    gitAttributes: record.gitAttributes,
    copies: {
      base: { commit: record.baseCommit, path: join(folder, 'base'), reused: true },
      head: { commit: record.headCommit, path: join(folder, 'head'), reused: true },
    },
  };
}
