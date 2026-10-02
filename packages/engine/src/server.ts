import { reviewPullRequest } from './review.js';
import { sendReview } from './send.js';
import {
  ENGINE_FAILED_CODE,
  ENGINE_PROTOCOL_VERSION,
  INITIALIZE_METHOD,
  JSON_RPC_INVALID_PARAMS,
  JSON_RPC_INVALID_REQUEST,
  JSON_RPC_METHOD_NOT_FOUND,
  JSON_RPC_PARSE_ERROR,
  NOT_INITIALIZED_CODE,
  REVIEW_METHOD,
  SEND_REVIEW_METHOD,
  VERSION_MISMATCH_CODE,
  isRpcRequest,
  redactToken,
  type InitializeParams,
  type ReviewParams,
  type RpcResponse,
  type SendReviewParams,
} from './rpc.js';
/** Where the server reads its lines from: the engine's stdin. */
export interface RpcLineSource {
  /** The next line from the client, or null when the input ends. */
  readLine(): Promise<string | null>;
}

/** Where the server writes its lines to: the engine's stdout. */
export interface RpcLineSink {
  /** Writes one line to the client. */
  writeLine(line: string): void;
}

/** What the server needs besides its streams; tests inject a fake fetch. */
export interface RpcServerDeps {
  /**
   * Fetch implementation the review uses. Tests inject a fixture-backed
   * fetch here so no test ever touches the network.
   */
  fetch?: typeof fetch;
  /** The engine's cache folder, which holds the read-only copies. */
  cacheDir: string;
}

/**
 * Serves the JSON-RPC protocol one line at a time until the input ends.
 *
 * The protocol starts with a version handshake: `initialize` must succeed
 * before any other request, and a client speaking another protocol version
 * is refused with a plain message. `review` then carries the pull request
 * URL and the GitHub token per request, and `sendReview` the pending
 * review the companion gathered — the protocol's one write — submitted as
 * one GitHub review when the reviewer presses send. The token arrives
 * with each request, is used only for that request's GitHub calls, is
 * redacted from every error message, and is never stored.
 */
export async function runRpcServer(
  source: RpcLineSource,
  sink: RpcLineSink,
  deps: RpcServerDeps,
): Promise<void> {
  let initialized = false;
  for (;;) {
    const line = await source.readLine();
    if (line === null) {
      return;
    }
    if (line.trim() === '') {
      continue;
    }

    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      respond(sink, failure(null, JSON_RPC_PARSE_ERROR, 'not JSON: the protocol carries one JSON-RPC message per line'));
      continue;
    }
    if (!isRpcRequest(value)) {
      respond(sink, failure(null, JSON_RPC_INVALID_REQUEST, 'not a JSON-RPC 2.0 request'));
      continue;
    }

    if (value.method === INITIALIZE_METHOD) {
      initialized = initialize(value.params, value.id, sink);
      continue;
    }
    if (value.method === REVIEW_METHOD) {
      await review(value.params, value.id, sink, initialized, deps);
      continue;
    }
    if (value.method === SEND_REVIEW_METHOD) {
      await send(value.params, value.id, sink, initialized, deps);
      continue;
    }
    respond(
      sink,
      failure(
        value.id,
        JSON_RPC_METHOD_NOT_FOUND,
        `unknown method: ${value.method}; this engine speaks ${INITIALIZE_METHOD}, ${REVIEW_METHOD} and ${SEND_REVIEW_METHOD}`,
      ),
    );
  }
}

function initialize(
  params: unknown,
  id: number,
  sink: RpcLineSink,
): boolean {
  if (
    typeof params !== 'object' ||
    params === null ||
    typeof (params as InitializeParams).protocolVersion !== 'number'
  ) {
    respond(
      sink,
      failure(id, JSON_RPC_INVALID_PARAMS, `${INITIALIZE_METHOD} needs params: { "protocolVersion": number }`),
    );
    return false;
  }
  const requested = (params as InitializeParams).protocolVersion;
  if (requested !== ENGINE_PROTOCOL_VERSION) {
    respond(
      sink,
      failure(
        id,
        VERSION_MISMATCH_CODE,
        `protocol version ${requested} is not supported; this engine speaks ${ENGINE_PROTOCOL_VERSION}`,
      ),
    );
    return false;
  }
  respond(sink, { jsonrpc: '2.0', id, result: { protocolVersion: ENGINE_PROTOCOL_VERSION } });
  return true;
}

