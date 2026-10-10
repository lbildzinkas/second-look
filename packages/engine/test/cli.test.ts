import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { removeCopy } from '../src/cache.js';
import { redactToken, runCli } from '../src/cli.js';
import {
  CaptureStream,
  PR_URL,
  failingFetch,
  fixtureFetch,
  temporaryCacheDir,
} from './helpers.js';
import { answering, fakeRuntime } from './fake-runtime.js';

const TOKEN = 'ghp_test-token-do-not-print';

function streams(): { out: CaptureStream; err: CaptureStream } {
  return { out: new CaptureStream(), err: new CaptureStream() };
}

let cacheDir: string;

beforeEach(() => {
  cacheDir = temporaryCacheDir();
});

afterEach(async () => {
  await removeCopy(cacheDir);
});

describe('runCli review', () => {
  it('prints a JSON review result for a pull request URL', async () => {
    const { out, err } = streams();
    const code = await runCli(
      ['review', PR_URL],
      { GITHUB_TOKEN: TOKEN, SECOND_LOOK_CACHE_DIR: cacheDir },
      { out, err },
      { fetch: fixtureFetch().fetch },
    );

    expect(code).toBe(0);
    const result = JSON.parse(out.text) as {
      version: number;
      parts: unknown[];
      budget: { limits: Record<string, number>; used: { agentRuns: number; filesFetched: number; downloadBytes: number } };
    };
    expect(result.version).toBe(19);
    expect(result.parts).toHaveLength(11);
    // Every GitHub answer and archive the review downloaded is counted,
    // with no limit set, and the use is the last line on stderr.
    const { used } = result.budget;
    expect(result.budget.limits).toEqual({ agentRuns: 0, filesFetched: 0, downloadMiB: 0 });
    expect(used.agentRuns).toBe(0);
    expect(used.filesFetched).toBeGreaterThan(0);
    expect(used.downloadBytes).toBeGreaterThan(0);
    expect(err.text).toBe(
      `second-look-engine: used 0 agent runs, ${used.filesFetched} files fetched, ${used.downloadBytes} bytes downloaded\n`,
    );
  });

  it('accepts the token as a flag instead of the environment', async () => {
    const { out, err } = streams();
    const code = await runCli(
      ['review', PR_URL, '--token', TOKEN, '--cache-dir', cacheDir],
      {},
      { out, err },
      { fetch: fixtureFetch().fetch },
    );
    expect(code).toBe(0);
    const result = JSON.parse(out.text) as {
      version: number;
      copies: { head: { path: string } };
    };
    expect(result.version).toBe(19);
    expect(result.copies.head.path.startsWith(cacheDir)).toBe(true);
  });

  it('never writes the token to stdout or stderr', async () => {
    const { out, err } = streams();
    const code = await runCli(
      ['review', PR_URL],
      { GITHUB_TOKEN: TOKEN, SECOND_LOOK_CACHE_DIR: cacheDir },
      { out, err },
      { fetch: fixtureFetch().fetch },
    );
    expect(code).toBe(0);
    expect(out.text).not.toContain(TOKEN);
    expect(err.text).not.toContain(TOKEN);
  });

  it('redacts the token when an error message would leak it', async () => {
    const { out, err } = streams();
    const code = await runCli(
      ['review', PR_URL],
      { GITHUB_TOKEN: TOKEN, SECOND_LOOK_CACHE_DIR: cacheDir },
      { out, err },
      { fetch: failingFetch(new Error(`request to ${PR_URL} failed with ${TOKEN}`)) },
    );
    expect(code).toBe(1);
    expect(out.text).toBe('');
    expect(err.text).toContain('[REDACTED]');
    expect(err.text).not.toContain(TOKEN);
  });

  it('explains how to pass a token when none was given', async () => {
    const { out, err } = streams();
    const code = await runCli(['review', PR_URL], {}, { out, err }, {});
    expect(code).toBe(1);
    expect(err.text).toContain('--token');
    expect(err.text).toContain('GITHUB_TOKEN');
    expect(out.text).toBe('');
  });

  it('rejects a URL that is not a pull request URL', async () => {
    const { out, err } = streams();
    const code = await runCli(
      ['review', 'https://github.com/example-org/example-repo'],
      { GITHUB_TOKEN: TOKEN, SECOND_LOOK_CACHE_DIR: cacheDir },
      { out, err },
      { fetch: fixtureFetch().fetch },
    );
    expect(code).toBe(1);
    expect(err.text).toContain('not a GitHub pull request URL');
  });

  it('asks for a value after --cache-dir', async () => {
    const { out, err } = streams();
    const code = await runCli(
      ['review', PR_URL, '--cache-dir'],
      { GITHUB_TOKEN: TOKEN },
      { out, err },
      {},
    );
    expect(code).toBe(1);
    expect(err.text).toContain('--cache-dir needs a value');
  });

  it('reads the acceptance criteria under the --criteria-heading flag’s heading', async () => {
    const { out, err } = streams();
    const code = await runCli(
      ['review', PR_URL, '--criteria-heading', 'Definition of done'],
      { GITHUB_TOKEN: TOKEN, SECOND_LOOK_CACHE_DIR: cacheDir },
      { out, err },
      { fetch: fixtureFetch().fetch },
    );

    expect(code).toBe(0);
    const result = JSON.parse(out.text) as { criteria: { heading: string; criteria: { quote: string }[] } };
    expect(result.criteria.heading).toBe('Definition of done');
    expect(result.criteria.criteria.map((criterion) => criterion.quote)).toEqual([
      'The retries ship behind a flag',
      'The flag is documented in the runbook',
    ]);
  });

  it('asks for a heading after --criteria-heading', async () => {
    const { out, err } = streams();
    const code = await runCli(
      ['review', PR_URL, '--criteria-heading', '  '],
      { GITHUB_TOKEN: TOKEN },
      { out, err },
      {},
    );
    expect(code).toBe(1);
    expect(err.text).toContain('--criteria-heading needs a heading');
  });

  it('refuses agent tuning flags when no agent was asked for', async () => {
    for (const flag of ['--model', '--effort', '--agent-timeout']) {
      const { out, err } = streams();
      const code = await runCli(
        ['review', PR_URL, flag, flag === '--agent-timeout' ? '30' : 'glm-4.6'],
        { GITHUB_TOKEN: TOKEN, SECOND_LOOK_CACHE_DIR: cacheDir },
        { out, err },
        { fetch: fixtureFetch().fetch },
      );

      expect(code, flag).toBe(1);
      expect(out.text, flag).toBe('');
      expect(err.text, flag).toBe(
        `second-look-engine: ${flag} tunes the agent; pass --agent to run one\n`,
      );
    }
  });

  it('refuses a model or effort the agent cannot take before starting it or fetching anything', async () => {
    const cases: [string[], string][] = [
      [['--model', '--help'], 'the model "--help" is not a plain name'],
      [['--effort', '-x'], 'the effort "-x" is not a plain level'],
      [['--effort', 'minimal'], 'claude-code does not accept the effort "minimal": choose low, medium, high, xhigh, max'],
    ];
    for (const [flags, message] of cases) {
      const { out, err } = streams();
      const code = await runCli(
        ['review', PR_URL, '--agent', 'claude-code', ...flags],
        { GITHUB_TOKEN: TOKEN, SECOND_LOOK_CACHE_DIR: cacheDir },
        { out, err },
        {
          fetch: failingFetch(new Error('nothing is fetched')),
          claudeCode: { command: ['/nonexistent/claude'], guardPath: '/nonexistent/guard' },
        },
      );

      expect(code, flags.join(' ')).toBe(1);
      expect(out.text, flags.join(' ')).toBe('');
      expect(err.text, flags.join(' ')).toContain(`second-look-engine: ${message}`);
      expect(err.text, flags.join(' ')).not.toContain('nothing is fetched');
    }
  });

  it('prints usage with --help and asks for no token', async () => {
    const { out, err } = streams();
    const code = await runCli(['--help'], {}, { out, err }, {});
    expect(code).toBe(0);
    expect(out.text).toContain('Usage:');
    expect(err.text).toBe('');
  });

  it('prints usage for an unknown command', async () => {
    const { out, err } = streams();
    const code = await runCli(['rank', PR_URL], {}, { out, err }, {});
    expect(code).toBe(1);
    expect(err.text).toContain('Usage:');
  });
});

