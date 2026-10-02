import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ENGINE_FAILED_CODE,
  ENGINE_PROTOCOL_VERSION,
  NOT_INITIALIZED_CODE,
  VERSION_MISMATCH_CODE,
} from '../src/rpc.js';
import { runRpcServer } from '../src/server.js';
import { removeCopy } from '../src/cache.js';
import { PR_URL, fixtureFetch, temporaryCacheDir } from './helpers.js';

const TOKEN = 'ghp_test-token-do-not-print';

let cacheDir: string;

beforeAll(() => {
  cacheDir = temporaryCacheDir();
});

afterAll(async () => {
  await removeCopy(cacheDir);
});

interface Response {
  jsonrpc: string;
  id: number | null;
  result?: unknown;
  error?: { code: number; message: string };
}

function request(method: string, params: unknown, id = 1): string {
  return JSON.stringify({ jsonrpc: '2.0', id, method, params });
}

/** Runs the server over the given lines and returns its answers, in order. */
async function serve(lines: string[], fetchImpl?: typeof fetch): Promise<Response[]> {
  let index = 0;
  const written: string[] = [];
  await runRpcServer(
    {
      readLine: async () => (index < lines.length ? (lines[index++] as string) : null),
    },
    { writeLine: (line) => written.push(line) },
    fetchImpl ? { fetch: fetchImpl, cacheDir } : { cacheDir },
  );
  return written.map((line) => JSON.parse(line) as Response);
}

describe('runRpcServer', () => {
  it('answers the handshake with the protocol version the engine speaks', async () => {
    const responses = await serve([request('initialize', { protocolVersion: ENGINE_PROTOCOL_VERSION })]);

    expect(responses).toEqual([
      { jsonrpc: '2.0', id: 1, result: { protocolVersion: ENGINE_PROTOCOL_VERSION } },
    ]);
  });

  it('refuses a client speaking another protocol version, with a plain message', async () => {
    const responses = await serve([request('initialize', { protocolVersion: ENGINE_PROTOCOL_VERSION + 1 })]);

    expect(responses[0]!.id).toBe(1);
    expect(responses[0]!.error).toEqual({
      code: VERSION_MISMATCH_CODE,
      message: 'protocol version 2 is not supported; this engine speaks 1',
    });
  });

  it('refuses a review before the handshake completed', async () => {
    const responses = await serve([
      request('review', { url: PR_URL, token: TOKEN }),
      request('initialize', { protocolVersion: ENGINE_PROTOCOL_VERSION }, 2),
    ]);

    expect(responses[0]!.error).toMatchObject({
      code: NOT_INITIALIZED_CODE,
    });
    expect(responses[0]!.error!.message).toContain('initialize before review');
    expect(responses[1]!.result).toEqual({ protocolVersion: ENGINE_PROTOCOL_VERSION });
  });

  it('reviews a pull request after the handshake, using each request\u2019s token', async () => {
    const transport = fixtureFetch();
    const responses = await serve(
      [
        request('initialize', { protocolVersion: ENGINE_PROTOCOL_VERSION }),
        request('review', { url: PR_URL, token: TOKEN }, 2),
        request('review', { url: PR_URL, token: 'ghp_another-token' }, 3),
      ],
      transport.fetch,
    );

    expect(responses[0]!.result).toEqual({ protocolVersion: ENGINE_PROTOCOL_VERSION });
    const first = responses[1]!.result as { version: number; parts: unknown[] };
    expect(first.version).toBe(3);
    expect(first.parts).toHaveLength(11);
    const second = responses[2]!.result as { parts: unknown[] };
    expect(second.parts).toHaveLength(11);
    // Each review asks GitHub for what it needs — the pull request twice
    // (metadata, diff), the attributes, the merge base, and on the first
    // run the two commit archives — always with the token its own request
    // carried; the second review at the same commits reuses the archives.
    const authorizations = transport.requests.map((request) => request.authorization);
    expect(authorizations.slice(0, 6)).toEqual(Array<string>(6).fill(`token ${TOKEN}`));
    expect(authorizations.slice(6)).toEqual(Array<string>(4).fill('token ghp_another-token'));
  });

  it('answers a failed review with the plain message, with the token redacted', async () => {
    const leakingFetch: typeof fetch = async (input, init) => {
      const authorization = new Headers(init?.headers).get('authorization') ?? '';
      throw new Error(`the GitHub request failed with ${authorization}`);
    };
    const responses = await serve(
      [
        request('initialize', { protocolVersion: ENGINE_PROTOCOL_VERSION }),
        request('review', { url: PR_URL, token: TOKEN }, 2),
      ],
      leakingFetch,
    );

    expect(responses[1]!.error).toMatchObject({ code: ENGINE_FAILED_CODE });
    expect(responses[1]!.error!.message).not.toContain(TOKEN);
    expect(responses[1]!.error!.message).toContain('[REDACTED]');
  });

  it('refuses review params that are not a URL and a token', async () => {
    const responses = await serve([
      request('initialize', { protocolVersion: ENGINE_PROTOCOL_VERSION }),
      request('review', { url: '', token: TOKEN }, 2),
      request('review', {}, 3),
    ]);

    expect(responses[1]!.error!.message).toContain('review needs params');
    expect(responses[2]!.error!.message).toContain('review needs params');
  });

  it('answers an unknown method and a malformed line without stopping', async () => {
    const responses = await serve([
      'not json at all',
      request('start', {}),
      request('initialize', { protocolVersion: ENGINE_PROTOCOL_VERSION }, 2),
    ]);

    expect(responses[0]!.id).toBeNull();
    expect(responses[0]!.error!.message).toContain('not JSON');
    expect(responses[1]!.error!.message).toContain('unknown method: start');
    expect(responses[2]!.result).toEqual({ protocolVersion: ENGINE_PROTOCOL_VERSION });
  });

  it('ends when the input ends', async () => {
    const responses = await serve([request('initialize', { protocolVersion: ENGINE_PROTOCOL_VERSION })]);
    expect(responses).toHaveLength(1);
  });
});
