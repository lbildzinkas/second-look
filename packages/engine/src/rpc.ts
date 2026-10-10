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
 * After the handshake, {@link REVIEW_METHOD} reviews a pull request,
 * {@link FETCH_LIBRARY_METHOD} presses one finding's library fetch,
 * {@link DRAFT_COMMENT_METHOD} drafts a comment from one finding,
 * {@link ASK_METHOD} answers one ask about one part,
 * {@link SEND_REVIEW_METHOD} sends the pending review to GitHub as one
 * review — the protocol's one write of the review, asked for only when the
 * reviewer presses send (ADR 0002) — {@link REVIEWED_MARKS_METHOD} and
 * {@link MARK_REVIEWED_METHOD} read and change the reviewed marks in the
 * pull request's local store, and {@link MARK_VIEWED_METHOD} marks files
 * "Viewed" on GitHub when the reviewer's opt-in setting mirrors them. A review request also carries the reviewer's
 * agent choice — which installed agent runs the review's agent passes,
 * with which model — and the reviewer's label for the account it bills,
 * so switching the choice in the editor's settings reaches the next
 * review without restarting the engine. {@link PROBE_AGENTS_METHOD}
 * reports each agent the companion can drive as installed here, without
 * running a model, so the editor can offer only what will run.
 */

import type { AgentProbe } from './agent.js';
import type { AgentName } from './agents.js';
import type { AskKind } from './asks.js';
import type { AskAnswer, AskedClaim, BudgetLimits, DraftComment, FindingRef, PendingReview, ReviewedMarks, ReviewResult, SentReview, ViewedFiles } from './protocol.js';
import type { MarkedPart } from './reviewed-marks.js';

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

/**
 * The request that reports the installed agents (issue 131): each agent
 * the companion can drive, probed as a review would start it — its
 * version, whether the lockdown is available and why not, the effort
 * levels its own help lists, and for Claude Code the login it would use.
 * Nothing runs a model, and no login is read.
 */
export const PROBE_AGENTS_METHOD = 'agents/probe' as const;

/**
 * The reviewer's path settings: for each agent, the executable that
 * replaces its command, as an absolute path; empty or absent starts the
 * command found on the PATH the engine started with.
 */
export type AgentPaths = Partial<Record<AgentName, string>>;

/** One probe request: the path settings the probe starts each agent with. */
export interface ProbeAgentsParams {
  paths?: AgentPaths;
}

/** The probe request's result: one probe per agent, in the order the settings offer them. */
export interface ProbeAgentsRpcResult {
  agents: (AgentProbe & { agent: AgentName })[];
}

/** The request that reviews one pull request. */
export const REVIEW_METHOD = 'review' as const;

/**
 * The agent choice a review request carries: which installed agent runs
 * the review's agent passes, the model it runs, the effort level it runs
 * at (issue 121), the reviewer's label for the account it bills (issue 65)
 * and the path that starts it (issue 131). It mirrors the editor's agent
 * settings; absent from a request, the engine's serve-time choice stands.
 */
export interface ReviewAgentChoice {
  /** The agent that runs every pass of the review: `pi` or `claude-code`. */
  agent: AgentName;
  /** The model to ask for, a plain name; empty or absent is the agent's own default. */
  model?: string;
  /**
   * The effort level to ask for, one the agent accepts; empty or absent is the agent's own default.
   * A model or effort that is not a plain identifier, or an effort the agent does not accept, is
   * refused before any agent starts (see `modelAndEffortProblem`).
   */
  effort?: string;
  /** The reviewer's label for the account or subscription the runs bill; empty or absent when unlabelled. */
  account?: string;
  /** The absolute path of the executable that replaces the agent's command; empty or absent starts the one on the PATH. */
  path?: string;
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
  /** The agent, model, effort and account the review's agent passes run with; see {@link ReviewAgentChoice}. */
  agent?: ReviewAgentChoice;
  /**
   * The heading the acceptance criteria checklist sits under in a linked
   * issue, mirroring the editor's setting; absent reads the default,
   * "Acceptance criteria". A heading that is present must be a
   * non-empty string: an empty or blank one is refused.
   */
  criteriaHeading?: string;
  /**
   * The budget's limits, mirroring the editor's settings, each 0 for no
   * limit; absent limits nothing. The engine meters the review against
   * them — counting only, nothing is refused yet — and the result carries
   * the use so far.
   */
  budget?: BudgetLimits;
}

/** The review request's result: the engine's typed, versioned review result. */
export type ReviewRpcResult = ReviewResult;

/**
 * The request that presses one claim's library fetch, sent only when the
 * reviewer presses it (ADR 0003): the engine downloads the library the
 * offer names — the exact file the project pins, or the tag the agent
 * named — checks its hash where one is recorded, unpacks it read-only
 * and has the agent judge the claim again in its source. The claim is
 * one of the engine's own latest review of the pull request, by its
 * index.
 */
