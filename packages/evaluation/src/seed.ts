import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { filesNaming, lockfileManifests, parseDiff, pathInCopy, reviewChange } from '@second-look/engine';
import type { Part, PullRequestSummary } from '@second-look/engine';
import { CASE_FORMAT_VERSION, caseInput, loadCase } from './case.js';
import type { CaseRecord, ExpectedNoise, ExpectedResults } from './case.js';
import { copyFiles, exists } from './record.js';

/** Options the seed command passes to {@link seedCase}. */
export interface SeedOptions {
  /** The folder holding the un-mutated code the mutant applies to. */
  sourceDir: string;
  /** The cases folder the new case is written into. */
  casesFolder: string;
  /** The case's name; required, so no folder is seeded by accident. */
  id: string;
  /**
   * The diff path holding the mutant, for a diff that wraps the mutant
   * with benign edits from the same project; only that file's parts are
   * the important ones.
   */
  faultPath?: string;
  /** The seeding time; the clock when not given. */
  now?: Date;
}

const CASE_ID = /^[A-Za-z0-9_.-]+$/;
/** The author every seeded case is wrapped as; a neutral stand-in. */
const SEEDED_AUTHOR = 'contributor-login';

/**
 * Wraps one mutant as a recorded case: the mutant, a unified diff against
 * the un-mutated code in `sourceDir`, becomes a pull request whose title,
 * branch and description say only which files changed, never what the edit
 * does — a reviewer reads the diff, not a hint. A diff may wrap the mutant
 * with benign edits from the same project, so the ranking has other parts
 * to put beside the fault; `faultPath` then names the mutated file. The
 * case's `expected.json` is written in full: every changed file carries
 * the noise the live review assessed it with — `none` for ordinary code,
 * a wrap's lockfile or rename the label the review gave it — and the
 * known important parts are the ones holding the fault —
 * every part when no `faultPath` is given, the starting point the
 * revert-the-fix recipe labels by hand — so the rank scores measure
 * whether a review puts the fault where a reviewer reads first. The case
 * is then replayed offline and refused unless it gives the same parts as
 * the review of the full mutated tree. Returns the case folder.
 */
