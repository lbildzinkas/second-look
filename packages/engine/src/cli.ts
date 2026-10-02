import { defaultCacheDir } from './cache.js';
import { readFile } from 'node:fs/promises';
import { reviewPullRequest } from './review.js';
import { readPackagePdbs } from './symbols.js';

const USAGE = `second-look-engine — the engine of the Second Look reviewer's companion

Usage:
  second-look-engine review <pull-request-url> [--token <token>] [--cache-dir <dir>]
  second-look-engine pdb <package-file>

The review command fetches a pull request's metadata and full diff, parses
the diff into files and hunks, and prints a typed, versioned review result
as JSON with one part per changed file. Each part carries a noise label
(lockfile, generated, vendored, moved or renamed, snapshot, fixture) with
its state — confirmed or claimed — and a one-line blind spot, or says that
no rule applied; noise parts sink to the bottom of the result, except
snapshots and fixtures, which are labelled but never sunk. The labels read
the repository's linguist attributes at the head commit, without a
checkout.

It keeps read-only copies of the base and head versions, downloaded as
archives, in a per-pull-request cache: --cache-dir, else the
SECOND_LOOK_CACHE_DIR environment variable, else the platform's per-user
cache folder. Nothing is checked out and nothing from the pull request runs.

The GitHub token is passed in by the caller, either with --token or through
the GITHUB_TOKEN environment variable. It is used only for the GitHub
request, and is never written to disk or logs.

The pdb command is a debug command: given a NuGet package or symbols
package (or a single .pdb or assembly), it reads every portable PDB in it,
standalone or embedded in an assembly, and prints as JSON each source
document with its hash algorithm, its hash and its Source Link URL, plus
each PDB's Source Link map. It reads only the local file.`;

/** Replaces every occurrence of the token so no output can leak it. */
export function redactToken(text: string, token: string | undefined): string {
  if (!token) {
    return text;
  }
  return text.split(token).join('[REDACTED]');
}

export interface WriteDestination {
  write(chunk: string): boolean;
}

export interface CliStreams {
  out: WriteDestination;
  err: WriteDestination;
}

export interface CliDeps {
  fetch?: typeof fetch;
}

/**
 * Runs the command line. Returns the process exit code: 0 on success,
 * 1 on any error. Never throws, never prints the token.
 */
export async function runCli(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
  streams: CliStreams,
  deps: CliDeps = {},
): Promise<number> {
  const positional: string[] = [];
  let tokenFlag: string | undefined;
  let cacheDirFlag: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--help' || arg === '-h') {
      streams.out.write(`${USAGE}\n`);
      return 0;
    }
    if (arg === '--token') {
      const value = argv[++i];
      if (value === undefined) {
        streams.err.write('second-look-engine: --token needs a value\n');
        return 1;
      }
      tokenFlag = value;
      continue;
    }
    if (arg === '--cache-dir') {
      const value = argv[++i];
      if (value === undefined) {
        streams.err.write('second-look-engine: --cache-dir needs a value\n');
        return 1;
      }
      cacheDirFlag = value;
      continue;
    }
    positional.push(arg);
  }

  const command = positional[0];
  if (command === 'pdb') {
    return runPdb(positional[1], streams);
  }
  const url = positional[1];
  if (command !== 'review') {
    streams.err.write(`${USAGE}\n`);
    return 1;
  }
  if (!url) {
    streams.err.write('second-look-engine: review needs a pull request URL\n');
    return 1;
  }

  const token = tokenFlag ?? env['GITHUB_TOKEN'] ?? env['GH_TOKEN'];
  if (!token) {
    streams.err.write(
      'second-look-engine: no GitHub token; pass one with --token or the GITHUB_TOKEN environment variable\n',
    );
    return 1;
  }

  try {
    const result = await reviewPullRequest(url, {
      token,
      fetch: deps.fetch,
      cacheDir: cacheDirFlag ?? defaultCacheDir(env),
    });
    streams.out.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  } catch (error) {
    const message = redactToken(
      error instanceof Error ? error.message : String(error),
      token,
    );
    streams.err.write(`second-look-engine: ${message}\n`);
    return 1;
  }
}

/** Prints every portable PDB in a package file, with its documents. */
async function runPdb(path: string | undefined, streams: CliStreams): Promise<number> {
  if (!path) {
    streams.err.write('second-look-engine: pdb needs a package file\n');
    return 1;
  }
  try {
    const pdbs = readPackagePdbs(path, await readFile(path));
    streams.out.write(`${JSON.stringify({ package: path, pdbs }, null, 2)}\n`);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    streams.err.write(`second-look-engine: ${message}\n`);
    return 1;
  }
}