export const FETCH_LIBRARY_METHOD = 'fetchLibrary' as const;

/** One fetch request: the reviewed pull request, the claim and the agent that judges it again. */
export interface FetchLibraryParams {
  /** The pull request's HTML URL, as the review result names it. */
  url: string;
  /** The claim, by its index in the result's claims. */
  claim: number;
  /** The agent, model, effort and account that judge the claim again; see {@link ReviewAgentChoice}. */
  agent?: ReviewAgentChoice;
}

/** The fetch request's result: the review result with the claim judged against the library's source. */
export type FetchLibraryRpcResult = ReviewResult;

/**
 * The request that drafts a comment from one finding, sent only when the
 * reviewer asks for it: the agent writes a short draft from the finding
 * and its evidence, and the engine checks it before answering. The
 * finding is one of the engine's own latest review of the pull request.
 * The draft reaches GitHub only if the reviewer adds it to the pending
 * review and sends that (ADR 0002).
 */
export const DRAFT_COMMENT_METHOD = 'draftComment' as const;

/** One draft request: the reviewed pull request, the finding and the agent that drafts. */
export interface DraftCommentParams {
  /** The pull request's HTML URL, as the review result names it. */
  url: string;
  finding: FindingRef;
  /** The agent, model, effort and account that draft; see {@link ReviewAgentChoice}. */
  agent?: ReviewAgentChoice;
}

/** The draft request's result: the checked draft. */
export type DraftCommentRpcResult = DraftComment;

/**
 * The request that answers one ask about one part, sent only when the
 * reviewer makes it: the agent answers, and the engine checks the answer
 * before sending it. The part is one of the engine's own latest review
 * of the pull request. Nothing of it reaches GitHub.
 */
export const ASK_METHOD = 'ask' as const;

/** One ask: the reviewed pull request, the ask, the part and the agent that answers. */
export interface AskParams {
  /** The pull request's HTML URL, as the review result names it. */
  url: string;
  ask: AskKind;
  /** The part, by its index in the review result's parts. */
  part: number;
  /** The claim to verify, for an ask that takes one: one of the part's claims, or the reviewer's selection in its diff. */
  claim?: AskedClaim;
  /** The agent, model, effort and account that answer; see {@link ReviewAgentChoice}. */
  agent?: ReviewAgentChoice;
}

/** The ask request's result: the checked answer; a verify ask's judged claim is in the engine's latest review too. */
export type AskRpcResult = AskAnswer;

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

/** The request that reads a pull request's reviewed marks from its local store. */
export const REVIEWED_MARKS_METHOD = 'reviewedMarks' as const;

/** One marks request: the pull request whose marks to read. */
export interface ReviewedMarksParams {
  /** The pull request's HTML URL. */
  url: string;
}

/** The marks request's result: the marks as the store holds them. */
export type ReviewedMarksRpcResult = ReviewedMarks;

/**
 * The request that ticks or clears one part's reviewed checkbox in the
 * pull request's local store, keyed by the part's content hash, which the
 * engine computes from the part's pieces.
 */
export const MARK_REVIEWED_METHOD = 'markReviewed' as const;

/** One mark request: the pull request, the part and whether it is now reviewed. */
export interface MarkReviewedParams {
  /** The pull request's HTML URL. */
  url: string;
  /** The part: its identity — its name with its files and entity kinds — and the content hashes of its pieces. */
  part: MarkedPart;
  /** True to tick the part's checkbox, false to clear it. */
  reviewed: boolean;
}

/** The mark request's result: the marks as they now stand. */
export type MarkReviewedRpcResult = ReviewedMarks;

/**
 * The request that marks whole files "Viewed" on GitHub, sent only when
 * the reviewer's opt-in setting mirrors the reviewed marks there, and only
 * for files whose every part is reviewed. Nothing is unmarked.
 */
export const MARK_VIEWED_METHOD = 'markViewed' as const;

/** One mirror request; the token travels with the request, never stored. */
export interface MarkViewedParams {
  /** The pull request's HTML URL. */
  url: string;
  /** The GitHub token for this one request, from VS Code's GitHub sign-in. */
  token: string;
  /** The files to mark, by their paths in the pull request. */
  paths: string[];
}

/** The mirror request's result: the files marked. */
export type MarkViewedRpcResult = ViewedFiles;

/**
 * The notification the engine sends while a review request is still
 * running: the result so far is ready and a further stage, such as the
 * agent grouping the hunks, ranking the parts, writing the story, comparing the change with its description and issues, listing the claims or judging them, has started. The review's response then
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
