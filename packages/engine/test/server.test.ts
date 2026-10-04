import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  ENGINE_FAILED_CODE,
  ENGINE_PROTOCOL_VERSION,
  JSON_RPC_INVALID_PARAMS,
  NOT_INITIALIZED_CODE,
  REVIEW_STAGE_METHOD,
  VERSION_MISMATCH_CODE,
} from '../src/rpc.js';
import { runRpcServer } from '../src/server.js';
import { removeCopy } from '../src/cache.js';
import {
  PR_7_URL,
  PR_URL,
  SENT_REVIEW_URL,
  fixtureFetch,
  pull7,
  scriptedAgent,
  temporaryCacheDir,
} from './helpers.js';

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
    const written: string[] = [];
    let firstReviewAnswered!: () => void;
    const answered = new Promise<void>((resolve) => {
      firstReviewAnswered = resolve;
    });
    const lines = [
      request('initialize', { protocolVersion: ENGINE_PROTOCOL_VERSION }),
      request('review', { url: PR_URL, token: TOKEN }, 2),
    ];
    let index = 0;
    await runRpcServer(
      {
        // A client that reviews one pull request at a time sends its next
        // review only after the previous one was answered.
        readLine: async () => {
          if (index < lines.length) return lines[index++]!;
          if (index === lines.length) {
            index++;
            await answered;
            return request('review', { url: PR_URL, token: 'ghp_another-token' }, 3);
          }
          return null;
        },
      },
      {
        writeLine: (line) => {
          written.push(line);
          if ((JSON.parse(line) as Response).id === 2) firstReviewAnswered();
        },
      },
      { fetch: transport.fetch, cacheDir },
    );
    const responses = written.map((line) => JSON.parse(line) as Response);

    expect(responses[0]!.result).toEqual({ protocolVersion: ENGINE_PROTOCOL_VERSION });
    const first = responses[1]!.result as { version: number; parts: unknown[] };
    expect(first.version).toBe(4);
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
    expect(responses[1]!.error!.message).toContain('initialize, review and sendReview');
    expect(responses[2]!.result).toEqual({ protocolVersion: ENGINE_PROTOCOL_VERSION });
  });

  it('sends a pending review after the handshake, as one write', async () => {
    const transport = fixtureFetch();
    const responses = await serve(
      [
        request('initialize', { protocolVersion: ENGINE_PROTOCOL_VERSION }),
        request(
          'sendReview',
          {
            url: PR_URL,
            token: TOKEN,
            review: {
              submit: 'comment',
              body: 'One deliberate pass over the change.',
              comments: [
                {
                  kind: 'line',
                  path: 'src/settings.ts',
                  side: 'base',
                  line: 3,
                  body: 'why remove this?',
                },
                { kind: 'part', path: 'README.md', body: 'reads well now' },
              ],
            },
          },
          2,
        ),
      ],
      transport.fetch,
    );

    expect(responses[1]!.result).toEqual({ url: SENT_REVIEW_URL });
    // Only the send wrote, and it wrote once, with the request's token.
    const writes = transport.requests.filter((served) => served.method === 'POST');
    expect(writes).toHaveLength(1);
    expect(writes[0]!.body).toMatchObject({
      event: 'COMMENT',
      comments: [
        { path: 'src/settings.ts', position: 2 },
        { path: 'README.md', subject_type: 'file' },
      ],
    });
    expect(writes[0]!.authorization).toBe(`token ${TOKEN}`);
  });

  it('refuses a send before the handshake completed', async () => {
    const responses = await serve([request('sendReview', { url: PR_URL, token: TOKEN, review: { submit: 'approve', comments: [] } })]);

    expect(responses[0]!.error).toMatchObject({ code: NOT_INITIALIZED_CODE });
    expect(responses[0]!.error!.message).toContain('initialize before sendReview');
  });

  it('refuses send params that are not a URL, a token and a pending review', async () => {
    const responses = await serve([
      request('initialize', { protocolVersion: ENGINE_PROTOCOL_VERSION }),
      request('sendReview', { url: PR_URL, token: TOKEN, review: { submit: 'bless', comments: [] } }, 2),
      request('sendReview', { url: PR_URL, token: TOKEN, review: { submit: 'comment', comments: [{ kind: 'line', path: 'a.ts', side: 'middle', line: 1, body: '' }] } }, 3),
      request('sendReview', { url: PR_URL, token: TOKEN }, 4),
      request('sendReview', { url: PR_URL, token: TOKEN, review: { submit: 'comment', comments: [{ kind: 'part', path: 'a.ts' }] } }, 5),
    ]);

    for (const response of responses.slice(1)) {
      expect(response.error).toMatchObject({ code: JSON_RPC_INVALID_PARAMS });
      expect(response.error!.message).toContain('sendReview needs params');
    }
  });

  it('answers a failed send with the plain message, with the token redacted', async () => {
    const leakingFetch: typeof fetch = async (input, init) => {
      const authorization = new Headers(init?.headers).get('authorization') ?? '';
      if ((init?.method ?? 'GET') === 'POST') {
        throw new Error(`the review could not be sent with ${authorization}`);
      }
      return fixtureFetch().fetch(input, init);
    };
    const responses = await serve(
      [
        request('initialize', { protocolVersion: ENGINE_PROTOCOL_VERSION }),
        request('sendReview', { url: PR_URL, token: TOKEN, review: { submit: 'comment', comments: [] } }, 2),
      ],
      leakingFetch,
    );

    expect(responses[1]!.error).toMatchObject({ code: ENGINE_FAILED_CODE });
    expect(responses[1]!.error!.message).not.toContain(TOKEN);
    expect(responses[1]!.error!.message).toContain('[REDACTED]');
  });

  it('ends when the input ends', async () => {
    const responses = await serve([request('initialize', { protocolVersion: ENGINE_PROTOCOL_VERSION })]);
    expect(responses).toHaveLength(1);
  });
});