describe('runCli run', () => {
  const IMAGE = `node@sha256:${'ab'.repeat(32)}`;
  const VERSION = '{"Client":{"Version":"29.1.3"},"Server":{"Version":"29.1.3"}}';

  /** A folder holding a runnable `docker`, which the fake runtime stands in for; nothing runs it. */
  function dockerDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'second-look-programs-'));
    writeFileSync(join(dir, 'docker'), '#!/bin/sh\nexit 99\n', { mode: 0o755 });
    return dir;
  }

  /** A runtime whose daemon answers, whose pull succeeds and whose run prints `ran`. */
  function workingRuntime(): ReturnType<typeof fakeRuntime> {
    const run = answering('ran\n');
    return fakeRuntime((call) => (call.args[0] === 'version' ? call.child.finish(0, VERSION) : run(call)));
  }

  async function runCommand(
    args: string[],
    runtime: ReturnType<typeof fakeRuntime>,
    dirs: string[] = [dockerDir()],
  ): Promise<{ code: number; out: string; err: string; fetched: string[] }> {
    const { out, err } = streams();
    const transport = fixtureFetch();
    const code = await runCli(
      ['run', PR_URL, ...args],
      { GITHUB_TOKEN: TOKEN, SECOND_LOOK_CACHE_DIR: cacheDir },
      { out, err },
      { fetch: transport.fetch, sandbox: { dirs, start: runtime.start } },
    );
    await Promise.all(dirs.map((dir) => removeCopy(dir)));
    return { code, out: out.text, err: err.text, fetched: transport.requests.map((request) => request.url) };
  }

  it('explains what will run and runs nothing without --yes', async () => {
    const runtime = workingRuntime();
    const result = await runCommand(['--image', IMAGE, '--', 'sh', '-c', 'ls ~; env'], runtime);

    expect(result.code).toBe(0);
    expect(result.out).toContain('Commit        f00dcafe1234567890abcdef1234567890abcdef');
    expect(result.out).toContain(`Image         ${IMAGE}`);
    expect(result.out).toContain("Command       sh -c 'ls ~; env', in /work");
    expect(result.out).toContain('No network');
    expect(result.out).toContain('Nothing has run. Run the same command with --yes to start it.');
    expect(runtime.calls.map((call) => call.args[0])).toEqual(['version']);
    expect(result.fetched.some((url) => url.includes('tarball'))).toBe(false);
  });

  it('runs with --yes and prints the labelled result', async () => {
    const runtime = workingRuntime();
    const result = await runCommand(['--image', IMAGE, '--yes', '--', 'npm', 'test', '--', '--yes'], runtime);

    expect(result.code).toBe(0);
    expect(result.err).toContain('Running.');
    expect(runtime.calls.map((call) => call.args[0])).toEqual(['version', 'pull', 'run']);
    const run = JSON.parse(result.out) as { commit: string; image: string; argv: string[]; exitCode: number; output: string };
    expect(run).toMatchObject({
      commit: 'f00dcafe1234567890abcdef1234567890abcdef',
      image: IMAGE,
      argv: ['npm', 'test', '--', '--yes'],
      exitCode: 0,
      output: 'ran\n',
    });
    expect(result.out).not.toContain(TOKEN);
    expect(runtime.calls.every((call) => !JSON.stringify(call.env).includes(TOKEN))).toBe(true);
  });

  it('refuses an image without a digest, and runs nothing', async () => {
    const runtime = workingRuntime();
    const result = await runCommand(['--image', 'node:22', '--yes', '--', 'true'], runtime);

    expect(result.code).toBe(1);
    expect(result.err).toMatch(/the image must be pinned by its digest.*nothing ran/);
    expect(runtime.calls).toEqual([]);
    expect(result.fetched).toEqual([]);
  });

  it('refuses when no runtime is installed, saying how to get one, and runs nothing', async () => {
    const runtime = workingRuntime();
    const empty = mkdtempSync(join(tmpdir(), 'second-look-programs-'));
    const result = await runCommand(['--image', IMAGE, '--yes', '--', 'true'], runtime, [empty]);

    expect(result.code).toBe(1);
    expect(result.err).toMatch(/Neither docker nor podman is on the PATH.*Install Docker.*Nothing ran\./);
    expect(runtime.calls).toEqual([]);
    expect(result.out).toBe('');
  });

  it('refuses when the daemon does not answer, saying how to start it, and runs nothing', async () => {
    const runtime = fakeRuntime((call) => call.child.finish(1, 'Cannot connect to the Docker daemon. Is the docker daemon running?'));
    const result = await runCommand(['--image', IMAGE, '--yes', '--', 'true'], runtime);

    expect(result.code).toBe(1);
    expect(result.err).toMatch(/docker is installed but no daemon answers.*Start Docker Desktop.*Nothing ran\./);
    expect(runtime.calls.map((call) => call.args[0])).toEqual(['version']);
    expect(result.out).toBe('');
  });

  it('asks for the image and the command', async () => {
    const noImage = await runCommand(['--', 'true'], workingRuntime());
    expect(noImage.code).toBe(1);
    expect(noImage.err).toContain('run needs --image');
    const noCommand = await runCommand(['--image', IMAGE, '--yes'], workingRuntime());
    expect(noCommand.code).toBe(1);
    expect(noCommand.err).toContain('run needs the command to run after --');
  });
});

