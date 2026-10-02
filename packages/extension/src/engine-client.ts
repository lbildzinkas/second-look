import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import {
  ENGINE_PROTOCOL_VERSION,
  INITIALIZE_METHOD,
  REVIEW_METHOD,
  type InitializeResult,
  type ReviewResult,
} from '@second-look/engine';
import { ProtocolError, isReviewResult } from './protocol.js';

/**
 * Creates the engine process this client talks to. Tests inject their own
 * so they can run a fake engine, and the extension injects nothing: it
 * always spawns the engine as a separate local process (ADR 0005).
 */
export type SpawnEngine = () => ChildProcessWithoutNullStreams;

/**
 * Resolves the engine's entry point from the companion's own install, so
 * nothing is ever run out of the reviewer's workspace.
 */
export function engineEntryPath(): string {
  const require = createRequire(import.meta.url);
  const manifest = require.resolve('@second-look/engine/package.json');
  return join(dirname(manifest), 'dist', 'main.js');
}

/**
 * Starts the engine as a separate local process speaking JSON-RPC on stdio.
 *
 * `ELECTRON_RUN_AS_NODE` matters inside the editor: there `process.execPath`
 * is the editor's own binary, which only runs plain Node code when it is
 * told to act as Node. Outside the editor the flag is simply ignored.
 */
export function spawnEngineProcess(): ChildProcessWithoutNullStreams {
  return spawn(process.execPath, [engineEntryPath(), 'serve'], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

interface Pending {
  resolve(result: unknown): void;
  reject(error: Error): void;
}

/** The id of a JSON-RPC response, when the line carries one. */
function responseId(value: unknown): number | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const id = (value as { id?: unknown }).id;
  return typeof id === 'number' ? id : undefined;
}

/** The error message of a JSON-RPC failure, when the response is one. */
function responseError(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const error = (value as { error?: unknown }).error;
  if (typeof error !== 'object' || error === null) return undefined;
  const message = (error as { message?: unknown }).message;
  return typeof message === 'string' ? message : undefined;
}

/** The result of a JSON-RPC success, when the response is one. */
function responseResult(value: unknown): unknown {
  if (typeof value !== 'object' || value === null) return undefined;
  return (value as { result?: unknown }).result;
}

/**
 * The companion's client for the engine: one engine process, started
 * lazily, spoken to over JSON-RPC on stdio, one message per line.
 *
 * The connection starts with a version handshake, and every review request
 * carries its own GitHub token from VS Code's sign-in; the client keeps no
 * token and stores nothing between requests.
 */
export class EngineClient {
  private readonly spawnEngine: SpawnEngine;
  private engine: ChildProcessWithoutNullStreams | undefined;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private handshaken = false;

  constructor(spawnEngine: SpawnEngine = spawnEngineProcess) {
    this.spawnEngine = spawnEngine;
  }

  /** Whether the version handshake has completed on the current engine process. */
  get initialized(): boolean {
    return this.handshaken;
  }

  /**
   * Performs the version handshake the protocol starts with, refusing any
   * engine that speaks another protocol version with its plain message.
   */
  async initialize(): Promise<void> {
    const result = (await this.request(INITIALIZE_METHOD, {
      protocolVersion: ENGINE_PROTOCOL_VERSION,
    })) as InitializeResult;
    if (
      typeof result !== 'object' ||
      result === null ||
      result.protocolVersion !== ENGINE_PROTOCOL_VERSION
    ) {
      throw new Error(
        `the engine answered the handshake with a protocol version this companion cannot read`,
      );
    }
    this.handshaken = true;
  }

  /**
   * Sends one review request with the token VS Code's GitHub sign-in gave
   * for it. The token travels with this request only; the client keeps no
   * copy. Rejects with the engine's plain message when the engine fails.
   */
  async review(url: string, token: string): Promise<ReviewResult> {
    if (!this.handshaken) {
      throw new Error('the engine has not completed its handshake yet');
    }
    const result = await this.request(REVIEW_METHOD, { url, token });
    if (!isReviewResult(result)) {
      throw new ProtocolError();
    }
    return result;
  }

  /** Stops the engine process, if one was started. Safe to call twice. */
  dispose(): void {
    this.failPending(new Error('the engine was stopped'));
    this.engine?.kill();
    this.engine = undefined;
    this.handshaken = false;
  }

  private async request(method: string, params: unknown): Promise<unknown> {
    const engine = this.ensureEngine();
    const id = this.nextId++;
    const message = { jsonrpc: '2.0' as const, id, method, params };
    return new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      engine.stdin.write(`${JSON.stringify(message)}\n`);
    });
  }

  private ensureEngine(): ChildProcessWithoutNullStreams {
    if (this.engine === undefined) {
      this.engine = this.spawnEngine();
      const responses = createInterface({ input: this.engine.stdout });
      responses.on('line', (line) => this.onResponse(line));
      this.engine.stdin.on('error', () => {
        this.failPending(new Error('the engine stopped before answering'));
      });
      this.engine.once('exit', () => {
        this.failPending(new Error('the engine stopped before answering'));
        this.engine = undefined;
        this.handshaken = false;
      });
      this.engine.once('error', (error) => {
        this.failPending(new Error(`the engine could not be started: ${error.message}`));
        this.engine = undefined;
        this.handshaken = false;
      });
    }
    return this.engine;
  }

  private onResponse(line: string): void {
    if (line.trim() === '') {
      return;
    }
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      return; // A line that is not JSON cannot answer a request; ignore it.
    }
    const id = responseId(value);
    if (id === undefined) {
      return;
    }
    const pending = this.pending.get(id);
    if (pending === undefined) {
      return;
    }
    this.pending.delete(id);
    const error = responseError(value);
    if (error !== undefined) {
      pending.reject(new Error(error));
      return;
    }
    pending.resolve(responseResult(value));
  }

  private failPending(error: Error): void {
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }
    this.pending.clear();
  }
}
