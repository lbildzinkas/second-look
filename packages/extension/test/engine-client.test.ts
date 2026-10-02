import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { ProtocolError } from '../src/protocol.js';
import { EngineClient } from '../src/engine-client.js';
import { mixedResult } from './results.js';

const FAKE_ENGINE = fileURLToPath(new URL('./fixtures/fake-engine.mjs', import.meta.url));
const PR_URL = 'https://github.com/example-org/example-repo/pull/42';
const TOKEN = 'ghp_test-token-do-not-print';

const workDir = mkdtempSync(join(tmpdir(), 'second-look-engine-client-'));

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
});

interface FakeEngineOptions {
  result?: unknown;
  error?: string;
  protocolVersion?: string;
  exitOn?: string;
  logName?: string;
}

/** Starts the fake engine as a separate process, speaking real stdio. */
function fakeEngine(options: FakeEngineOptions = {}): ChildProcessWithoutNullStreams {
  return spawn(process.execPath, [FAKE_ENGINE], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      ...(options.result !== undefined
        ? { FAKE_ENGINE_RESULT: JSON.stringify(options.result) }
        : {}),
      ...(options.error !== undefined ? { FAKE_ENGINE_ERROR: options.error } : {}),
      ...(options.protocolVersion !== undefined
        ? { FAKE_ENGINE_PROTOCOL_VERSION: options.protocolVersion }
        : {}),
      ...(options.exitOn !== undefined ? { FAKE_ENGINE_EXIT_ON: options.exitOn } : {}),
      ...(options.logName !== undefined
        ? { FAKE_ENGINE_LOG: join(workDir, options.logName) }
        : {}),
    },
  });
}

/** Every request the fake engine logged, as JSON values. */
function loggedRequests(name: string): unknown[] {
  return readFileSync(join(workDir, name), 'utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line));
}

describe('EngineClient against a fake engine', () => {
  it('starts with a handshake, then reviews a pull request over the protocol', async () => {
    const client = new EngineClient(() => fakeEngine({ result: mixedResult(), logName: 'round-trip.log' }));

    await client.initialize();
    const result = await client.review(PR_URL, TOKEN);

    expect(result.version).toBe(2);
    expect(result.parts).toHaveLength(7);

    const requests = loggedRequests('round-trip.log') as {
      method: string;
      params: { url?: string; token?: string; protocolVersion?: number };
    }[];
    expect(requests[0]).toEqual({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1 } });
    expect(requests[1]).toMatchObject({
      method: 'review',
      params: { url: PR_URL, token: TOKEN },
    });
    client.dispose();
  });

  it('carries the GitHub token with each request and keeps no copy', async () => {
    const client = new EngineClient(() => fakeEngine({ result: mixedResult(), logName: 'per-request.log' }));

    await client.initialize();
    await client.review(PR_URL, 'ghp_first-token');
    await client.review(PR_URL, 'ghp_second-token');

    const reviews = loggedRequests('per-request.log').filter(
      (request) => (request as { method: string }).method === 'review',
    ) as { params: { token: string } }[];
    expect(reviews.map((review) => review.params.token)).toEqual([
      'ghp_first-token',
      'ghp_second-token',
    ]);
    client.dispose();
  });

  it('refuses an engine that speaks another protocol version, with its plain message', async () => {
    const client = new EngineClient(() => fakeEngine({ protocolVersion: '2', logName: 'mismatch.log' }));

    await expect(client.initialize()).rejects.toThrow(
      'protocol version 1 is not supported; this engine speaks 2',
    );
    client.dispose();
  });

  it('refuses a review before the handshake completed', async () => {
    const client = new EngineClient(() => fakeEngine({ logName: 'uninitialized.log' }));

    await expect(client.review(PR_URL, TOKEN)).rejects.toThrow(
      'the engine has not completed its handshake yet',
    );
    client.dispose();
  });

  it('reads an engine failure as its plain message', async () => {
    const client = new EngineClient(() => fakeEngine({ error: 'not a GitHub pull request URL: nope', logName: 'failure.log' }));

    await client.initialize();
    await expect(client.review('nope', TOKEN)).rejects.toThrow(
      'not a GitHub pull request URL: nope',
    );
    client.dispose();
  });

  it('rejects an answer that is not a review result of the shared version', async () => {
    const client = new EngineClient(() => fakeEngine({ result: { version: 99 }, logName: 'bad-result.log' }));

    await client.initialize();
    await expect(client.review(PR_URL, TOKEN)).rejects.toBeInstanceOf(ProtocolError);
    client.dispose();
  });

  it('says so plainly when the engine stops before answering', async () => {
    const client = new EngineClient(() => fakeEngine({ exitOn: 'review', logName: 'exit.log' }));

    await client.initialize();
    await expect(client.review(PR_URL, TOKEN)).rejects.toThrow(
      'the engine stopped before answering',
    );
    client.dispose();
  });
});
