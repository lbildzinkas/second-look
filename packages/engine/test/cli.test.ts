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
    expect(err.text).toBe('');
    const result = JSON.parse(out.text) as { version: number; parts: unknown[] };
    expect(result.version).toBe(12);
    expect(result.parts).toHaveLength(11);
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
    expect(result.version).toBe(12);
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
