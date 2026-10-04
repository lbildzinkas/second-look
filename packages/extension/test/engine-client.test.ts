import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { ProtocolError } from '../src/protocol.js';
import { EngineClient, spawnEngineProcess, type ReviewStageUpdate } from '../src/engine-client.js';
import { fetchedResult, mixedResult } from './results.js';

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
  stallOn?: string;
  ignoreSigterm?: boolean;
  logName?: string;
  stage?: unknown;
  stageOnly?: boolean;
  fetchResult?: unknown;
  fetchError?: string;
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
      ...(options.stallOn !== undefined ? { FAKE_ENGINE_STALL_ON: options.stallOn } : {}),
      ...(options.ignoreSigterm ? { FAKE_ENGINE_IGNORE_SIGTERM: '1' } : {}),
      ...(options.logName !== undefined
        ? { FAKE_ENGINE_LOG: join(workDir, options.logName) }
        : {}),
      ...(options.stage !== undefined ? { FAKE_ENGINE_STAGE: JSON.stringify(options.stage) } : {}),
      ...(options.stageOnly ? { FAKE_ENGINE_STAGE_ONLY: '1' } : {}),
      ...(options.fetchResult !== undefined ? { FAKE_ENGINE_FETCH_RESULT: JSON.stringify(options.fetchResult) } : {}),
      ...(options.fetchError !== undefined ? { FAKE_ENGINE_FETCH_ERROR: options.fetchError } : {}),
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

describe('spawnEngineProcess', () => {
  it('starts serve with nothing else on the command line', async () => {
    const echo = join(workDir, 'argv-echo.mjs');
    writeFileSync(echo, 'process.stdout.write(JSON.stringify(process.argv.slice(2)))\n');
    const previous = process.env['SECOND_LOOK_ENGINE_ENTRY'];
    process.env['SECOND_LOOK_ENGINE_ENTRY'] = echo;
    try {
      const engine = spawnEngineProcess();
      let out = '';
      engine.stdout.on('data', (chunk: Buffer) => {
        out += String(chunk);
      });
      await new Promise<void>((resolve) => engine.once('exit', () => resolve()));
      // The agent, model and account the settings choose travel with each
      // review request over the protocol — never on the command line.
      expect(JSON.parse(out) as string[]).toEqual(['serve']);
    } finally {
      if (previous === undefined) {
        delete process.env['SECOND_LOOK_ENGINE_ENTRY'];
      } else {
        process.env['SECOND_LOOK_ENGINE_ENTRY'] = previous;
      }
    }
  });
});