describe('runCli serve', () => {
  it('refuses a token on the command line, where any process could read it', async () => {
    const { out, err } = streams();
    const code = await runCli(['serve', '--token', TOKEN], {}, { out, err });

    expect(code).toBe(1);
    expect(out.text).toBe('');
    expect(err.text).toBe(
      'second-look-engine: serve takes the GitHub token with each request, not on the command line\n',
    );
  });

  it('refuses an effort the agent does not accept, like review does', async () => {
    const { out, err } = streams();
    const code = await runCli(['serve', '--agent', 'pi', '--effort', 'ultra'], {}, { out, err });

    expect(code).toBe(1);
    expect(out.text).toBe('');
    expect(err.text).toBe(
      'second-look-engine: pi does not accept the effort "ultra": choose off, minimal, low, medium, high, xhigh, max, or leave it empty for the agent\'s own default\n',
    );
  });

  it('refuses an agent it cannot drive, like review does', async () => {
    const { out, err } = streams();
    const code = await runCli(['serve', '--agent', 'codex'], {}, { out, err });

    expect(code).toBe(1);
    expect(out.text).toBe('');
    expect(err.text).toBe(
      'second-look-engine: unknown agent "codex": choose pi or claude-code\n',
    );
  });
});

describe('redactToken', () => {
  it('replaces every occurrence', () => {
    expect(redactToken(`a ${TOKEN} b ${TOKEN} c`, TOKEN)).toBe(
      'a [REDACTED] b [REDACTED] c',
    );
  });

  it('leaves text alone when no token was given', () => {
    expect(redactToken('plain text', undefined)).toBe('plain text');
  });
});

