import { readdir, readFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathInCopy } from '@second-look/engine';
import type {
  Criteria,
  CriterionVerdictKind,
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
  /**
   * The acceptance criteria as the review read them, with every linked
   * issue's full body, so a replay compares the change with the same
   * issues; absent for a case recorded before the issues were read.
   */
  criteria?: Criteria;
}

/** The noise a reviewer expects on one changed file. */
export type ExpectedNoise = { label: 'none' } | { label: NoiseLabel; state: NoiseState };

/** The outcome of checking a claim (the glossary's verdicts). */
export type Verdict = 'verified' | 'refuted' | 'unverifiable' | 'not checked';

/** Where a verdict's evidence came from (the glossary's evidence sources). */
export type EvidenceSource =
  | 'the change itself'
  | 'library source at the pinned version'
  | 'a named repository'
  | 'decompiled library code'
  | 'a CI log'
  | 'the issue text'
  | "the model's memory";

/**
 * One claim the change makes, as a reviewer expects the companion to find
 * it and, when the case labels it, check it: the statement's text, where
 * the change makes it, the library it is about as the project pins it,
 * the verdict it deserves with the evidence that proves it, and that a
 * library fetch should be offered before the check reads the library's
 * source.
 */
export interface ExpectedClaim {
  /** The claim's text, exactly as the change states it, on one line. */
  text: string;
  /**
   * Where the change makes the claim: the file and 1-based head-side line
   * the statement starts at, or the 1-based line of the pull request's
   * description.
   */
  origin: { file: string; line: number } | { in: 'description'; line: number };
  /**
   * Set on a statement a reviewer may or may not count as a claim, such
   * as a comment naming what the next lines do: listing it is no false
   * claim, and leaving it out no miss.
   */
  optional?: true;
  /** The library the claim is about, as the project pins it; absent for a claim about the change's own code. */
  library?: {
    /** The package name the pin uses. */
    name: string;
    /** The version the project pins. */
    pinnedVersion: string;
    /** The file that pins it, by its path in the head copy. */
    pinnedBy: string;
  };
  /** The verdict the reviewer expects, with the evidence that proves it; absent until the case labels it. */
  verdict?: {
    kind: Verdict;
    evidence: {
      /** The evidence file, named as its source names it. */
      file: string;
      /** The 1-based line of the evidence file at the pinned version. */
      line: number;
      source: EvidenceSource;
    };
    /**
     * Other lines that prove the verdict just as well, from the same
     * evidence source, such as the same default declared again where the
     * change's own type declares it; a first citation at any of them counts.
     */
    otherEvidence?: { file: string; line: number }[];
  };
  /** That the companion offers a library fetch before checking this claim. */
  libraryFetch?: true;
}

/**
 * One statement in the description or a linked issue that describes a
 * change the diff does not contain, as a reviewer expects the companion
 * to find it: its text and where it is made.
 */
export interface ExpectedDescribed {
  /** The statement's text, exactly as its source states it, on one line. */
  text: string;
  /**
   * Where it is made: the 1-based line of the description, or of the
   * body of the linked issue with that number in the case's criteria.
   */
  origin: { in: 'description'; line: number } | { issue: number; line: number };
  /** Set on a statement a reviewer may or may not count: listing it is no false finding, and leaving it out no miss. */
  optional?: true;
}

/**
 * The unexplained changes a reviewer expects, in both directions: the
 * parts neither the description nor a linked issue explains, and the
 * changes they describe that the diff does not contain.
 */
export interface ExpectedUnexplained {
  /** The parts that must be flagged, each by its name as the engine prints it, or else by a path it holds. */
  parts: string[];
  /** Parts a reviewer may or may not call unexplained: flagging one is no false flag, and leaving it out no miss. */
  optionalParts?: string[];
  described: ExpectedDescribed[];
}

/**
 * A manual check the description reports, as a reviewer expects the
 * companion to cite it for a criterion: its text and the description line
 * it starts on.
 */
export interface ExpectedManualCheck {
  /** The report's text, exactly as the description states it, on one line. */
  text: string;
  /** The 1-based line of the description it starts on. */
  line: number;
}

/**
 * One acceptance criterion of the case's recorded linked issues, as a
 * reviewer expects the companion to map it: its quote, the verdict it
 * deserves, and where the change shows it.
 */
export interface ExpectedCriterion {
  /** The criterion's quote, exactly as the review reads it from the issue's checklist, on one line. */
  text: string;
  /** The verdict it deserves. */
  verdict: CriterionVerdictKind;
  /** Other verdicts a reviewer would accept as well, such as partly met beside not met for a gap that is arguable. */
  alsoRight?: CriterionVerdictKind[];
  /** The files of the head copy whose lines implement it; a citation of any line of one counts. */
  code?: string[];
  /** The test files whose lines cover it. */
  tests?: string[];
  /** The manual checks the description reports for it. */
  manual?: ExpectedManualCheck[];
}

/** A case's `expected.json`, written by hand. */
export interface ExpectedResults {
  /**
   * Each changed file's expected noise label and state, by path on the new
   * side; null for a file not labelled yet, which no score counts.
   */
  noise: Record<string, ExpectedNoise | null>;
  /**
   * The parts a reviewer must not miss, each by its name as the engine
   * prints it, or else by its path (the first part holding that file).
   */
  importantParts: string[];
  /** The claims the change makes, each expected to be found, and checked when it has a verdict. */
  claims: ExpectedClaim[];
  /**
   * The hand-labelled grouping: the parts a reviewer would read, each as
   * the hunks it holds. A hunk is `path#n`, the file's n-th hunk in the
   * diff counting from 1, by its path on the new side; a file without
   * hunks, such as a binary, is its bare path. Absent when the case's
   * grouping is not labelled.
   */
  groups?: string[][];
  /** The hand-labelled unexplained changes; absent when the case labels none. */
  unexplained?: ExpectedUnexplained;
  /** The hand-labelled verdicts of the acceptance criteria; absent when the case labels none. */
  criteria?: ExpectedCriterion[];
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
  const recorded = await readJson<Partial<ExpectedResults>>(join(folder, 'expected.json'));
  const expected: ExpectedResults = {
    noise: recorded.noise ?? {},
    importantParts: recorded.importantParts ?? [],
    claims: recorded.claims ?? [],
    ...(recorded.groups ? { groups: recorded.groups } : {}),
    ...(recorded.unexplained ? { unexplained: recorded.unexplained } : {}),
    ...(recorded.criteria ? { criteria: recorded.criteria } : {}),
  };
  return { id: record.id, folder, record, expected };
}

/**
 * Loads every case in the given folders: each sub-folder holding a
 * `case.json` is one case. A folder may live outside the repository, so
 * private cases never enter it. A folder named twice is read once; two
 * cases with one id are refused.
 */
export async function loadCases(folders: readonly string[]): Promise<EvaluationCase[]> {
  const cases = new Map<string, EvaluationCase>();
  for (const folder of new Set(folders.map((given) => resolve(given)))) {
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
    ...(record.criteria ? { criteria: record.criteria } : {}),
  };
}

/**
 * A fetch that serves a case's recorded library downloads, so a library
 * fetch replays offline: each URL is answered from `fetched/<host>/<path>`
 * in the case folder, and any URL the case did not record with a 404.
 */
export function recordedFetch(folder: string): typeof fetch {
  const root = join(folder, 'fetched');
  return async (input) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const path = pathInCopy(root, `${url.host}${url.pathname}`);
    const body = path === undefined ? undefined : await readFile(path).catch(() => undefined);
    return body === undefined ? new Response('not recorded in the case', { status: 404 }) : new Response(body);
  };
}
