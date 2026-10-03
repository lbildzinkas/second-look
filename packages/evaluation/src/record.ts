import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  fetchChange,
  filesNaming,
  parsePullRequestUrl,
  pathInCopy,
  reviewChange,
} from '@second-look/engine';
import { CASE_FORMAT_VERSION, caseInput, loadCase } from './case.js';
import type { CaseRecord, ExpectedResults } from './case.js';

export interface RecordOptions {
  /** GitHub token, passed in by the caller; never stored or logged. */
  token: string;
  /** The engine's cache folder, which holds the read-only copies. */
  cacheDir: string;
  /** The cases folder the new case is written into. */
  casesFolder: string;
  /** The case's name; `{owner}-{repo}-{number}` when not given. */
  id?: string;
  /** Fetch implementation; tests inject a fixture-backed one. */
  fetch?: typeof fetch;
  /** The recording time; the clock when not given. */
  now?: Date;
}

const CASE_ID = /^[A-Za-z0-9_.-]+$/;

/**
 * Records a pull request as a case: fetches it once, reviews it, and
 * writes its metadata, diff and the content the review read into a new
 * case folder, with an `expected.json` that lists every changed file for
 * the reviewer to label by hand. The case is then replayed offline and
 * refused unless it gives the same parts as the live review. Returns the
 * case folder.
 */
export async function recordCase(url: string, options: RecordOptions): Promise<string> {
  const ref = parsePullRequestUrl(url);
  const id = options.id ?? (ref ? `${ref.owner}-${ref.repo}-${ref.number}` : undefined);
  if (!id || !CASE_ID.test(id) || id === '.' || id === '..') {
    throw new Error(`not a usable case name: ${String(id)}`);
  }
  const folder = join(options.casesFolder, id);
  if (await exists(folder)) throw new Error(`a case already exists at ${folder}`);

  const input = await fetchChange(url, options);
  const live = await reviewChange(input);
  const { base, head } = input.copies;

  const basePaths = new Set<string>();
  const headPaths = new Set<string>();
  for (const part of live.parts) {
    if (part.changeKind !== 'addition') basePaths.add(part.previousPath ?? part.path);
    if (part.changeKind !== 'deletion') headPaths.add(part.path);
  }
  const names = new Set(live.parts.flatMap((part) => part.signals?.references.names ?? []));
  for (const naming of (await filesNaming(head.path, names)).values()) {
    for (const path of naming) headPaths.add(path);
  }
  try {
    await copyFiles(base.path, join(folder, 'base'), basePaths);
    await copyFiles(head.path, join(folder, 'head'), headPaths);

    const record: CaseRecord = {
      formatVersion: CASE_FORMAT_VERSION,
      id,
      source: url,
      recordedAt: (options.now ?? new Date()).toISOString(),
      prompts: [],
      pullRequest: input.pullRequest,
      gitAttributes: input.gitAttributes,
      baseCommit: base.commit,
      headCommit: head.commit,
    };
    const expected: ExpectedResults = {
      noise: Object.fromEntries(live.parts.map((part) => [part.path, null])),
      importantParts: [],
      claims: [],
    };
    await writeFile(join(folder, 'case.json'), `${JSON.stringify(record, null, 2)}\n`);
    await writeFile(join(folder, 'change.diff'), input.diff);
    await writeFile(join(folder, 'expected.json'), `${JSON.stringify(expected, null, 2)}\n`);

    const replay = await reviewChange(await caseInput(await loadCase(folder)));
    if (JSON.stringify(replay.parts) !== JSON.stringify(live.parts)) {
      throw new Error(`the case at ${folder} does not replay the live review's parts`);
    }
  } catch (error) {
    await rm(folder, { recursive: true, force: true });
    throw error;
  }
  return folder;
}

/**
 * Copies the given files of a read-only copy into a case folder, as
 * ordinary writable files; a path the copy does not hold, such as a
 * symbolic link the archive skipped, is left out.
 */
export async function copyFiles(
  from: string,
  to: string,
  paths: ReadonlySet<string>,
): Promise<void> {
  await mkdir(to, { recursive: true });
  for (const path of [...paths].sort()) {
    const source = pathInCopy(from, path);
    const target = pathInCopy(to, path);
    if (!source || !target || !(await exists(source))) continue;
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, await readFile(source));
  }
}

export async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