describe('runCli pdb', () => {
  const fixturePath = (name: string): string =>
    fileURLToPath(new URL(`./fixtures/pdb/${name}`, import.meta.url));

  it('prints each document of a package with its hash and Source Link URL', async () => {
    const { out, err } = streams();
    const path = fixturePath('Microsoft.IO.RecyclableMemoryStream.dll');
    const code = await runCli(['pdb', path], {}, { out, err });

    expect(code).toBe(0);
    expect(err.text).toBe('');
    const result = JSON.parse(out.text) as {
      package: string;
      pdbs: { documents: { name: string; hashAlgorithm: string; hash: string; sourceLinkUrl: string }[] }[];
    };
    expect(result.package).toBe(path);
    expect(result.pdbs[0]!.documents[1]).toEqual({
      name: '/_/src/Events.cs',
      hashAlgorithm: 'SHA-256',
      hash: 'a3e3e10c7b71c9599d0d4dc65a6281169c8080f8944f8742c9f757aea0ffdb06',
      sourceLinkUrl:
        'https://raw.githubusercontent.com/microsoft/Microsoft.IO.RecyclableMemoryStream/2e75ee13b803d8c4166bc80b12acd71de37f7722/src/Events.cs',
    });
  });

  it('reads a NuGet package without any GitHub token', async () => {
    const { out, err } = streams();
    const code = await runCli(
      ['pdb', fixturePath('Microsoft.IO.RecyclableMemoryStream.1.2.2.nupkg')],
      {},
      { out, err },
    );
    expect(code).toBe(0);
    expect((JSON.parse(out.text) as { pdbs: unknown[] }).pdbs).toHaveLength(3);
  });

  it('asks for a package file when none was given', async () => {
    const { out, err } = streams();
    const code = await runCli(['pdb'], {}, { out, err });
    expect(code).toBe(1);
    expect(err.text).toContain('pdb needs a package file');
    expect(out.text).toBe('');
  });

  it('fails with a clear error for a file that is not a package', async () => {
    const { out, err } = streams();
    const path = fixturePath('../pull-42.json');
    const code = await runCli(['pdb', path], {}, { out, err });
    expect(code).toBe(1);
    expect(err.text).toContain('not a portable PDB');
    expect(out.text).toBe('');
  });

  it('fails with a clear error for a file that does not exist', async () => {
    const { out, err } = streams();
    const code = await runCli(['pdb', fixturePath('missing.nupkg')], {}, { out, err });
    expect(code).toBe(1);
    expect(err.text).toContain('ENOENT');
  });
});
