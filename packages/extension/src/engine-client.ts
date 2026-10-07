import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import {
  ASK_METHOD,
  DRAFT_COMMENT_METHOD,
  ENGINE_PROTOCOL_VERSION,
  FETCH_LIBRARY_METHOD,
  INITIALIZE_METHOD,
  MARK_REVIEWED_METHOD,
  MARK_VIEWED_METHOD,
  REVIEWED_MARKS_METHOD,
  REVIEW_METHOD,
  REVIEW_STAGE_METHOD,
  SEND_REVIEW_METHOD,
  type AskAnswer,
  type AskedClaim,
  type AskKind,
  type DraftComment,
  type FindingRef,
  type InitializeResult,
  type MarkedPart,
  type PendingReview,
  type ReviewAgentChoice,
  type ReviewedMarks,
  type ReviewResult,
  type SentReview,
  type ViewedFiles,
} from '@second-look/engine';
import {
  AskProtocolError,
  DraftProtocolError,
  MarksProtocolError,
  ProtocolError,
  SendProtocolError,
  isAskAnswer,
  isDraftComment,
  isReviewResult,
  isReviewedMarks,
  isSentReview,
  isViewedFiles,
} from './protocol.js';

/**
 * Creates the engine process this client talks to. Tests inject their own
 * so they can run a fake engine, and the extension injects nothing: it
 * always spawns the engine as a separate local process (ADR 0005).
 */
export type SpawnEngine = () => ChildProcessWithoutNullStreams;

/** The environment variable through which the real-host test substitutes its fake engine. */
const ENGINE_ENTRY_ENV = 'SECOND_LOOK_ENGINE_ENTRY';

/**
 * Resolves the engine's entry point from the companion's own install, so
 * nothing is ever run out of the reviewer's workspace. The real-host test
 * names its fake engine here — no real install ever sets this — because it
 * rides the extension's one real activation, whose engine spawn starts
 * from this same resolution.
 */
export function engineEntryPath(): string {
  const entry = process.env[ENGINE_ENTRY_ENV];
  if (entry !== undefined && entry !== '') {
    return entry;
  }
  const require = createRequire(import.meta.url);
  const manifest = require.resolve('@second-look/engine/package.json');
  return join(dirname(manifest), 'dist', 'main.js');
}

/**
 * Starts the engine as a separate local process speaking JSON-RPC on stdio.
 *
 * The agent, model and account the settings choose travel with each
 * review request over the protocol, never on the command line, so a
 * settings change reaches the next review without restarting the engine.
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

/** How long the version handshake may take before the engine is given up on. */
const HANDSHAKE_TIMEOUT_MS = 10_000;

/** How long one review request may take before the engine is given up on. */
const REVIEW_TIMEOUT_MS = 120_000;

/** How long one library fetch may take, its download and the agent judging the claim again. */
const FETCH_LIBRARY_TIMEOUT_MS = 900_000;

/** How long one draft may take: the agent's probe, and its run with its one retry. */
const DRAFT_COMMENT_TIMEOUT_MS = 720_000;

/** How long one ask may take: the agent's probe, and its run with its one retry. */
const ASK_TIMEOUT_MS = 720_000;

/** How long one send request may take before the engine is given up on. */
const SEND_REVIEW_TIMEOUT_MS = 60_000;

/** How long reading or changing the reviewed marks in the local store may take. */
const MARKS_TIMEOUT_MS = 10_000;

/** How long marking files "Viewed" on GitHub may take before the engine is given up on. */
const MARK_VIEWED_TIMEOUT_MS = 60_000;

/** How long a stalled engine gets to die from SIGTERM before it is killed outright. */
const KILL_GRACE_MS = 2_000;

/** What a review stage notification gives on top of the deadline the engine names for its stage. */
const STAGE_GRACE_MS = 30_000;

/** A review stage starting: the stage now running, and the result so far. */
export interface ReviewStageUpdate {
  /** The stage now running, in words for the reviewer. */
  running: string;
  result: ReviewResult;
}

interface Pending {
  resolve(result: unknown): void;
  reject(error: Error): void;
  /** Clears the deadline when the request settles before it. */
  timer: ReturnType<typeof setTimeout>;
  /** Moves the deadline: a stage notification names how long its stage may take. */
  restart(timeoutMs: number): void;
  /** Hears each stage notification of a review request. */
  onStage?: (stage: ReviewStageUpdate) => void;
}

/**
 * The stage a notification announces, when the line is a review stage
 * notification carrying a review result of the version this extension
 * reads; anything else is not one.
 */