async function review(
  params: unknown,
  id: number,
  sink: RpcLineSink,
  initialized: boolean,
  deps: RpcServerDeps,
): Promise<void> {
  if (!initialized) {
    respond(
      sink,
      failure(
        id,
        NOT_INITIALIZED_CODE,
        `the protocol starts with a version handshake: ${INITIALIZE_METHOD} before ${REVIEW_METHOD}`,
      ),
    );
    return;
  }
  const { url, token } = (params ?? {}) as Partial<ReviewParams>;
  if (typeof url !== 'string' || url.length === 0 || typeof token !== 'string' || token.length === 0) {
    respond(
      sink,
      failure(id, JSON_RPC_INVALID_PARAMS, `${REVIEW_METHOD} needs params: { "url": string, "token": string }`),
    );
    return;
  }
  try {
    const result = await reviewPullRequest(url, {
      token,
      cacheDir: deps.cacheDir,
      ...(deps.fetch ? { fetch: deps.fetch } : {}),
    });
    respond(sink, { jsonrpc: '2.0', id, result });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    respond(sink, failure(id, ENGINE_FAILED_CODE, redactToken(message, token)));
  }
}

/** The submit kinds the send request accepts, in the glossary's words. */
const SUBMIT_KINDS = ['comment', 'approve', 'request changes'] as const;

/** True when the value is one pending comment the send request accepts. */
function isComment(value: unknown): value is SendReviewParams['review']['comments'][number] {
  if (typeof value !== 'object' || value === null) return false;
  const comment = value as Record<string, unknown>;
  if (comment['kind'] === 'part') {
    return typeof comment['path'] === 'string' && typeof comment['body'] === 'string';
  }
  if (comment['kind'] === 'line') {
    return (
      typeof comment['path'] === 'string' &&
      (comment['side'] === 'base' || comment['side'] === 'head') &&
      typeof comment['line'] === 'number' &&
      Number.isInteger(comment['line']) &&
      comment['line'] >= 1 &&
      typeof comment['body'] === 'string'
    );
  }
  return false;
}

async function send(
  params: unknown,
  id: number,
  sink: RpcLineSink,
  initialized: boolean,
  deps: RpcServerDeps,
): Promise<void> {
  if (!initialized) {
    respond(
      sink,
      failure(
        id,
        NOT_INITIALIZED_CODE,
        `the protocol starts with a version handshake: ${INITIALIZE_METHOD} before ${SEND_REVIEW_METHOD}`,
      ),
    );
    return;
  }
  const { url, token, review } = (params ?? {}) as Partial<SendReviewParams>;
  const valid =
    typeof url === 'string' &&
    url.length > 0 &&
    typeof token === 'string' &&
    token.length > 0 &&
    typeof review === 'object' &&
    review !== null &&
    (SUBMIT_KINDS as readonly string[]).includes(review.submit as string) &&
    (review.body === undefined || typeof review.body === 'string') &&
    Array.isArray(review.comments) &&
    review.comments.every(isComment);
  if (!valid) {
    respond(
      sink,
      failure(
        id,
        JSON_RPC_INVALID_PARAMS,
        `${SEND_REVIEW_METHOD} needs params: { "url": string, "token": string, "review": { "submit": "comment" | "approve" | "request changes", "body"?: string, "comments": [{ "kind": "line", "path": string, "side": "base" | "head", "line": number, "body": string } | { "kind": "part", "path": string, "body": string }] } }`,
      ),
    );
    return;
  }
  try {
    const result = await sendReview(url, review as SendReviewParams['review'], {
      token,
      ...(deps.fetch ? { fetch: deps.fetch } : {}),
    });
    respond(sink, { jsonrpc: '2.0', id, result });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    respond(sink, failure(id, ENGINE_FAILED_CODE, redactToken(message, token)));
  }
}

function failure(id: number | null, code: number, message: string): RpcResponse {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

function respond(sink: RpcLineSink, response: RpcResponse): void {
  sink.writeLine(JSON.stringify(response));
}