export async function seedCase(diff: string, options: SeedOptions): Promise<string> {
  if (!CASE_ID.test(options.id) || options.id === '.' || options.id === '..') {
    throw new Error(`not a usable case name: ${options.id}`);
  }
  const folder = join(options.casesFolder, options.id);
  if (await exists(folder)) throw new Error(`a case already exists at ${folder}`);

  const files = parseDiff(diff).files;
  if (files.length === 0) throw new Error('the mutant diff changes no file');
  if (files.some((file) => file.isBinary)) {
    throw new Error('the mutant diff changes a binary file; mutants are text edits');
  }
  if (options.faultPath !== undefined && !files.some((file) => file.path === options.faultPath)) {
    throw new Error(`the diff does not change the fault path: ${options.faultPath}`);
  }

  // The mutated head tree the review reads: the source with the mutant
  // applied, like the archive of a real pull request's head commit. The
  // skipped folders never ship in a source archive, so leaving them out
  // keeps the name-based reference counts as in a live review.
  const summary = neutralSummary(files, diff);
  const gitAttributes = await readGitAttributes(options.sourceDir);
  const mutated = await mkdtemp(join(tmpdir(), 'second-look-seed-'));
  try {
    await cp(options.sourceDir, mutated, {
      recursive: true,
      filter: (source) => {
        const name = basename(source);
        return name !== '.git' && name !== 'node_modules';
      },
    });
    for (const file of files) {
      const mutatedPath = pathInCopy(mutated, file.path);
      if (!mutatedPath) throw new Error(`not a usable path in the diff: ${file.path}`);
      if (file.changeKind === 'deletion') {
        await rm(mutatedPath, { force: true });
        continue;
      }
      const sourcePath = pathInCopy(options.sourceDir, file.previousPath ?? file.path);
      const base =
        sourcePath && (await exists(sourcePath)) ? await readFile(sourcePath, 'utf8') : undefined;
      await mkdir(dirname(mutatedPath), { recursive: true });
      await writeFile(mutatedPath, applyHunks(file, base));
    }

    const live = await reviewChange({
      pullRequest: summary,
      diff,
      gitAttributes,
      copies: {
        base: { commit: summary.baseCommit, path: options.sourceDir, reused: true },
        head: { commit: summary.headSha, path: mutated, reused: true },
      },
    });

    const basePaths = new Set<string>();
    const headPaths = new Set<string>();
    for (const part of live.parts) {
      if (part.changeKind !== 'addition') basePaths.add(part.previousPath ?? part.path);
      if (part.changeKind !== 'deletion') headPaths.add(part.path);
    }
    const names = new Set(live.parts.flatMap((part) => part.signals?.references.names ?? []));
    for (const naming of (await filesNaming(mutated, names)).values()) {
      for (const path of naming) headPaths.add(path);
    }
    // A wrap may touch a lock file while leaving its manifest alone (a
    // transitive dependency bump); the review reads that manifest, and
    // the manifests of the workspace members either side declares, to
    // check the lock file, so the case carries them on both sides and the
    // replay assesses the lock file exactly as the live review did.
    const changedPaths = [
      ...new Set(live.parts.flatMap((part) => [part.path, part.previousPath ?? part.path])),
    ];
    for (const copy of [options.sourceDir, mutated]) {
      for (const manifest of await lockfileManifests(changedPaths, copy)) {
        basePaths.add(manifest);
        headPaths.add(manifest);
      }
    }
    try {
      await copyFiles(options.sourceDir, join(folder, 'base'), basePaths);
      await copyFiles(mutated, join(folder, 'head'), headPaths);

      const record: CaseRecord = {
        formatVersion: CASE_FORMAT_VERSION,
        id: options.id,
        source: summary.url,
        recordedAt: (options.now ?? new Date()).toISOString(),
        prompts: [],
        pullRequest: summary,
        gitAttributes,
        baseCommit: summary.baseCommit,
        headCommit: summary.headSha,
      };
      const expected: ExpectedResults = {
        noise: Object.fromEntries(
          [...new Set(live.parts.map((part) => part.path))]
            .sort()
            .map((path) => [path, expectedNoiseOf(live.parts.find((part) => part.path === path)!)]),
        ),
        importantParts: (options.faultPath === undefined
          ? live.parts
          : live.parts.filter((part) => part.path === options.faultPath)
        ).map((part) => part.name ?? part.path),
        claims: [],
      };
      await writeFile(join(folder, 'case.json'), `${JSON.stringify(record, null, 2)}\n`);
      await writeFile(join(folder, 'change.diff'), diff);
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
  } finally {
    await rm(mutated, { recursive: true, force: true });
  }
}

/**
 * The expected noise of a changed file, as the live review assessed it:
 * `none`, or the label with the state the review gave it. The review
 * assesses every part, and its rules read only the file, so every part
 * of one file carries the same assessment.
 */
function expectedNoiseOf(part: Part): ExpectedNoise {
  const noise = part.noise!;
  return noise.label === 'none' ? { label: 'none' } : { label: noise.label, state: noise.state };
}

/**
 * Applies a file's hunks to its base content, giving the mutated content.
 * Every context and removed line must match the base at its old line
 * number, so a diff that does not belong to the source tree is refused
 * instead of seeding a case that cannot replay.
 */
export function applyHunks(file: Part, base: string | undefined): string {
  const split = base === undefined ? { lines: [] as string[], final: true } : splitLines(base);
  const out: string[] = [];
  let old = 0;
  let lastLineEndsWithoutNewline = false;
  for (const hunk of file.hunks) {
    const start = Math.max(hunk.oldStart - 1, 0);
    if (start < old) {
      throw new Error(`the mutant diff does not apply to ${file.path}: hunks overlap`);
    }
    let cursor = start;
    for (const line of hunk.lines) {
      if (line.kind === 'addition') continue;
      if (split.lines[cursor] !== line.text) {
        throw new Error(`the mutant diff does not apply to ${file.path} at line ${cursor + 1}`);
      }
      cursor++;
    }
    out.push(...split.lines.slice(old, start));
    for (const line of hunk.lines) {
      if (line.kind === 'deletion') continue;
      out.push(line.text);
      lastLineEndsWithoutNewline = line.endsWithoutNewline === true;
    }
    old = cursor;
  }
  const tail = split.lines.slice(old);
  out.push(...tail);
  if (out.length === 0) return '';
  // The head's last line is the base's when the hunks stop short of the
  // file's end, and the last line the diff emits when they do not.
  const endsWithoutNewline = tail.length > 0 ? !split.final : lastLineEndsWithoutNewline;
  return `${out.join('\n')}${endsWithoutNewline ? '' : '\n'}`;
}

function splitLines(text: string): { lines: string[]; final: boolean } {
  const raw = text.split('\n');
  return text.endsWith('\n') ? { lines: raw.slice(0, -1), final: true } : { lines: raw, final: false };
}

/**
 * The pull request the mutant is wrapped as: neutral wording that names
 * only the changed files, so the title, branch and description never hint
 * at what the edit does or that it is a seeded fault. The number and the
 * commits are fixed hashes of the diff, so seeding the same mutant twice
 * gives the same case.
 */
function neutralSummary(files: readonly Part[], diff: string): PullRequestSummary {
  const paths = [...new Set(files.map((file) => file.path))];
  const one = paths.length === 1 ? paths[0] : undefined;
  const title = one === undefined ? `Update ${paths.length} files` : `Update ${one}`;
  const description = one === undefined ? `Updates ${paths.length} files.` : `Updates ${one}.`;
  const number = seededNumber(diff);
  return {
    url: `https://github.com/example-org/example-repo/pull/${number}`,
    number,
    title,
    author: SEEDED_AUTHOR,
    description,
    base: 'master',
    head: one === undefined ? `update-${paths.length}-files` : branchOf(one),
    baseCommit: seededCommit(diff, 'base'),
    headSha: seededCommit(diff, 'head'),
  };
}

/** A branch name from the file's name: neutral, and stable for the file. */
function branchOf(path: string): string {
  const stem = basename(path)
    .replace(/\.[^.]+$/, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `update-${stem}`;
}

/** A deterministic 40-hex commit standing in for the fabricated pull request. */
function seededCommit(diff: string, salt: string): string {
  return createHash('sha256').update(`${salt}:${diff}`).digest('hex').slice(0, 40);
}

/** A pull request number fixed by the diff, so the fabricated URL is stable. */
function seededNumber(diff: string): number {
  return 1000 + (parseInt(seededCommit(diff, 'number').slice(0, 8), 16) % 9000);
}

async function readGitAttributes(sourceDir: string): Promise<string | null> {
  const path = pathInCopy(sourceDir, '.gitattributes');
  return path && (await exists(path)) ? ((await readFile(path, 'utf8')) || null) : null;
}