describe('runRpcServer with an agent', () => {
  it('sends the plain result as a stage notification before the answer with the agent parts', async () => {
    const lines = [
      request('initialize', { protocolVersion: ENGINE_PROTOCOL_VERSION }),
      request('review', { url: PR_7_URL, token: TOKEN }, 2),
    ];
    const answer = {
      parts: [
        { name: 'fresh, with its test', hunks: ['h2', 'h7'] },
        { name: 'the rest', hunks: ['h1', 'h3', 'h4', 'h5', 'h6'] },
      ],
    };
    let index = 0;
    const written: string[] = [];
    await runRpcServer(
      { readLine: async () => (index < lines.length ? (lines[index++] as string) : null) },
      { writeLine: (line) => written.push(line) },
      {
        cacheDir,
        fetch: fixtureFetch(pull7()).fetch,
        agent: { adapter: scriptedAgent([JSON.stringify(answer)]) },
      },
    );

    const [handshake, stage, final] = written.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(written).toHaveLength(3);
    expect(handshake).toMatchObject({ id: 1 });
    // A notification has no id of its own; its params name the review request.
    expect(stage).not.toHaveProperty('id');
    expect(stage).toMatchObject({
      jsonrpc: '2.0',
      method: REVIEW_STAGE_METHOD,
      params: {
        id: 2,
        running: 'grouping related hunks with fake',
        timeoutMs: 660_000,
        result: { version: 4, grouping: { by: 'plain' } },
      },
    });
    expect(final).toMatchObject({ id: 2, result: { grouping: { by: 'agent' } } });
    expect((final!['result'] as { parts: unknown[] }).parts).toHaveLength(2);
    expect(written.join('\n')).not.toContain(TOKEN);
  });

  it('answers a send while a review is still running its agent stage', async () => {
    const answer = {
      parts: [
        { name: 'fresh, with its test', hunks: ['h2', 'h7'] },
        { name: 'the rest', hunks: ['h1', 'h3', 'h4', 'h5', 'h6'] },
      ],
    };
    const base = scriptedAgent([JSON.stringify(answer)]);
    let stageStarted = false;
    let releaseStage!: () => void;
    const stage = new Promise<void>((resolve) => {
      releaseStage = resolve;
    });
    const adapter: typeof base = {
      ...base,
      run: async (request) => {
        stageStarted = true;
        await stage;
        return base.run(request);
      },
    };
    const lines = [
      request('initialize', { protocolVersion: ENGINE_PROTOCOL_VERSION }),
      request('review', { url: PR_7_URL, token: TOKEN }, 2),
      request(
        'sendReview',
        { url: PR_7_URL, token: TOKEN, review: { submit: 'comment', comments: [] } },
        3,
      ),
    ];
    let index = 0;
    const written: string[] = [];
    const server = runRpcServer(
      { readLine: async () => (index < lines.length ? (lines[index++] as string) : null) },
      { writeLine: (line) => written.push(line) },
      { cacheDir, fetch: fixtureFetch(pull7()).fetch, agent: { adapter } },
    );
    await vi.waitFor(() => expect(stageStarted).toBe(true));
    await vi.waitFor(() => {
      expect(written.some((line) => (JSON.parse(line) as Response).id === 3)).toBe(true);
    });
    expect(written.some((line) => (JSON.parse(line) as Response).id === 2)).toBe(false);
    releaseStage();
    await server;
    const responses = written.map((line) => JSON.parse(line) as Response);
    const send = responses.find((response) => response.id === 3);
    const review = responses.find((response) => response.id === 2);
    expect(responses.indexOf(send!)).toBeLessThan(responses.indexOf(review!));
    expect(send!.result).toEqual({ url: SENT_REVIEW_URL });
    expect(review!.result).toMatchObject({ grouping: { by: 'agent' } });
    expect((review!.result as { parts: unknown[] }).parts).toHaveLength(2);
  });
});