describe('EngineClient against a fake engine', () => {
  it('starts with a handshake, then reviews a pull request over the protocol', async () => {
    const client = new EngineClient(() => fakeEngine({ result: mixedResult(), logName: 'round-trip.log' }));

    await client.initialize();
    const result = await client.review(PR_URL, TOKEN);

    expect(result.version).toBe(10);
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

  it('presses a library fetch by the claim, with the agent choice, and returns the result with its new verdict', async () => {
    const client = new EngineClient(() => fakeEngine({ fetchResult: fetchedResult(), logName: 'fetch-library.log' }));

    await client.initialize();
    const result = await client.fetchLibrary(PR_URL, 2, { agent: 'pi', model: 'pi/model' });

    expect(result.claims!.claims[2]!.verdict).toMatchObject({ kind: 'refuted', library: { library: 'requests' } });
    const fetch = loggedRequests('fetch-library.log').find((request) => (request as { method: string }).method === 'fetchLibrary') as { params: unknown };
    // A fetch carries no token: it reads nothing from GitHub.
    expect(fetch.params).toEqual({ url: PR_URL, claim: 2, agent: { agent: 'pi', model: 'pi/model' } });
    client.dispose();
  });

  it("reads a fetch's failure, such as a hash mismatch, as the engine's plain message", async () => {
    const message = 'the download of requests-2.32.3-py3-none-any.whl does not match the hash requirements.txt pins';
    const client = new EngineClient(() => fakeEngine({ fetchError: message }));

    await client.initialize();

    await expect(client.fetchLibrary(PR_URL, 2)).rejects.toThrow(message);
    client.dispose();
  });

  it('carries the agent, model and account choice with the review request', async () => {
    const client = new EngineClient(() => fakeEngine({ result: mixedResult(), logName: 'agent-choice.log' }));

    await client.initialize();
    await client.review(PR_URL, TOKEN, { agent: 'claude-code', model: 'sonnet', account: 'Claude Max (work)' });

    const review = loggedRequests('agent-choice.log').find(
      (request) => (request as { method: string }).method === 'review',
    ) as { params: Record<string, unknown> };
    expect(review.params).toEqual({
      url: PR_URL,
      token: TOKEN,
      agent: { agent: 'claude-code', model: 'sonnet', account: 'Claude Max (work)' },
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

  it('gives up on a handshake the engine never answers, with a plain message', async () => {
    vi.useFakeTimers();
    try {
      const engines: ChildProcessWithoutNullStreams[] = [];
      const client = new EngineClient(() => {
        const engine = fakeEngine(
          engines.length === 0
            ? { stallOn: 'initialize', logName: 'stalled-handshake.log' }
            : { logName: 'stalled-handshake.log' },
        );
        engines.push(engine);
        return engine;
      });

      const handshake = client.initialize();
      // Subscribe before the timeout fires: dispose() kills the stalled
      // engine inside the timer callback, and an exit listener attached
      // after the process already died never fires.
      const stalledEngineExited = new Promise<void>((resolve) => {
        engines[0]!.once('exit', () => resolve());
      });
      const timedOut = expect(handshake).rejects.toThrow('the engine did not answer in time');
      await vi.advanceTimersByTimeAsync(10_000);
      await timedOut;

      await stalledEngineExited;
      await client.initialize();
      expect(engines).toHaveLength(2);
      client.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('kills a stalled engine that ignores SIGTERM, so it actually stops', async () => {
    vi.useFakeTimers();
    try {
      const engines: ChildProcessWithoutNullStreams[] = [];
      const client = new EngineClient(() => {
        const engine = fakeEngine({
          stallOn: 'initialize',
          ignoreSigterm: true,
          logName: 'sigterm-proof.log',
        });
        engines.push(engine);
        return engine;
      });

      const handshake = client.initialize();
      // Subscribe before the timeout fires: the signal is only observable
      // on the exit event, and a listener attached after the process died
      // never fires.
      const stalledEngineKilled = new Promise<NodeJS.Signals | null>((resolve) => {
        engines[0]!.once('exit', (_code, signal) => resolve(signal));
      });
      // The engine must be running before the deadline fires, or SIGTERM
      // lands while it is still starting up and kills it before the
      // ignoring handler exists.
      const ignoringSigterm = new Promise<void>((resolve) => {
        engines[0]!.stderr.on('data', (chunk: Buffer) => {
          if (String(chunk).includes('ignoring SIGTERM')) resolve();
        });
      });
      await ignoringSigterm;
      const timedOut = expect(handshake).rejects.toThrow(
        'the engine did not answer in time',
      );
      await vi.advanceTimersByTimeAsync(10_000); // Handshake deadline: SIGTERM, ignored.
      await timedOut;
      await vi.advanceTimersByTimeAsync(2_000); // Grace over: kill it outright.

      expect(await stalledEngineKilled).toBe('SIGKILL');
      client.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('gives up on a review the engine never answers, with a plain message', async () => {
    vi.useFakeTimers();
    try {
      let spawns = 0;
      const client = new EngineClient(() => {
        spawns += 1;
        return fakeEngine({
          result: mixedResult(),
          stallOn: spawns === 1 ? 'review' : undefined,
          logName: 'stalled-review.log',
        });
      });

      await client.initialize();
      const review = client.review(PR_URL, TOKEN);
      const timedOut = expect(review).rejects.toThrow('the engine did not answer in time');
      await vi.advanceTimersByTimeAsync(120_000);
      await timedOut;

      await client.initialize();
      expect(await client.review(PR_URL, TOKEN)).toMatchObject({ version: 10 });
      expect(spawns).toBe(2);
      client.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('hands each stage of a review to its listener, then returns the final result', async () => {
    const plain = mixedResult();
    const final = { ...mixedResult(), grouping: { by: 'plain' } };
    const client = new EngineClient(() =>
      fakeEngine({ result: final, stage: { running: 'grouping related hunks with pi', timeoutMs: 1000, result: plain } }),
    );
    const stages: ReviewStageUpdate[] = [];

    await client.initialize();
    const result = await client.review(PR_URL, TOKEN, undefined, (stage) => stages.push(stage));

    expect(stages).toEqual([{ running: 'grouping related hunks with pi', result: plain }]);
    expect(result).toEqual(final);
    client.dispose();
  });

  it('ignores a stage whose result is not a review result, and still returns the final one', async () => {
    const client = new EngineClient(() =>
      fakeEngine({ result: mixedResult(), stage: { running: 'grouping', timeoutMs: 1000, result: { version: 3 } } }),
    );
    const stages: ReviewStageUpdate[] = [];

    await client.initialize();
    expect(await client.review(PR_URL, TOKEN, undefined, (stage) => stages.push(stage))).toMatchObject({ version: 10 });
    expect(stages).toEqual([]);
    client.dispose();
  });

  it("gives a review the deadline its running stage names, then gives up with a plain message", async () => {
    vi.useFakeTimers();
    try {
      const stage = { running: 'grouping related hunks with pi', timeoutMs: 600_000, result: mixedResult() };
      const client = new EngineClient(() => fakeEngine({ result: mixedResult(), stage, stageOnly: true }));
      await client.initialize();
      let staged!: () => void;
      const stageArrived = new Promise<void>((done) => (staged = done));
      let settled = false;
      const review = client.review(PR_URL, TOKEN, undefined, () => staged());
      review.catch(() => undefined).finally(() => (settled = true));
      await stageArrived;

      // The review's own deadline has passed, but the stage named a longer one.
      await vi.advanceTimersByTimeAsync(120_000);
      expect(settled).toBe(false);

      const timedOut = expect(review).rejects.toThrow('the engine did not answer in time');
      await vi.advanceTimersByTimeAsync(600_000 + 30_000 - 120_000);
      await timedOut;
      client.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});
