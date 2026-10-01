import { describe, expect, it } from 'vitest';
import { redactToken, runCli } from '../src/cli.js';
import {
  CaptureStream,
  PR_URL,
  failingFetch,
  fixtureFetch,
} from './helpers.js';

const TOKEN = 'ghp_test-token-do-not-print';

function streams(): { out: CaptureStream; err: CaptureStream } {
  return { out: new CaptureStream(), err: new CaptureStream() };
}

describe('runCli review', () => {
  it('prints a JSON review result for a pull request URL', async () => {
    const { out, err } = streams();
    const code = await runCli(
      ['review', PR_URL],
      { GITHUB_TOKEN: TOKEN },
      { out, err },
      { fetch: fixtureFetch().fetch },
    );

    expect(code).toBe(0);
    expect(err.text).toBe('');
    const result = JSON.parse(out.text) as { version: number; parts: unknown[] };
    expect(result.version).toBe(2);
    expect(result.parts).toHaveLength(11);
  });

  it('accepts the token as a flag instead of the environment', async () => {
    const { out, err } = streams();
    const code = await runCli(
      ['review', PR_URL, '--token', TOKEN],
      {},
      { out, err },
      { fetch: fixtureFetch().fetch },
    );
    expect(code).toBe(0);
    const result = JSON.parse(out.text) as { version: number };
    expect(result.version).toBe(2);
  });

  it('never writes the token to stdout or stderr', async () => {
    const { out, err } = streams();
    const code = await runCli(
      ['review', PR_URL],
      { GITHUB_TOKEN: TOKEN },
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
      { GITHUB_TOKEN: TOKEN },
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
      { GITHUB_TOKEN: TOKEN },
      { out, err },
      { fetch: fixtureFetch().fetch },
    );
    expect(code).toBe(1);
    expect(err.text).toContain('not a GitHub pull request URL');
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