function stageNotification(
  value: unknown,
): (ReviewStageUpdate & { id: number; timeoutMs: number }) | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const { method, params } = value as { method?: unknown; params?: unknown };
  if (method !== REVIEW_STAGE_METHOD || typeof params !== 'object' || params === null) return undefined;
  const { id, running, timeoutMs, result } = params as Record<string, unknown>;
  if (typeof id !== 'number' || typeof running !== 'string') return undefined;
  if (typeof timeoutMs !== 'number' || !(timeoutMs > 0) || !isReviewResult(result)) return undefined;
  return { id, running, timeoutMs, result };
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
 * token and stores nothing between requests. Every request has a deadline:
 * an engine that stays silent past it is stopped, its failure reads as a
 * plain message, and the next request starts a fresh engine.
 */
export class EngineClient {
  private readonly spawnEngine: SpawnEngine;
  private engine: ChildProcessWithoutNullStreams | undefined;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private handshaken = false;

  constructor(spawnEngine: SpawnEngine) {
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
    const result = (await this.request(
      INITIALIZE_METHOD,
      { protocolVersion: ENGINE_PROTOCOL_VERSION },
      HANDSHAKE_TIMEOUT_MS,
    )) as InitializeResult;
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
   * for it, the agent choice the settings picked and the heading the
   * acceptance criteria checklist sits under: the agent, model, account
   * and heading travel with this request only; the client keeps no copy
   * of the token. Rejects with the engine's plain message when the engine
   * fails.
   *
   * A review can arrive in stages: each stage notification hands its
   * result so far to `onStage` and gives the request the stage's own
   * deadline; the returned result is the final one.
   */
  async review(
    url: string,
    token: string,
    agent?: ReviewAgentChoice,
    onStage?: (stage: ReviewStageUpdate) => void,
    criteriaHeading?: string,
  ): Promise<ReviewResult> {
    if (!this.handshaken) {
      throw new Error('the engine has not completed its handshake yet');
    }
    // The heading names a checklist only once trimmed to something; an
    // empty one stays off the request, and the engine reads its default.
    const heading = criteriaHeading?.trim();
    const result = await this.request(
      REVIEW_METHOD,
      {
        url,
        token,
        ...(agent !== undefined ? { agent } : {}),
        ...(heading !== undefined && heading !== '' ? { criteriaHeading: heading } : {}),
      },
      REVIEW_TIMEOUT_MS,
      onStage,
    );
    if (!isReviewResult(result)) {
      throw new ProtocolError();
    }
    return result;
  }

  /**
   * Presses one claim's library fetch, sent only when the reviewer presses
   * it: the engine downloads the library its latest review of the pull
   * request offers, at its pinned version or the tag the agent named,
   * checks its hash where one is recorded, unpacks it read-only and has
   * the agent the settings picked judge the claim again. Resolves with the
   * review result holding the new verdict; rejects with the engine's plain
   * message, such as a hash mismatch.
   */
  async fetchLibrary(url: string, claim: number, agent?: ReviewAgentChoice): Promise<ReviewResult> {
    if (!this.handshaken) {
      throw new Error('the engine has not completed its handshake yet');
    }
    const result = await this.request(
      FETCH_LIBRARY_METHOD,
      { url, claim, ...(agent !== undefined ? { agent } : {}) },
      FETCH_LIBRARY_TIMEOUT_MS,
    );
    if (!isReviewResult(result)) {
      throw new ProtocolError();
    }
    return result;
  }

  /**
   * Drafts a comment from one finding, sent only when the reviewer asks
   * for it: the engine has the agent the settings picked write a short
   * draft from the finding of its latest review of the pull request, and
   * checks it. Resolves with the draft, which nothing sends; rejects with
   * the engine's plain message, such as a draft the checks refused twice.
   */
  async draftComment(url: string, finding: FindingRef, agent?: ReviewAgentChoice): Promise<DraftComment> {
    if (!this.handshaken) {
      throw new Error('the engine has not completed its handshake yet');
    }
    const result = await this.request(
      DRAFT_COMMENT_METHOD,
      { url, finding, ...(agent !== undefined ? { agent } : {}) },
      DRAFT_COMMENT_TIMEOUT_MS,
    );
    if (!isDraftComment(result)) {
      throw new DraftProtocolError();
    }
    return result;
  }

  /**
   * Asks one ask about one part, sent only when the reviewer makes it:
   * the engine has the agent the settings picked answer about the part of
   * its latest review of the pull request, and checks the answer; a
   * verify ask carries the claim the reviewer picked or selected.
   * Resolves with the answer; rejects with the engine's plain message,
   * such as an answer the checks refused twice.
   */
  async ask(url: string, ask: AskKind, part: number, agent?: ReviewAgentChoice, claim?: AskedClaim): Promise<AskAnswer> {
    if (!this.handshaken) {
      throw new Error('the engine has not completed its handshake yet');
    }
    const params = { url, ask, part, ...(claim !== undefined ? { claim } : {}), ...(agent !== undefined ? { agent } : {}) };
    const result = await this.request(ASK_METHOD, params, ASK_TIMEOUT_MS);
    if (!isAskAnswer(result)) {
      throw new AskProtocolError();
    }
    return result;
  }

  /**
   * Sends one review request: the pending review, submitted to GitHub as
   * one review with the token VS Code's GitHub sign-in gave for the send.
   * The token travels with this request only; the client keeps no copy.
   * Rejects with the engine's plain message when the send fails.
   */
  async sendReview(url: string, token: string, review: PendingReview): Promise<SentReview> {
    if (!this.handshaken) {
      throw new Error('the engine has not completed its handshake yet');
    }
    const result = await this.request(
      SEND_REVIEW_METHOD,
      { url, token, review },
      SEND_REVIEW_TIMEOUT_MS,
    );
    if (!isSentReview(result)) {
      throw new SendProtocolError();
    }
    return result;
  }

  /** Reads the pull request's reviewed marks from the engine's local store. */
  async reviewedMarks(url: string): Promise<ReviewedMarks> {
    if (!this.handshaken) {
      throw new Error('the engine has not completed its handshake yet');
    }
    const result = await this.request(REVIEWED_MARKS_METHOD, { url }, MARKS_TIMEOUT_MS);
    if (!isReviewedMarks(result)) {
      throw new MarksProtocolError();
    }
    return result;
  }

  /**
   * Ticks or clears one part's reviewed checkbox in the engine's local
   * store. Resolves with the marks as they now stand.
   */
  async markReviewed(url: string, part: MarkedPart, reviewed: boolean): Promise<ReviewedMarks> {
    if (!this.handshaken) {
      throw new Error('the engine has not completed its handshake yet');
    }
    const result = await this.request(MARK_REVIEWED_METHOD, { url, part, reviewed }, MARKS_TIMEOUT_MS);
    if (!isReviewedMarks(result)) {
      throw new MarksProtocolError();
    }
    return result;
  }

  /**
   * Marks whole files "Viewed" on GitHub for the reviewer's opt-in mirror,
   * with the token VS Code's GitHub sign-in gave; the engine marks only the
   * files whose every part is reviewed. Resolves with the files marked.
   */
  async markViewed(url: string, token: string, paths: string[]): Promise<ViewedFiles> {
    if (!this.handshaken) {
      throw new Error('the engine has not completed its handshake yet');
    }
    const result = await this.request(MARK_VIEWED_METHOD, { url, token, paths }, MARK_VIEWED_TIMEOUT_MS);
    if (!isViewedFiles(result)) {
      throw new MarksProtocolError();
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

  private async request(
    method: string,
    params: unknown,
    timeoutMs: number,
    onStage?: (stage: ReviewStageUpdate) => void,
  ): Promise<unknown> {
    const engine = this.ensureEngine();
    const id = this.nextId++;
    const message = { jsonrpc: '2.0' as const, id, method, params };
    return new Promise<unknown>((resolve, reject) => {
      const expire = (): void => {
        this.pending.delete(id);
        reject(new Error('the engine did not answer in time'));
        this.dispose();
        // SIGTERM takes no effect on a stopped process, so a stalled engine
        // can linger past the stop above: kill it outright if it lingers.
        const killer = setTimeout(() => {
          if (engine.exitCode === null && engine.signalCode === null) {
            engine.kill('SIGKILL');
          }
        }, KILL_GRACE_MS);
        engine.once('exit', () => clearTimeout(killer));
      };
      const pending: Pending = {
        resolve,
        reject,
        timer: setTimeout(expire, timeoutMs),
        restart: (stageTimeoutMs) => {
          clearTimeout(pending.timer);
          pending.timer = setTimeout(expire, stageTimeoutMs);
        },
        ...(onStage ? { onStage } : {}),
      };
      this.pending.set(id, pending);
      engine.stdin.write(`${JSON.stringify(message)}\n`);
    });
  }

  private ensureEngine(): ChildProcessWithoutNullStreams {
    if (this.engine === undefined) {
      const engine = this.spawnEngine();
      this.engine = engine;
      const responses = createInterface({ input: engine.stdout });
      responses.on('line', (line) => this.onResponse(line));
      engine.stdin.on('error', () => {
        if (this.engine !== engine) return;
        this.failPending(new Error('the engine stopped before answering'));
      });
      engine.once('exit', () => {
        if (this.engine !== engine) return;
        this.failPending(new Error('the engine stopped before answering'));
        this.engine = undefined;
        this.handshaken = false;
      });
      engine.once('error', (error) => {
        if (this.engine !== engine) return;
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
    const stage = stageNotification(value);
    if (stage !== undefined) {
      const pending = this.pending.get(stage.id);
      if (pending?.onStage === undefined) return;
      pending.restart(stage.timeoutMs + STAGE_GRACE_MS);
      pending.onStage({ running: stage.running, result: stage.result });
      return;
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
    clearTimeout(pending.timer);
    const error = responseError(value);
    if (error !== undefined) {
      pending.reject(new Error(error));
      return;
    }
    pending.resolve(responseResult(value));
  }

  private failPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}
