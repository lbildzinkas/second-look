import { join } from 'node:path';
import { DEFAULT_AGENT_SETTINGS, type AgentAdapter, type AgentSettings } from './agent.js';
import { AGENT_NAMES, isAgentName, type AgentName } from './agents.js';
import { pullRequestCacheDir } from './cache.js';
import { parsePullRequestUrl } from './github.js';
import { pressLibraryFetch } from './library-verdicts.js';
import type { ReviewResult } from './protocol.js';
import { reviewPullRequest } from './review.js';
import { sendReview } from './send.js';
import type { TestedRanking } from './ranking.js';
import {
  ENGINE_FAILED_CODE,
  ENGINE_PROTOCOL_VERSION,
  FETCH_LIBRARY_METHOD,
  INITIALIZE_METHOD,
  JSON_RPC_INVALID_PARAMS,
  JSON_RPC_INVALID_REQUEST,
  JSON_RPC_METHOD_NOT_FOUND,
  JSON_RPC_PARSE_ERROR,
  NOT_INITIALIZED_CODE,
  REVIEW_METHOD,
  REVIEW_STAGE_METHOD,
  SEND_REVIEW_METHOD,
  VERSION_MISMATCH_CODE,
  isRpcRequest,
  redactToken,
  type FetchLibraryParams,
  type InitializeParams,
  type ReviewAgentChoice,
  type ReviewParams,
  type ReviewStageParams,
  type RpcNotification,
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

/**
 * What the review requests' agent passes need: how to start each agent a
 * request may name, and the settings they run with when it names none.
 */
export interface RpcAgentDeps {
  /**
   * Starts the adapter for the agent a review names. The engine probes
   * the adapter before any run, so an agent that is not installed is
   * never run and its probe says so in plain words.
   */
  adapterFor: (name: AgentName) => AgentAdapter;
  /** The agent that reviews when a request carries no choice. */
  defaultAgent: AgentName;
  /** The settings the passes run with; a request's choice replaces their model and account. */
  settings?: AgentSettings;
  /** Where the agent ranking is the default; the engine's tested rankings when absent. */
  testedRankings?: readonly TestedRanking[];
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
  /**
   * The agents that group and rank the parts, write the story, and list and judge the claims after the plain pass;
   * without one, the plain result is the review's only answer.
   */
  agent?: RpcAgentDeps;
}

/**
 * Serves the JSON-RPC protocol one line at a time until the input ends
 * and every request it accepted has been answered.
 *
 * Requests are answered as they arrive, not one after another: a review
 * with an agent stage stays open for minutes by design, and a sendReview
 * or any other request that arrives meanwhile is answered alongside it,
 * each response carrying the id of its own request.
 *
 * The protocol starts with a version handshake: `initialize` must succeed
 * before any other request, and a client speaking another protocol version
 * is refused with a plain message. `review` then carries the pull request
 * URL, the GitHub token and — when the client's settings chose one — the
 * agent, model and account that run the review's agent passes; a request
 * without a choice runs the engine's serve-time default. `sendReview`
 * carries the pending review the companion gathered — the protocol's one
 * write — submitted as one GitHub review when the reviewer presses send.
 * The token arrives with each request, is used only for that request's
 * GitHub calls, is redacted from every error message, and is never
 * stored. `fetchLibrary` presses one claim's library fetch, only when the
 * reviewer presses it: the engine keeps each pull request's latest review
 * result, so the claim is named by its index there, and answers with that
 * result, the claim judged again against the library's source.
 *
 * With an agent, a review arrives in stages: as soon as the plain result
 * is ready the engine sends it in a {@link REVIEW_STAGE_METHOD}
 * notification naming the stage that runs next, then the grouped result
 * in another while the agent ranks, then the ranked result in another
 * while the agent writes the story, then the result with the story in
 * another while the agent lists the claims, then the result with the
 * claims in another while the agent judges them, and the review's
 * response carries the result with the agent's parts, ranking, story and
 * judged claims, or the plain parts and ranking with the reason they
 * stayed.
 */
export async function runRpcServer(
  source: RpcLineSource,
  sink: RpcLineSink,
  deps: RpcServerDeps,
): Promise<void> {
  let initialized = false;
  const running: Promise<void>[] = [];
  /** Each pull request's latest review result, by its URL, for the fetches it offers. */
  const reviews = new Map<string, ReviewResult>();
  for (;;) {
    const line = await source.readLine();
    if (line === null) {
      await Promise.all(running);
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
      running.push(review(value.params, value.id, sink, initialized, deps, reviews));
      continue;
    }
    if (value.method === FETCH_LIBRARY_METHOD) {
      running.push(fetchLibrary(value.params, value.id, sink, initialized, deps, reviews));
      continue;
    }
    if (value.method === SEND_REVIEW_METHOD) {
      running.push(send(value.params, value.id, sink, initialized, deps));
      continue;
    }
    respond(
      sink,
      failure(
        value.id,
        JSON_RPC_METHOD_NOT_FOUND,
        `unknown method: ${value.method}; this engine speaks ${INITIALIZE_METHOD}, ${REVIEW_METHOD}, ${FETCH_LIBRARY_METHOD} and ${SEND_REVIEW_METHOD}`,
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

/** Why a review's agent choice is not one the engine can run, in plain words; absent when it is. */
function agentChoiceProblem(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) return 'the agent choice must be an object';
  const choice = value as Record<string, unknown>;
  if (typeof choice['agent'] !== 'string' || !isAgentName(choice['agent'])) {
    return `the agent choice names an agent the engine cannot drive: choose ${AGENT_NAMES.join(' or ')}`;
  }
  if (choice['model'] !== undefined && typeof choice['model'] !== 'string') {
    return 'the agent choice model must be a string';
  }
  if (choice['account'] !== undefined && typeof choice['account'] !== 'string') {
    return 'the agent choice account must be a string';
  }
  return undefined;
}

/**
 * The settings a review's agent passes run with: the engine's own, with
 * the request's model and account replacing theirs when it carries a
 * choice — an empty model asks for the agent's own default, an empty
 * account leaves the runs unlabelled.
 */
function agentRunSettings(
  agent: RpcAgentDeps,
  choice: ReviewAgentChoice | undefined,
): AgentSettings {
  const settings: AgentSettings = { ...DEFAULT_AGENT_SETTINGS, ...agent.settings };
  if (choice === undefined) return settings;
  if (choice.model === undefined || choice.model === '') delete settings.model;
  else settings.model = choice.model;
  if (choice.account === undefined || choice.account === '') delete settings.account;
  else settings.account = choice.account;
  return settings;
}

async function review(
  params: unknown,
  id: number,
  sink: RpcLineSink,
  initialized: boolean,
  deps: RpcServerDeps,
  reviews: Map<string, ReviewResult>,
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
  const { url, token, agent: choice, criteriaHeading } = (params ?? {}) as Partial<ReviewParams>;
  if (typeof url !== 'string' || url.length === 0 || typeof token !== 'string' || token.length === 0) {
    respond(
      sink,
      failure(
        id,
        JSON_RPC_INVALID_PARAMS,
        `${REVIEW_METHOD} needs params: { "url": string, "token": string, "agent"?: { "agent": "${AGENT_NAMES.join('" | "')}", "model"?: string, "account"?: string }, "criteriaHeading"?: string }`,
      ),
    );
    return;
  }
  if (criteriaHeading !== undefined && (typeof criteriaHeading !== 'string' || criteriaHeading.trim() === '')) {
    respond(sink, failure(id, JSON_RPC_INVALID_PARAMS, `${REVIEW_METHOD}: criteriaHeading must be a non-empty string`));
    return;
  }
  if (choice !== undefined) {
    const problem = agentChoiceProblem(choice);
    if (problem !== undefined) {
      respond(sink, failure(id, JSON_RPC_INVALID_PARAMS, `${REVIEW_METHOD}: ${problem}`));
      return;
    }
  }
  try {
    const result = await reviewPullRequest(url, {
      token,
      cacheDir: deps.cacheDir,
      ...(criteriaHeading !== undefined ? { criteriaHeading } : {}),
      ...(deps.fetch ? { fetch: deps.fetch } : {}),
      ...(deps.agent
        ? {
            agentStage: {
              adapter: deps.agent.adapterFor(choice?.agent ?? deps.agent.defaultAgent),
              settings: agentRunSettings(deps.agent, choice),
              ...(deps.agent.testedRankings ? { testedRankings: deps.agent.testedRankings } : {}),
              onStage: (stage) => notify(sink, REVIEW_STAGE_METHOD, { id, ...stage }),
            },
          }
        : {}),
    });
    reviews.set(result.pullRequest.url, result);
    respond(sink, { jsonrpc: '2.0', id, result });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    respond(sink, failure(id, ENGINE_FAILED_CODE, redactToken(message, token)));
  }
}

/**
 * Presses one claim's library fetch in the pull request's latest review:
 * fetches the library into the pull request's library cache and has the
 * agent judge the claim again there, then answers with the review result
 * holding the new verdict, which later fetches build on; a .NET library
 * with no exact source answers with the claim offering to decompile it,
 * or saying why it is not decompiled, and pressing that offer decompiles
 * it. A fetch fails
 * with a plain message when the review is unknown, the claim offers no
 * fetch, the download does not match the hash it is checked against, or
 * the agent gives no usable answer, or a decompile finds no decompiler.
 */
async function fetchLibrary(
  params: unknown,
  id: number,
  sink: RpcLineSink,
  initialized: boolean,
  deps: RpcServerDeps,
  reviews: Map<string, ReviewResult>,
): Promise<void> {
  if (!initialized) {
    respond(sink, failure(id, NOT_INITIALIZED_CODE, `the protocol starts with a version handshake: ${INITIALIZE_METHOD} before ${FETCH_LIBRARY_METHOD}`));
    return;
  }
  const { url, claim: index, agent: choice } = (params ?? {}) as Partial<FetchLibraryParams>;
  const ref = typeof url === 'string' ? parsePullRequestUrl(url) : null;
  if (ref === null || typeof url !== 'string' || typeof index !== 'number' || !Number.isInteger(index) || index < 0) {
    respond(sink, failure(id, JSON_RPC_INVALID_PARAMS, `${FETCH_LIBRARY_METHOD} needs params: { "url": string, "claim": number, "agent"?: { "agent": "${AGENT_NAMES.join('" | "')}", "model"?: string, "account"?: string } }`));
    return;
  }
  const problem = choice === undefined ? undefined : agentChoiceProblem(choice);
  if (problem !== undefined) {
    respond(sink, failure(id, JSON_RPC_INVALID_PARAMS, `${FETCH_LIBRARY_METHOD}: ${problem}`));
    return;
  }
  const result = reviews.get(url);
  const claim = result?.claims?.claims[index];
  if (result === undefined || claim === undefined || deps.agent === undefined) {
    respond(sink, failure(id, ENGINE_FAILED_CODE, `this engine has no reviewed claim ${index} of ${url}; review the pull request again`));
    return;
  }
  try {
    const judging = await pressLibraryFetch(result.parts, claim, {
      headRoot: result.copies.head.path,
      librariesDir: join(pullRequestCacheDir(deps.cacheDir, ref), 'libraries'),
      ...(deps.fetch ? { fetch: deps.fetch } : {}),
      adapter: deps.agent.adapterFor(choice?.agent ?? deps.agent.defaultAgent),
      settings: agentRunSettings(deps.agent, choice),
    });
    if (judging.outcome === 'fell back') throw new Error(`the library was fetched, but ${judging.detail}`);
    // Another fetch or a new review may have landed meanwhile: the new
    // verdict goes into the latest result, and only onto the same claim.
    const latest = reviews.get(url);
    const claims = latest?.claims;
    if (latest === undefined || claims === undefined || claims.claims[index]?.quote !== claim.quote) {
      throw new Error('the review changed while the library was fetched; press the fetch again');
    }
    const updated: ReviewResult = {
      ...latest,
      claims: { ...claims, claims: claims.claims.map((each, at) => (at === index ? judging.claim : each)) },
    };
    reviews.set(url, updated);
    respond(sink, { jsonrpc: '2.0', id, result: updated });
  } catch (error) {
    respond(sink, failure(id, ENGINE_FAILED_CODE, error instanceof Error ? error.message : String(error)));
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

function notify(sink: RpcLineSink, method: string, params: ReviewStageParams): void {
  const notification: RpcNotification<ReviewStageParams> = { jsonrpc: '2.0', method, params };
  sink.writeLine(JSON.stringify(notification));
}

function respond(sink: RpcLineSink, response: RpcResponse): void {
  sink.writeLine(JSON.stringify(response));
}
