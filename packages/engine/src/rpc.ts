/**
 * The JSON-RPC protocol the extension and the engine speak over stdio
 * (ADR 0005): one JSON-RPC 2.0 message per line, requests from the
 * extension on the engine's stdin, responses on its stdout.
 *
 * The protocol starts with a version handshake: the extension sends
 * {@link INITIALIZE_METHOD} carrying the protocol version it speaks, and
 * the engine either answers with its own {@link ENGINE_PROTOCOL_VERSION}
 * or refuses with a plain message. This version numbers the protocol
 * itself; the review result it carries keeps its own
 * `REVIEW_RESULT_VERSION`.
 *
 * After the handshake, {@link REVIEW_METHOD} reviews a pull request and
 * {@link SEND_REVIEW_METHOD} sends the pending review to GitHub as one
 * review — the protocol's one write, asked for only when the reviewer
 * presses send (ADR 0002). A review request also carries the reviewer's
 * agent choice — which installed agent runs the review's agent passes,
 * with which model — and the reviewer's label for the account it bills,
 * so switching the choice in the editor's settings reaches the next
 * review without restarting the engine.
 */

import type { AgentName } from './agents.js';
import type { PendingReview, ReviewResult, SentReview } from './protocol.js';

/** Version of the JSON-RPC protocol between the extension and the engine. */
export const ENGINE_PROTOCOL_VERSION = 1 as const;

/** The version the engine and the extension both speak. */
export type EngineProtocolVersion = typeof ENGINE_PROTOCOL_VERSION;

/** Reserved JSON-RPC error codes the engine answers with. */
export const JSON_RPC_PARSE_ERROR = -32700 as const;
/** The request was not a JSON-RPC 2.0 request object. */
export const JSON_RPC_INVALID_REQUEST = -32600 as const;
/** The method exists but the params do not fit it. */
export const JSON_RPC_INVALID_PARAMS = -32602 as const;
/** The method does not exist. */
export const JSON_RPC_METHOD_NOT_FOUND = -32601 as const;

/** Engine-defined error codes in JSON-RPC's server-error range. */
export const VERSION_MISMATCH_CODE = -32000 as const;
/** A request arrived before the version handshake completed. */
export const NOT_INITIALIZED_CODE = -32001 as const;
/** The engine failed to produce a result; the message is plain and redacted. */
export const ENGINE_FAILED_CODE = -32002 as const;

/** One request the extension sends. */
export interface RpcRequest<P = unknown> {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params?: P;
}

/** A JSON-RPC error object, with a plain message and no data payload. */
export interface RpcError {
  code: number;
  message: string;
}

/** A successful response to the request with the matching id. */
export interface RpcSuccess<R = unknown> {
  jsonrpc: '2.0';
  id: number | null;
  result: R;
}

/** A failed response to the request with the matching id. */
export interface RpcFailure {
  jsonrpc: '2.0';
  id: number | null;
  error: RpcError;
}

/** Any response the engine writes. */
export type RpcResponse<R = unknown> = RpcSuccess<R> | RpcFailure;

/** The handshake request; the protocol starts with it. */
export const INITIALIZE_METHOD = 'initialize' as const;

/** Carries the protocol version the client speaks. */
export interface InitializeParams {
  protocolVersion: number;
}

/** Carries the protocol version the engine speaks. */
export interface InitializeResult {
  protocolVersion: EngineProtocolVersion;
}

/** The request that reviews one pull request. */
export const REVIEW_METHOD = 'review' as const;

/**
 * The agent choice a review request carries: which installed agent runs
 * the review's agent passes, the model it runs and the reviewer's label
 * for the account it bills (issue 65). It mirrors the editor's agent
 * settings; absent from a request, the engine's serve-time choice stands.
 */
export interface ReviewAgentChoice {
  /** The agent that runs every pass of the review: `pi` or `claude-code`. */
  agent: AgentName;
  /** The model to ask for; empty or absent is the agent's own default. */
  model?: string;
  /** The reviewer's label for the account or subscription the runs bill; empty or absent when unlabelled. */
  account?: string;
}

/** One review request; the token travels with the request, never stored. */
export interface ReviewParams {
  /** The pull request's HTML URL. */
  url: string;
  /**
   * The GitHub token for this one request, which the extension obtains
   * from VS Code's GitHub sign-in. The engine uses it only for the GitHub
   * request and never stores or echoes it.
   */
  token: string;
  /** The agent, model and account the review's agent passes run with; see {@link ReviewAgentChoice}. */
  agent?: ReviewAgentChoice;
}

/** The review request's result: the engine's typed, versioned review result. */
export type ReviewRpcResult = ReviewResult;

/** The request that sends the pending review to GitHub as one review. */
export const SEND_REVIEW_METHOD = 'sendReview' as const;

/** One send request; the token travels with the request, never stored. */
export interface SendReviewParams {
  /** The pull request's HTML URL. */
  url: string;
  /**
   * The GitHub token for this one request, which the extension obtains
   * from VS Code's GitHub sign-in when the reviewer presses send. The
   * engine uses it only for the GitHub request and never stores or echoes
   * it.
   */
  token: string;
  /** The pending review the companion gathered, sent as it stands. */
  review: PendingReview;
}

/** The send request's result: the review's link on GitHub. */
export type SendReviewRpcResult = SentReview;

/**
 * The notification the engine sends while a review request is still
 * running: the result so far is ready and a further stage, such as the
 * agent grouping the hunks or ranking the parts, has started. The review's response then
 * carries the final result. A JSON-RPC notification has no id of its own;
 * its params name the review request it belongs to.
 */
export const REVIEW_STAGE_METHOD = 'review/stage' as const;

/** One stage notification's params. */
export interface ReviewStageParams {
  /** The id of the review request this stage belongs to. */
  id: number;
  /** The stage now running, in words for the reviewer. */
  running: string;
  /** The stage ends within this many milliseconds. */
  timeoutMs: number;
  /** The result so far. */
  result: ReviewResult;
}

/** A notification the engine writes: no id, a method and its params. */
export interface RpcNotification<P = unknown> {
  jsonrpc: '2.0';
  method: string;
  params: P;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Checks that a line from the client is a JSON-RPC 2.0 request. The engine
 * and the extension share the protocol types, so this guard only proves
 * what JSON cannot: that the bytes really carry that shape.
 */
export function isRpcRequest(value: unknown): value is RpcRequest {
  if (!isRecord(value)) return false;
  if (value['jsonrpc'] !== '2.0') return false;
  if (typeof value['id'] !== 'number' || !Number.isInteger(value['id'])) return false;
  if (typeof value['method'] !== 'string' || value['method'].length === 0) return false;
  return value['params'] === undefined || isRecord(value['params']);
}

/** Replaces every occurrence of the token so no output can leak it. */
export function redactToken(text: string, token: string | undefined): string {
  if (!token) {
    return text;
  }
  return text.split(token).join('[REDACTED]');
}
