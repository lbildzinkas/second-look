import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ENGINE_FAILED_CODE,
  ENGINE_PROTOCOL_VERSION,
  JSON_RPC_INVALID_PARAMS,
  NOT_INITIALIZED_CODE,
  REVIEW_STAGE_METHOD,
  VERSION_MISMATCH_CODE,
} from '../src/rpc.js';
import type { AgentName } from '../src/agents.js';
import type { ScriptedAgent } from './helpers.js';
import { CLAIMS_INSTRUCTIONS } from '../src/claims.js';
import { DRAFT_COMMENT_INSTRUCTIONS } from '../src/draft-comment.js';
import { EXPLAIN_INSTRUCTIONS } from '../src/explain.js';
import { UNEXPLAINED_INSTRUCTIONS } from '../src/unexplained.js';
import { GROUPING_INSTRUCTIONS } from '../src/grouping.js';
import { LIBRARY_VERDICTS_INSTRUCTIONS } from '../src/library-verdicts.js';
import { VERDICTS_INSTRUCTIONS, VERDICTS_PROMPT_VERSION } from '../src/verdicts.js';
import { DEFAULT_EFFORT } from '../src/ranking.js';
import { runRpcServer, type RpcAgentDeps } from '../src/server.js';
import { markedPart } from '../src/reviewed-marks.js';
import { readLooks, recordLook } from '../src/last-look.js';
import type { ReviewResult } from '../src/protocol.js';
import { removeCopy } from '../src/cache.js';
import {
  PR_7_URL,
  PR_URL,
  SENT_REVIEW_URL,
  answeringAgent,
  fixtureFetch,
  offeredParts,
  pull7,
  pypiFetch,
  recordedFetch,
  relicensed,
  scriptedAgent,
  sha256Hex,
  temporaryCacheDir,
  zipArchive,
} from './helpers.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { PullRequestList } from '../src/protocol.js';
import { failingFetch } from './helpers.js';

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
    expect(first.version).toBe(20);
    expect(first.parts).toHaveLength(11);
    const second = responses[2]!.result as { parts: unknown[] };
    expect(second.parts).toHaveLength(11);
    // Each review asks GitHub for what it needs — the pull request twice
    // (metadata, diff), the attributes, the merge base, the linked issues,
    // the check runs, the reviewer and their reviews, for want of an
    // earlier look, and on the first run the two commit archives —
    // always with the token its own request carried; the second review at
    // the same commits reuses the archives.
    const authorizations = transport.requests.map((request) => request.authorization);
    expect(authorizations.slice(0, 10)).toEqual(Array<string>(10).fill(`token ${TOKEN}`));
    expect(authorizations.slice(10)).toEqual(Array<string>(8).fill('token ghp_another-token'));
  });

  it('answers a failed review with the plain message, with the token redacted', async () => {    const leakingFetch: typeof fetch = async (input, init) => {
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

  it('reads the acceptance criteria under the heading the review request names', async () => {
    const responses = await serve(
      [
        request('initialize', { protocolVersion: ENGINE_PROTOCOL_VERSION }),
        request('review', { url: PR_URL, token: TOKEN, criteriaHeading: 'Definition of done' }, 2),
        request('review', { url: PR_URL, token: TOKEN, criteriaHeading: '  ' }, 3),
      ],
      fixtureFetch().fetch,
    );

    // The heading travels with the request, so the settings reach the
    // next review without restarting the engine; an empty one is refused.
    // Requests are answered as they arrive, so the answers are read by
    // their ids, not in order.
    const byId = new Map(responses.map((response) => [response.id, response]));
    const read = byId.get(2)!.result as { criteria: { heading: string; criteria: { quote: string }[] } };
    expect(read.criteria.heading).toBe('Definition of done');
    expect(read.criteria.criteria.map((criterion) => criterion.quote)).toEqual([
      'The retries ship behind a flag',
      'The flag is documented in the runbook',
    ]);
    expect(byId.get(3)!.error!.message).toContain('criteriaHeading must be a non-empty string');
  });

  it('meters each review against the budget its request carries, and refuses one that is no budget', async () => {
    const transport = fixtureFetch();
    const responses = await serve(
      [
        request('initialize', { protocolVersion: ENGINE_PROTOCOL_VERSION }),
        request('review', { url: PR_URL, token: TOKEN, budget: { agentRuns: 5, filesFetched: 3, downloadMiB: 0.25 } }, 2),
        request('review', { url: PR_URL, token: TOKEN, budget: { agentRuns: -1, filesFetched: 0, downloadMiB: 0 } }, 3),
        request('review', { url: PR_URL, token: TOKEN, budget: { agentRuns: 1, filesFetched: 2 } }, 4),
      ],
      transport.fetch,
    );

    const byId = new Map(responses.map((response) => [response.id, response]));
    // Every GitHub answer and archive counts, and the review's own reads
    // ran on past the limit of three files: they are never refused.
    const { budget } = byId.get(2)!.result as ReviewResult;
    expect(budget!.limits).toEqual({ agentRuns: 5, filesFetched: 3, downloadMiB: 0.25 });
    expect(budget!.used).toMatchObject({ agentRuns: 0, filesFetched: transport.requests.length });
    expect(budget!.used.filesFetched).toBeGreaterThan(3);
    expect(budget!.used.downloadBytes).toBeGreaterThan(0);
    expect(byId.get(3)!.error).toMatchObject({ code: JSON_RPC_INVALID_PARAMS, message: expect.stringContaining('review: the budget must be') });
    expect(byId.get(4)!.error).toMatchObject({ code: JSON_RPC_INVALID_PARAMS, message: expect.stringContaining('downloadMiB must be a number') });
  });

  it('meters a review that carries no budget against no limits', async () => {
    const responses = await serve(
      [request('initialize', { protocolVersion: ENGINE_PROTOCOL_VERSION }), request('review', { url: PR_URL, token: TOKEN }, 2)],
      fixtureFetch().fetch,
    );
    expect((responses[1]!.result as ReviewResult).budget!.limits).toEqual({ agentRuns: 0, filesFetched: 0, downloadMiB: 0 });
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
    expect(responses[1]!.error!.message).toContain('initialize, agents/probe, review, fetchLibrary, draftComment, ask, sendReview, reviewedMarks, markReviewed, markViewed and pullRequests/list');
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
  it('sends the plain result as a stage notification before the answer with the agent parts, story, unexplained changes and claims', async () => {
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
        agent: { adapterFor: () => scriptedAgent([JSON.stringify(answer)]), defaultAgent: 'pi' },
      },
    );

    const [handshake, stage, storyStage, unexplainedStage, claimsStage, final] = written.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(written).toHaveLength(6);
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
        result: { version: 20, grouping: { by: 'plain' }, ranking: { by: 'plain' } },
      },
    });
    // The fake agent has no tested ranking, so the story stage follows the grouping.
    expect(storyStage).toMatchObject({
      method: REVIEW_STAGE_METHOD,
      params: { id: 2, running: 'writing the story with fake', result: { grouping: { by: 'agent' } } },
    });
    expect(unexplainedStage).toMatchObject({
      method: REVIEW_STAGE_METHOD,
      params: { id: 2, running: 'comparing the change with its description and issues with fake', result: { story: { outcome: 'fell back' } } },
    });
    expect(claimsStage).toMatchObject({
      method: REVIEW_STAGE_METHOD,
      params: { id: 2, running: 'listing the claims with fake', result: { unexplained: { outcome: 'fell back' } } },
    });
    expect(final).toMatchObject({
      id: 2,
      result: {
        grouping: { by: 'agent' },
        story: { outcome: 'fell back' },
        unexplained: { outcome: 'fell back', parts: [], described: [] },
        claims: { outcome: 'fell back', claims: [] },
      },
    });
    expect((final!['result'] as { parts: unknown[] }).parts).toHaveLength(2);
    expect(written.join('\n')).not.toContain(TOKEN);
    // Every stage carries the review's use so far: no run before the
    // grouping starts, and every run once the review is answered.
    const used = [stage, storyStage, unexplainedStage, claimsStage].map(
      (each) => ((each!['params'] as { result: ReviewResult }).result.budget!.used.agentRuns),
    );
    expect(used[0]).toBe(0);
    expect(used).toEqual([...used].sort((a, b) => a - b));
    expect((final!['result'] as ReviewResult).budget!.used.agentRuns).toBeGreaterThan(used.at(-1)!);
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
      { cacheDir, fetch: fixtureFetch(pull7()).fetch, agent: { adapterFor: () => adapter, defaultAgent: 'pi' } },
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

  /** The grouping a reviewer would give pull request 7: two parts over its seven hunks. */
  const GROUPING = {
    parts: [
      { name: 'fresh, with its test', hunks: ['h2', 'h7'] },
      { name: 'the rest', hunks: ['h1', 'h3', 'h4', 'h5', 'h6'] },
    ],
  };

  /**
   * A fake agent under the name the settings would choose, answering the
   * grouping and the ranking pass like a reviewer would and recording
   * every run it saw. No real agent is ever run.
   */
  function namedAgent(agent: AgentName, model: string) {
    const scripted = scriptedAgent([]);
    return {
      ...scripted,
      agent,
      run: async (request: Parameters<typeof scripted.run>[0]) => {
        scripted.requests.push(request);
        const answer =
          request.instructions === GROUPING_INSTRUCTIONS
            ? GROUPING
            : request.instructions === CLAIMS_INSTRUCTIONS
              ? { claims: [] }
              : request.instructions === UNEXPLAINED_INSTRUCTIONS
                ? { unexplained: [], described: [] }
                : {
                parts: [...offeredParts(request.prompt)].reverse().map(({ id }, index) => ({
                  part: id,
                  importance: index === 0 ? 'must review' : 'worth reviewing',
                  reason: `reason for ${id}`,
                  signals: ['size'],
                })),
              };
        return {
          status: 'completed' as const,
          text: JSON.stringify(answer),
          stamp: { agent, agentVersion: '1.2.3', model, effort: request.effort ?? null, runAt: '2026-10-05T00:00:00.000Z' },
        };
      },
    };
  }

  /** Serves the lines and returns how to read a request's answer by its id. */
  async function serveWithAgent(
    lines: string[],
    agent: RpcAgentDeps,
  ): Promise<(id: number) => Response> {
    let index = 0;
    const written: string[] = [];
    await runRpcServer(
      { readLine: async () => (index < lines.length ? (lines[index++] as string) : null) },
      { writeLine: (line) => written.push(line) },
      { cacheDir, fetch: fixtureFetch(pull7()).fetch, agent },
    );
    const responses = written.map((line) => JSON.parse(line) as Response);
    // Stage notifications carry no id; the answers are the id-carrying lines.
    return (id) => responses.find((response) => response.id === id)!;
  }

  it('runs every agent pass with the agent, model and account the request carries, so switching the choice changes the stamp', async () => {
    const pi = namedAgent('pi', 'pi/model');
    const claude = namedAgent('claude-code', 'claude/model');
    const answers = await serveWithAgent(
      [
        request('initialize', { protocolVersion: ENGINE_PROTOCOL_VERSION }),
        request('review', { url: PR_7_URL, token: TOKEN, agent: { agent: 'pi', model: 'pi/model', account: 'Pi personal key' } }, 2),
        request('review', { url: PR_7_URL, token: TOKEN, agent: { agent: 'claude-code', model: 'claude/model', account: 'Claude Max (work)' } }, 3),
      ],
      {
        adapterFor: (name) => (name === 'pi' ? pi : claude),
        defaultAgent: 'pi',
        testedRankings: [
          { agent: 'pi', model: 'pi/model', effort: DEFAULT_EFFORT },
          { agent: 'claude-code', model: 'claude/model', effort: DEFAULT_EFFORT },
        ],
      },
    );

    // Both reviews grouped, ranked, wrote their story, compared the change
    // with its description and listed the claims through the same engine, each pass asking for the model the request
    // named; the fake's story answer is refused and retried once, so the
    // story costs two runs.
    expect(pi.requests.map((run) => run.model)).toEqual(Array(6).fill('pi/model'));
    expect(claude.requests.map((run) => run.model)).toEqual(Array(6).fill('claude/model'));
    const first = answers(2).result as {
      grouping: { by: string; agent?: { stamp?: { agent: string; model: string; account?: string } } };
      ranking: { by: string; agent?: { stamp?: { agent: string; model: string; account?: string } } };
    };
    expect(first.grouping).toMatchObject({ by: 'agent', agent: { stamp: { agent: 'pi', model: 'pi/model', account: 'Pi personal key' } } });
    expect(first.ranking).toMatchObject({ by: 'agent', agent: { stamp: { agent: 'pi', model: 'pi/model', account: 'Pi personal key' } } });
    const second = answers(3).result as typeof first;
    expect(second.grouping).toMatchObject({ by: 'agent', agent: { stamp: { agent: 'claude-code', model: 'claude/model', account: 'Claude Max (work)' } } });
    expect(second.ranking).toMatchObject({ by: 'agent', agent: { stamp: { agent: 'claude-code', model: 'claude/model', account: 'Claude Max (work)' } } });
  });

  it('runs every agent pass at the effort the request carries, an empty one keeping the agent default, and ranks only where that effort was tested', async () => {
    const claude = namedAgent('claude-code', 'claude/model');
    const answers = await serveWithAgent(
      [
        request('initialize', { protocolVersion: ENGINE_PROTOCOL_VERSION }),
        request('review', { url: PR_7_URL, token: TOKEN, agent: { agent: 'claude-code', model: 'claude/model', effort: 'high' } }, 2),
        request('review', { url: PR_7_URL, token: TOKEN, agent: { agent: 'claude-code', model: 'claude/model', effort: '' } }, 3),
      ],
      {
        adapterFor: () => claude,
        defaultAgent: 'claude-code',
        settings: { timeoutMs: 10_000, concurrency: 1, effort: 'low' },
        testedRankings: [{ agent: 'claude-code', model: 'claude/model', effort: 'high' }],
      },
    );

    // The first review ranked too (high is tested): six runs at high. The
    // second asked for the agent default, which is not tested, so it kept
    // the plain ranking: five runs, none asking for an effort. The two
    // reviews' runs interleave, so only the counts are fixed.
    const efforts = claude.requests.map((run) => run.effort);
    expect(efforts.filter((effort) => effort === 'high')).toHaveLength(6);
    expect(efforts.filter((effort) => effort === undefined)).toHaveLength(5);
    expect(efforts).toHaveLength(11);
    expect(answers(2).result).toMatchObject({
      grouping: { by: 'agent', agent: { stamp: { effort: 'high' } } },
      ranking: { by: 'agent', agent: { stamp: { effort: 'high' } } },
    });
    expect(answers(3).result).toMatchObject({
      grouping: { by: 'agent', agent: { stamp: { effort: null } } },
      ranking: { by: 'plain', agent: { outcome: 'not tested', detail: expect.stringContaining('at its default effort') } },
    });
  });

  it('runs the serve default when the request carries no choice', async () => {
    const pi = namedAgent('pi', 'pi/model');
    const claude = namedAgent('claude-code', 'claude/model');
    const answers = await serveWithAgent(
      [
        request('initialize', { protocolVersion: ENGINE_PROTOCOL_VERSION }),
        request('review', { url: PR_7_URL, token: TOKEN }, 2),
      ],
      {
        adapterFor: (name) => (name === 'pi' ? pi : claude),
        defaultAgent: 'claude-code',
        settings: { timeoutMs: 10_000, concurrency: 1, model: 'claude/model' },
      },
    );

    // The grouping, story, unexplained-changes and claims passes ran: the serve default agent
    // has no tested ranking here, so the plain ranking stayed and said so;
    // the fake's story answer is refused and retried once, so the story
    // costs two runs.
    expect(pi.requests).toHaveLength(0);
    expect(claude.requests).toHaveLength(5);
    expect(claude.requests[0]!.model).toBe('claude/model');
    expect(answers(2).result).toMatchObject({
      grouping: { by: 'agent', agent: { stamp: { agent: 'claude-code', model: 'claude/model' } } },
      ranking: { by: 'plain', agent: { outcome: 'not tested' } },
    });
  });

  it('refuses an agent choice the engine cannot drive, naming the choices', async () => {
    const answers = await serveWithAgent(
      [
        request('initialize', { protocolVersion: ENGINE_PROTOCOL_VERSION }),
        request('review', { url: PR_7_URL, token: TOKEN, agent: { agent: 'codex' } }, 2),
        request('review', { url: PR_7_URL, token: TOKEN, agent: { agent: 'pi', model: 3 } }, 3),
        request('review', { url: PR_7_URL, token: TOKEN, agent: { agent: 'claude-code' } }, 4),
        request('review', { url: PR_7_URL, token: TOKEN, agent: { agent: 'pi', effort: 3 } }, 5),
      ],
      { adapterFor: () => namedAgent('pi', 'pi/model'), defaultAgent: 'pi' },
    );

    expect(answers(2).error).toMatchObject({ code: JSON_RPC_INVALID_PARAMS });
    expect(answers(2).error!.message).toContain('choose pi or claude-code');
    expect(answers(3).error).toMatchObject({ code: JSON_RPC_INVALID_PARAMS });
    expect(answers(3).error!.message).toContain('model must be a string');
    // A choice of only the agent is fine: model, effort and account are optional.
    expect(answers(4).result).toMatchObject({ grouping: { by: 'agent' } });
    expect(answers(5).error).toMatchObject({ code: JSON_RPC_INVALID_PARAMS });
    expect(answers(5).error!.message).toContain('effort must be a string');
  });

  it('refuses a model or effort the agent cannot take before any agent starts', async () => {
    const pi = namedAgent('pi', 'pi/model');
    const claude = namedAgent('claude-code', 'claude/model');
    const answers = await serveWithAgent(
      [
        request('initialize', { protocolVersion: ENGINE_PROTOCOL_VERSION }),
        request('review', { url: PR_7_URL, token: TOKEN, agent: { agent: 'claude-code', model: '--help' } }, 2),
        request('review', { url: PR_7_URL, token: TOKEN, agent: { agent: 'pi', effort: '--thinking' } }, 3),
        request('review', { url: PR_7_URL, token: TOKEN, agent: { agent: 'claude-code', effort: 'minimal' } }, 4),
        request('draftComment', { url: PR_7_URL, finding: { kind: 'claim', index: 0 }, agent: { agent: 'pi', model: '-m' } }, 5),
      ],
      { adapterFor: (name) => (name === 'pi' ? pi : claude), defaultAgent: 'pi' },
    );

    expect(answers(2).error).toMatchObject({ code: JSON_RPC_INVALID_PARAMS });
    expect(answers(2).error!.message).toBe(
      'review: the model "--help" is not a plain name: use only letters, digits and . _ - / :, not starting with -',
    );
    expect(answers(3).error).toMatchObject({ code: JSON_RPC_INVALID_PARAMS });
    expect(answers(3).error!.message).toContain('the effort "--thinking" is not a plain level');
    expect(answers(4).error).toMatchObject({ code: JSON_RPC_INVALID_PARAMS });
    expect(answers(4).error!.message).toContain('claude-code does not accept the effort "minimal": choose low, medium, high, xhigh, max');
    expect(answers(5).error).toMatchObject({ code: JSON_RPC_INVALID_PARAMS });
    expect(answers(5).error!.message).toContain('the model "-m" is not a plain name');
    expect(pi.requests).toHaveLength(0);
    expect(claude.requests).toHaveLength(0);
  });
});

describe('runRpcServer fetching a library', () => {
  // A cache of its own: the head copy here pins httpx, unlike the copy of
  // pull request 7 the other tests leave in theirs.
  let libraryCacheDir: string;

  beforeEach(() => {
    libraryCacheDir = temporaryCacheDir();
  });

  afterEach(async () => {
    await removeCopy(libraryCacheDir);
  });

  const WHEEL = zipArchive([{ name: 'httpx/_client.py', content: 'class Client:\n    def __init__(self, follow_redirects: bool = False):\n        pass\n' }]);
  const CLAIM = 'taxes the cart total.';

  /** Pull request 7 with httpx pinned by hash, served beside PyPI's recorded release. */
  function transports() {
    const pull = pull7();
    const github = fixtureFetch({ ...pull, head: { ...pull.head, 'requirements.txt': `httpx==0.27.2 --hash=sha256:${sha256Hex(WHEEL)}\n` } });
    const pypi = pypiFetch('httpx', '0.27.2', [{ filename: 'httpx-0.27.2-py3-none-any.whl', bytes: WHEEL }]);
    const fetchImpl: typeof fetch = (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      return /^https:\/\/(pypi\.org|files\.pythonhosted\.org)\//.test(url) ? pypi.fetch(input, init) : github.fetch(input, init);
    };
    return { fetch: fetchImpl, pypi };
  }

  /** Lists the description's claim, leaves it unverifiable needing `library`, then refutes it from that library's source. */
  function libraryAgent(library = 'httpx') {
    return answeringAgent((run) => {
      if (run.instructions === CLAIMS_INSTRUCTIONS) return { claims: [{ source: 'description', quote: CLAIM, file: null, line: null, part: 'p1' }] };
      if (run.instructions === VERDICTS_INSTRUCTIONS) {
        return { verdicts: [{ id: 'c1', verdict: 'unverifiable', source: 'the change itself', reason: `It turns on ${library}.`, evidence: [], library }] };
      }
      if (run.instructions === EXPLAIN_INSTRUCTIONS) {
        const [, file] = /^file "([^"]+)"/m.exec(run.prompt)!;
        const [, line, text] = /^\+ head (\d+): (.*)$/m.exec(run.prompt)!;
        return { does: 'It adds a function that returns one.', matters: 'The rest of the change calls it.', cited: [{ file, side: 'head', line: Number(line), quote: text }] };
      }
      if (run.instructions === DRAFT_COMMENT_INSTRUCTIONS) {
        return { comment: `The description says the helper ${CLAIM} Could you show where, since checking it needs ${library}'s source?` };
      }
      if (run.instructions === LIBRARY_VERDICTS_INSTRUCTIONS) {
        return {
          verdict: 'refuted',
          source: 'library source at the pinned version',
          reason: 'A client follows no redirect by default.',
          evidence: [{ file: 'httpx/_client.py', line: 2, quote: 'def __init__(self, follow_redirects: bool = False):' }],
        };
      }
      return {};
    });
  }

  /**
   * Serves the lines, holding each fetch request back until the review
   * before it is answered; in turn, every request after the review waits
   * for the answer to the one before it.
   */
  async function serveInTurn(
    lines: string[],
    fetchImpl: typeof fetch,
    library?: string,
    inTurn = false,
    agent?: ScriptedAgent,
  ): Promise<{ answer: (id: number) => Response; pypiBeforeFetch: number }> {
    const written: string[] = [];
    let index = 0;
    const answered = new Map<number, () => void>();
    const answers = new Map<number, Promise<void>>();
    const answeredBy = (id: number): Promise<void> => {
      if (!answers.has(id)) answers.set(id, new Promise<void>((resolve) => answered.set(id, resolve)));
      return answers.get(id)!;
    };
    let pypiBeforeFetch = -1;
    const { pypi } = state;
    await runRpcServer(
      {
        readLine: async () => {
          const line = lines[index++];
          if (line === undefined) return null;
          if (line.includes('"fetchLibrary"') || line.includes('"draftComment"') || line.includes('"method":"ask"')) {
            await answeredBy(2);
            if (inTurn) await answeredBy((JSON.parse(line) as { id: number }).id - 1);
            if (pypiBeforeFetch < 0) pypiBeforeFetch = pypi.requests.length;
          }
          return line;
        },
      },
      {
        writeLine: (line) => {
          written.push(line);
          const { id } = JSON.parse(line) as Response;
          answeredBy(id as number);
          answered.get(id as number)!();
        },
      },
      { cacheDir: libraryCacheDir, fetch: fetchImpl, agent: { adapterFor: () => agent ?? libraryAgent(library), defaultAgent: 'pi' } },
    );
    const responses = written.map((line) => JSON.parse(line) as Response);
    return { answer: (id) => responses.find((response) => response.id === id)!, pypiBeforeFetch };
  }

  let state: ReturnType<typeof transports>;

  it('offers the fetch with the review, downloads nothing until it is pressed, then answers with the claim judged in the library', async () => {
    state = transports();
    const { answer, pypiBeforeFetch } = await serveInTurn(
      [
        request('initialize', { protocolVersion: ENGINE_PROTOCOL_VERSION }),
        request('review', { url: PR_7_URL, token: TOKEN }, 2),
        request('fetchLibrary', { url: PR_7_URL, claim: 0 }, 3),
      ],
      state.fetch,
    );

    // The review offered the fetch, and nothing reached PyPI before the press.
    expect(answer(2).result).toMatchObject({
      claims: {
        claims: [
          {
            quote: CLAIM,
            verdict: {
              kind: 'unverifiable',
              needsLibrary: 'httpx',
              libraryFetch: { library: 'httpx', pinnedVersion: '0.27.2', pinnedBy: 'requirements.txt', reason: expect.stringContaining('httpx 0.27.2') },
            },
          },
        ],
      },
    });
    expect(pypiBeforeFetch).toBe(0);
    expect(answer(3).result).toMatchObject({
      version: 20,
      claims: {
        claims: [
          {
            quote: CLAIM,
            verdict: {
              kind: 'refuted',
              source: 'library source at the pinned version',
              evidence: [{ path: 'httpx/_client.py', line: 2 }],
              library: { library: 'httpx', pinnedVersion: '0.27.2', archive: 'wheel', path: expect.stringContaining(join('pull-7', 'libraries', 'httpx-0.27.2-')) },
            },
          },
        ],
      },
    });
    expect(state.pypi.requests.map((each) => each.url)).toEqual([
      'https://pypi.org/pypi/httpx/0.27.2/json',
      'https://files.pythonhosted.org/packages/ab/cd/httpx-0.27.2-py3-none-any.whl',
    ]);
  });

  it("adds the review's later asks, drafts and library fetches to the same review's use", async () => {
    state = transports();
    const agent = libraryAgent();
    const { answer } = await serveInTurn(
      [
        request('initialize', { protocolVersion: ENGINE_PROTOCOL_VERSION }),
        request('review', { url: PR_7_URL, token: TOKEN, budget: { agentRuns: 0, filesFetched: 0, downloadMiB: 0 } }, 2),
        request('ask', { url: PR_7_URL, ask: 'explain', part: 0 }, 3),
        request('draftComment', { url: PR_7_URL, finding: { kind: 'claim', index: 0 } }, 4),
        request('fetchLibrary', { url: PR_7_URL, claim: 0 }, 5),
      ],
      state.fetch,
      undefined,
      true,
      agent,
    );

    const reviewed = (answer(2).result as ReviewResult).budget!;
    const fetched = (answer(5).result as ReviewResult).budget!;
    expect(answer(3).error).toBeUndefined();
    expect(answer(4).error).toBeUndefined();
    // The ask, the draft and the fetch's judging each ran the agent once
    // more, and the fetch downloaded PyPI's release and the wheel.
    expect(fetched.used.agentRuns).toBe(reviewed.used.agentRuns + 3);
    expect(fetched.used.agentRuns).toBe(agent.requests.length);
    expect(fetched.used.filesFetched).toBe(reviewed.used.filesFetched + state.pypi.requests.length);
    expect(state.pypi.requests).toHaveLength(2);
    expect(fetched.used.downloadBytes - reviewed.used.downloadBytes).toBeGreaterThan(WHEEL.length);
  });

  it('refuses a library fetch pressed past any limit, naming it, while asks and drafts are only counted', async () => {
    // How many runs the review uses with no limit: a limit of exactly that leaves it whole.
    state = transports();
    const { answer: unlimited } = await serveInTurn(
      [request('initialize', { protocolVersion: ENGINE_PROTOCOL_VERSION }), request('review', { url: PR_7_URL, token: TOKEN }, 2)],
      state.fetch,
    );
    const runs = (unlimited(2).result as ReviewResult).budget!.used.agentRuns;

    for (const [budget, reason] of [
      [{ agentRuns: runs, filesFetched: 0, downloadMiB: 0 }, `the review used its ${runs} agent runs; raise \`second-look.budget.agentRuns\` to fetch it`],
      [{ agentRuns: 0, filesFetched: 1, downloadMiB: 0 }, 'the review fetched its 1 file; raise `second-look.budget.filesFetched` to fetch it'],
      [{ agentRuns: 0, filesFetched: 0, downloadMiB: 0.001 }, 'the review downloaded its 0.001 MiB; raise `second-look.budget.downloadMiB` to fetch it'],
    ] as const) {
      state = transports();
      const agent = libraryAgent();
      const { answer } = await serveInTurn(
        [
          request('initialize', { protocolVersion: ENGINE_PROTOCOL_VERSION }),
          request('review', { url: PR_7_URL, token: TOKEN, budget }, 2),
          request('ask', { url: PR_7_URL, ask: 'explain', part: 0 }, 3),
          request('draftComment', { url: PR_7_URL, finding: { kind: 'claim', index: 0 } }, 4),
          request('fetchLibrary', { url: PR_7_URL, claim: 0 }, 5),
        ],
        state.fetch,
        undefined,
        true,
        agent,
      );

      // The review's own reads passed the file and size limits, and its
      // claim was listed and judged within the run limit.
      const reviewed = answer(2).result as ReviewResult;
      expect(reviewed.claims!.claims[0]).toMatchObject({ quote: CLAIM, verdict: { kind: 'unverifiable', libraryFetch: { library: 'httpx' } } });
      expect(answer(3).error).toBeUndefined();
      expect(answer(4).error).toBeUndefined();
      expect(answer(5).error).toEqual({ code: ENGINE_FAILED_CODE, message: `this library fetch is refused: ${reason}` });
      expect(state.pypi.requests).toHaveLength(0);
      expect(agent.requests).toHaveLength(reviewed.budget!.used.agentRuns + 2);
    }
  });

  it('answers a .NET fetch that finds no exact source with the claim offering its decompile, and keeps it for the next press', async () => {
    state = transports();
    const PACKAGE = relicensed('<license type="expression">MIT</license>');
    const id = 'microsoft.io.recyclablememorystream';
    const pull = pull7();
    const github = fixtureFetch({
      ...pull,
      head: { ...pull.head, 'App.csproj': '<Project><ItemGroup><PackageReference Include="Microsoft.IO.RecyclableMemoryStream" Version="1.2.2" /></ItemGroup></Project>\n' },
    });
    const nuget = recordedFetch({
      [`https://api.nuget.org/v3/registration5-gz-semver2/${id}/1.2.2.json`]: JSON.stringify({ catalogEntry: 'https://api.nuget.org/v3/catalog0/data/old.json' }),
      'https://api.nuget.org/v3/catalog0/data/old.json': JSON.stringify({ packageHash: createHash('sha512').update(PACKAGE).digest('base64'), packageHashAlgorithm: 'SHA512' }),
      [`https://api.nuget.org/v3-flatcontainer/${id}/1.2.2/${id}.1.2.2.nupkg`]: PACKAGE,
      [`https://www.nuget.org/api/v2/symbolpackage/${id}/1.2.2`]: 404,
    });
    const fetchImpl: typeof fetch = (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      return /^https:\/\/(api|www)\.nuget\.org\//.test(url) ? nuget.fetch(input, init) : github.fetch(input, init);
    };

    const { answer } = await serveInTurn(
      [
        request('initialize', { protocolVersion: ENGINE_PROTOCOL_VERSION }),
        request('review', { url: PR_7_URL, token: TOKEN }, 2),
        request('fetchLibrary', { url: PR_7_URL, claim: 0 }, 3),
      ],
      fetchImpl,
      'Microsoft.IO.RecyclableMemoryStream',
    );

    expect(answer(3).error).toBeUndefined();
    expect(answer(3).result).toMatchObject({
      version: 20,
      claims: {
        claims: [
          {
            quote: CLAIM,
            verdict: {
              kind: 'unverifiable',
              libraryFetch: { library: 'Microsoft.IO.RecyclableMemoryStream', pinnedVersion: '1.2.2', pinnedBy: 'App.csproj', decompile: { licence: 'MIT' } },
            },
          },
        ],
      },
    });
    expect((answer(3).result as { claims: { claims: { verdict: object }[] } }).claims.claims[0]!.verdict).not.toHaveProperty('library');
  });

  it('drafts a comment from a finding of its latest review, and sends nothing', async () => {
    state = transports();
    const { answer } = await serveInTurn(
      [
        request('initialize', { protocolVersion: ENGINE_PROTOCOL_VERSION }),
        request('review', { url: PR_7_URL, token: TOKEN }, 2),
        request('draftComment', { url: PR_7_URL, finding: { kind: 'claim', index: 0 }, agent: { agent: 'pi', model: 'pi/model' } }, 3),
      ],
      state.fetch,
    );

    expect(answer(3).error).toBeUndefined();
    expect(answer(3).result).toEqual({
      finding: { kind: 'claim', index: 0 },
      statement: CLAIM,
      body: `The description says the helper ${CLAIM} Could you show where, since checking it needs httpx's source?`,
      promptVersion: '1',
      stamp: expect.objectContaining({ agent: 'fake' }),
    });
    // A draft reads nothing from PyPI and writes nothing to GitHub.
    expect(state.pypi.requests).toEqual([]);
  });

  it('refuses a draft from a finding it never reviewed, from something that is no finding, and malformed draft params', async () => {
    state = transports();
    const { answer } = await serveInTurn(
      [
        request('initialize', { protocolVersion: ENGINE_PROTOCOL_VERSION }),
        request('review', { url: PR_7_URL, token: TOKEN }, 2),
        request('draftComment', { url: PR_7_URL, finding: { kind: 'criterion', index: 0 } }, 3),
        request('draftComment', { url: 'https://github.com/example-org/example-repo/pull/8', finding: { kind: 'claim', index: 0 } }, 4),
        request('draftComment', { url: PR_7_URL, finding: { kind: 'story', index: 0 } }, 5),
        request('draftComment', { url: PR_7_URL, finding: { kind: 'claim', index: -1 } }, 6),
        request('draftComment', { url: PR_7_URL, finding: { kind: 'claim', index: 0 }, agent: { agent: 'nope' } }, 7),
      ],
      state.fetch,
    );

    expect(answer(3)).toMatchObject({ error: { code: ENGINE_FAILED_CODE, message: expect.stringContaining(`this engine has no finding criterion 0 of ${PR_7_URL} to draft from`) } });
    expect(answer(4)).toMatchObject({ error: { code: ENGINE_FAILED_CODE } });
    expect(answer(5)).toMatchObject({ error: { code: JSON_RPC_INVALID_PARAMS } });
    expect(answer(6)).toMatchObject({ error: { code: JSON_RPC_INVALID_PARAMS } });
    expect(answer(7)).toMatchObject({ error: { code: JSON_RPC_INVALID_PARAMS, message: expect.stringContaining('draftComment: the agent choice names an agent the engine cannot drive') } });
  });

  it('answers an ask about a part of its latest review, citing lines the part shows, and sends nothing', async () => {
    state = transports();
    const { answer } = await serveInTurn(
      [
        request('initialize', { protocolVersion: ENGINE_PROTOCOL_VERSION }),
        request('review', { url: PR_7_URL, token: TOKEN }, 2),
        request('ask', { url: PR_7_URL, ask: 'explain', part: 0, agent: { agent: 'pi', model: 'pi/model' } }, 3),
      ],
      state.fetch,
    );

    expect(answer(3).error).toBeUndefined();
    const reviewed = answer(2).result as ReviewResult;
    expect(answer(3).result).toEqual({
      ask: 'explain',
      part: 0,
      partName: reviewed.parts[0]!.name,
      sections: [
        { heading: 'What it does', text: 'It adds a function that returns one.' },
        { heading: 'Why it matters to the change', text: 'The rest of the change calls it.' },
      ],
      cited: [{ path: 'app/fresh.py', side: 'head', line: 1, quote: 'def fresh():' }],
      promptVersion: '1',
      stamp: expect.objectContaining({ agent: 'fake' }),
    });
    // An ask reads nothing from PyPI and writes nothing to GitHub.
    expect(state.pypi.requests).toEqual([]);
  });

  it("verifies the reviewer's selection with the judging pass, keeps the judged claim in its latest review, and presses its library fetch from there", async () => {
    state = transports();
    const selection = { path: 'app/fresh.py', line: 1, endLine: 1, text: 'def fresh():' };
    const { answer } = await serveInTurn(
      [
        request('initialize', { protocolVersion: ENGINE_PROTOCOL_VERSION }),
        request('review', { url: PR_7_URL, token: TOKEN }, 2),
        request('ask', { url: PR_7_URL, ask: 'verify', part: 0, claim: { selection } }, 3),
        request('fetchLibrary', { url: PR_7_URL, claim: 1 }, 4),
      ],
      state.fetch,
      undefined,
      true,
    );

    expect(answer(3).error).toBeUndefined();
    expect(answer(3).result).toMatchObject({
      ask: 'verify',
      part: 0,
      sections: [
        { heading: 'Claim', text: expect.stringContaining('text the reviewer selected in the diff of "app/fresh.py", line 1') },
        { heading: 'Verdict', text: 'unverifiable, from the change itself: It turns on httpx.' },
        { heading: 'Library fetch', text: expect.stringContaining('the source of httpx 0.27.2, as requirements.txt pins it') },
      ],
      cited: [],
      promptVersion: VERDICTS_PROMPT_VERSION,
      claim: { index: 1, claim: { quote: 'def fresh():', source: 'reviewer', verdict: { kind: 'unverifiable', libraryFetch: { library: 'httpx' } } } },
    });
    // Pressed from the review the engine keeps, the new claim's fetch judges it in the library.
    expect(answer(4).error).toBeUndefined();
    const claims = (answer(4).result as ReviewResult).claims!.claims;
    expect(claims.map((claim) => claim.quote)).toEqual([CLAIM, 'def fresh():']);
    expect(claims[1]!.verdict).toMatchObject({ kind: 'refuted', source: 'library source at the pinned version', library: { library: 'httpx' } });
  });

  it('marks a claim the verify ask judged alone though the review\u2019s judging fell back, and its pressed fetch lands', async () => {
    state = transports();
    let verdictRuns = 0;
    const agent = answeringAgent((run) => {
      if (run.instructions === CLAIMS_INSTRUCTIONS) return { claims: [{ source: 'description', quote: CLAIM, file: null, line: null, part: 'p1' }] };
      if (run.instructions === VERDICTS_INSTRUCTIONS) {
        verdictRuns += 1;
        if (verdictRuns <= 2) return {};
        return { verdicts: [{ id: 'c1', verdict: 'unverifiable', source: 'the change itself', reason: 'It turns on httpx.', evidence: [], library: 'httpx' }] };
      }
      if (run.instructions === LIBRARY_VERDICTS_INSTRUCTIONS) {
        return {
          verdict: 'refuted',
          source: 'library source at the pinned version',
          reason: 'A client follows no redirect by default.',
          evidence: [{ file: 'httpx/_client.py', line: 2, quote: 'def __init__(self, follow_redirects: bool = False):' }],
        };
      }
      return {};
    });
    const { answer } = await serveInTurn(
      [
        request('initialize', { protocolVersion: ENGINE_PROTOCOL_VERSION }),
        request('review', { url: PR_7_URL, token: TOKEN }, 2),
        request('ask', { url: PR_7_URL, ask: 'verify', part: 0, claim: { index: 0 } }, 3),
        request('fetchLibrary', { url: PR_7_URL, claim: 0 }, 4),
      ],
      state.fetch,
      undefined,
      true,
      agent,
    );

    // The review listed the claim but its judging fell back, so every claim stayed not checked.
    const reviewed = answer(2).result as ReviewResult;
    expect(reviewed.claims!.judging).toMatchObject({ outcome: 'fell back' });
    expect(reviewed.claims!.claims.every((claim) => claim.verdict.kind === 'not checked')).toBe(true);
    // The ask judged the claim alone, marked on it.
    expect(answer(3).result).toMatchObject({
      claim: { index: 0, claim: { asked: true, verdict: { kind: 'unverifiable', libraryFetch: { library: 'httpx' } } } },
    });
    // The pressed fetch answers with the whole review: the pass still fell back, and the fetched verdict lands on the marked claim.
    expect(answer(4).error).toBeUndefined();
    const fetched = answer(4).result as ReviewResult;
    expect(fetched.claims!.judging).toMatchObject({ outcome: 'fell back' });
    expect(fetched.claims!.claims[0]).toMatchObject({ asked: true, verdict: { kind: 'refuted', source: 'library source at the pinned version', library: { library: 'httpx' } } });
  });

  it('verifies a selection though the claims listing fell back empty, and presses its fetch from there', async () => {
    state = transports();
    const agent = answeringAgent((run) => {
      if (run.instructions === VERDICTS_INSTRUCTIONS) {
        return { verdicts: [{ id: 'c1', verdict: 'unverifiable', source: 'the change itself', reason: 'It turns on httpx.', evidence: [], library: 'httpx' }] };
      }
      if (run.instructions === LIBRARY_VERDICTS_INSTRUCTIONS) {
        return {
          verdict: 'refuted',
          source: 'library source at the pinned version',
          reason: 'A client follows no redirect by default.',
          evidence: [{ file: 'httpx/_client.py', line: 2, quote: 'def __init__(self, follow_redirects: bool = False):' }],
        };
      }
      return {};
    });
    const selection = { path: 'app/fresh.py', line: 1, endLine: 1, text: 'def fresh():' };
    const { answer } = await serveInTurn(
      [
        request('initialize', { protocolVersion: ENGINE_PROTOCOL_VERSION }),
        request('review', { url: PR_7_URL, token: TOKEN }, 2),
        request('ask', { url: PR_7_URL, ask: 'verify', part: 0, claim: { selection } }, 3),
        request('fetchLibrary', { url: PR_7_URL, claim: 0 }, 4),
      ],
      state.fetch,
      undefined,
      true,
      agent,
    );

    // The listing fell back and the pipeline report contributes no claim, so none was listed and the verdicts pass never ran.
    const reviewed = answer(2).result as ReviewResult;
    expect(reviewed.claims).toMatchObject({ outcome: 'fell back', claims: [] });
    expect(reviewed.claims!.judging).toBeUndefined();
    // The ask still judged the selection, which joined the empty listing marked asked.
    expect(answer(3).result).toMatchObject({
      claim: { index: 0, claim: { source: 'reviewer', asked: true, verdict: { kind: 'unverifiable', libraryFetch: { library: 'httpx' } } } },
    });
    // The pressed fetch answers with the whole review: the listing still fell back, no verdicts pass ran, and the fetched verdict lands on the asked claim.
    expect(answer(4).error).toBeUndefined();
    const fetched = answer(4).result as ReviewResult;
    expect(fetched.claims).toMatchObject({ outcome: 'fell back' });
    expect(fetched.claims!.judging).toBeUndefined();
    expect(fetched.claims!.claims[0]).toMatchObject({ source: 'reviewer', asked: true, verdict: { kind: 'refuted', source: 'library source at the pinned version', library: { library: 'httpx' } } });
  });

  it('refuses a verify ask with no claim or a claim off the part, and a claim on an ask that takes none', async () => {
    state = transports();
    const { answer } = await serveInTurn(
      [
        request('initialize', { protocolVersion: ENGINE_PROTOCOL_VERSION }),
        request('review', { url: PR_7_URL, token: TOKEN }, 2),
        request('ask', { url: PR_7_URL, ask: 'verify', part: 0 }, 3),
        request('ask', { url: PR_7_URL, ask: 'explain', part: 0, claim: { index: 0 } }, 4),
        request('ask', { url: PR_7_URL, ask: 'verify', part: 0, claim: { selection: { path: 'app/fresh.py', line: 1, endLine: 1, text: 'def stale():' } } }, 5),
      ],
      state.fetch,
    );

    expect(answer(3)).toMatchObject({ error: { code: JSON_RPC_INVALID_PARAMS, message: expect.stringContaining('with the claim for "verify" only') } });
    expect(answer(4)).toMatchObject({ error: { code: JSON_RPC_INVALID_PARAMS } });
    expect(answer(5)).toMatchObject({ error: { code: ENGINE_FAILED_CODE, message: 'the selection is not on lines 1-1 of app/fresh.py in the head copy' } });
  });

  it('refuses an ask about a part it never reviewed, an ask it does not know, and malformed ask params', async () => {
    state = transports();
    const { answer } = await serveInTurn(
      [
        request('initialize', { protocolVersion: ENGINE_PROTOCOL_VERSION }),
        request('review', { url: PR_7_URL, token: TOKEN }, 2),
        request('ask', { url: PR_7_URL, ask: 'explain', part: 99 }, 3),
        request('ask', { url: 'https://github.com/example-org/example-repo/pull/8', ask: 'explain', part: 0 }, 4),
        request('ask', { url: PR_7_URL, ask: 'chat', part: 0 }, 5),
        request('ask', { url: PR_7_URL, ask: 'explain', part: -1 }, 6),
        request('ask', { url: PR_7_URL, ask: 'explain', part: 0, agent: { agent: 'nope' } }, 7),
      ],
      state.fetch,
    );

    expect(answer(3)).toMatchObject({ error: { code: ENGINE_FAILED_CODE, message: expect.stringContaining(`this engine has no part 99 of ${PR_7_URL} to answer about`) } });
    expect(answer(4)).toMatchObject({ error: { code: ENGINE_FAILED_CODE } });
    expect(answer(5)).toMatchObject({ error: { code: JSON_RPC_INVALID_PARAMS, message: expect.stringContaining('"ask": "explain"') } });
    expect(answer(6)).toMatchObject({ error: { code: JSON_RPC_INVALID_PARAMS } });
    expect(answer(7)).toMatchObject({ error: { code: JSON_RPC_INVALID_PARAMS, message: expect.stringContaining('ask: the agent choice names an agent the engine cannot drive') } });
  });

  it('refuses a fetch of a claim it never reviewed, and malformed fetch params', async () => {
    state = transports();
    const answers = await serve(
      [
        request('initialize', { protocolVersion: ENGINE_PROTOCOL_VERSION }),
        request('fetchLibrary', { url: PR_7_URL, claim: 0 }, 2),
        request('fetchLibrary', { url: 'https://example.com/x', claim: 0 }, 3),
        request('fetchLibrary', { url: PR_7_URL, claim: -1 }, 4),
      ],
      state.fetch,
    );

    expect(answers[1]).toMatchObject({ id: 2, error: { code: ENGINE_FAILED_CODE, message: `this engine has no reviewed claim 0 of ${PR_7_URL}; review the pull request again` } });
    expect(answers[2]).toMatchObject({ id: 3, error: { code: JSON_RPC_INVALID_PARAMS } });
    expect(answers[3]).toMatchObject({ id: 4, error: { code: JSON_RPC_INVALID_PARAMS } });
    expect(state.pypi.requests).toEqual([]);
  });
});

describe('runRpcServer keeping reviewed marks', () => {
  const GRAPHQL = 'https://api.github.com/graphql';

  /** The recorded pull request, plus GitHub's GraphQL side of the "Viewed" mirror, recording each file marked. */
  function viewedFetch(): { fetch: typeof fetch; marked: string[]; tokens: (string | null)[] } {
    const transport = fixtureFetch();
    const marked: string[] = [];
    const tokens: (string | null)[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as { query: string; variables: Record<string, unknown> }) : undefined;
      if (url === GRAPHQL && body?.query.includes('markFileAsViewed')) {
        expect(body.variables['id']).toBe('PR_kwDOfixture42');
        marked.push(body.variables['path'] as string);
        tokens.push(new Headers(init?.headers).get('authorization'));
        return Response.json({ data: { markFileAsViewed: { clientMutationId: null } } });
      }
      if (url === GRAPHQL && body?.query.includes('pullRequest(number: $number) { id }')) {
        return Response.json({ data: { repository: { pullRequest: { id: 'PR_kwDOfixture42' } } } });
      }
      return transport.fetch(input, init);
    };
    return { fetch: fetchImpl, marked, tokens };
  }

  /** Serves the lines one at a time, each sent once the one before it is answered. */
  async function serveInOrder(lines: string[], deps: { fetch?: typeof fetch; cacheDir: string }): Promise<Response[]> {
    const written: Response[] = [];
    let index = 0;
    let answered: () => void = () => undefined;
    await runRpcServer(
      {
        readLine: async () => {
          if (index >= lines.length) return null;
          while (written.length < index) await new Promise<void>((resolve) => (answered = resolve));
          return lines[index++]!;
        },
      },
      {
        writeLine: (line) => {
          const response = JSON.parse(line) as Response;
          if (response.id === null || response.id === undefined) return;
          written.push(response);
          answered();
        },
      },
      deps,
    );
    return written;
  }

  const initialize = request('initialize', { protocolVersion: ENGINE_PROTOCOL_VERSION });

  it('says what changed since the last look with each review, and records this one', async () => {
    const store = temporaryCacheDir();
    const gone = 'abcdef0123456789abcdef0123456789abcdef01';
    await recordLook(store, { owner: 'example-org', repo: 'example-repo', number: 42 }, { commit: gone, at: '2026-10-01T09:00:00.000Z' });
    const answers = await serveInOrder([initialize, request('review', { url: PR_URL, token: TOKEN }, 2)], { fetch: fixtureFetch().fetch, cacheDir: store });

    const result = answers[1]!.result as ReviewResult;
    expect(result.sinceLastLook).toEqual({ commit: gone, from: 'local record', at: '2026-10-01T09:00:00.000Z', outcome: 'not compared', changed: [] });
    const looks = await readLooks(store, { owner: 'example-org', repo: 'example-repo', number: 42 });
    expect(looks).toEqual({ version: 1, last: { commit: result.pullRequest.headSha, at: expect.any(String) }, before: { commit: gone, at: '2026-10-01T09:00:00.000Z' } });
    await removeCopy(store);
  });

  it('keeps a mark in the pull request’s local store, which a new engine reads back', async () => {
    const store = temporaryCacheDir();
    const part = { name: 'Cart.total in web/cart.ts', pieces: [sha256Hex(Buffer.from('a hunk'))] };
    const first = await serveInOrder(
      [initialize, request('markReviewed', { url: PR_URL, part, reviewed: true }, 2), request('reviewedMarks', { url: PR_URL }, 3)],
      { cacheDir: store },
    );
    const again = await serveInOrder([initialize, request('reviewedMarks', { url: PR_URL }, 2)], { cacheDir: store });

    const marks = first[1]!.result as { marks: { name: string; pieces: string[]; hash: string }[] };
    expect(marks.marks).toEqual([expect.objectContaining({ name: part.name, pieces: part.pieces, hash: createHash('sha256').update(part.pieces.join('\n')).digest('hex') })]);
    expect(first[2]!.result).toEqual(marks);
    expect(again[1]!.result).toEqual(marks);

    const cleared = await serveInOrder([initialize, request('markReviewed', { url: PR_URL, part, reviewed: false }, 2)], { cacheDir: store });
    expect(cleared[1]!.result).toEqual({ marks: [] });
    await removeCopy(store);
  });

  it('refuses a mark whose part is not a name with content hashes', async () => {
    const responses = await serveInOrder(
      [initialize, request('markReviewed', { url: PR_URL, part: { name: 'x', pieces: ['../escape'] }, reviewed: true }, 2), request('reviewedMarks', { url: 'https://example.com/x' }, 3)],
      { cacheDir },
    );

    expect(responses[1]!.error!.code).toBe(JSON_RPC_INVALID_PARAMS);
    expect(responses[2]!.error!.code).toBe(JSON_RPC_INVALID_PARAMS);
  });

  it('marks on GitHub only the files whose every part is reviewed, with the request’s token', async () => {
    const store = temporaryCacheDir();
    const transport = viewedFetch();
    const reviewed = await serveInOrder([initialize, request('review', { url: PR_URL, token: TOKEN }, 2)], { fetch: transport.fetch, cacheDir: store });
    const parts = (reviewed[1]!.result as ReviewResult).parts;
    const [first, second] = parts;
    const lines = [
      initialize,
      request('review', { url: PR_URL, token: TOKEN }, 2),
      request('markReviewed', { url: PR_URL, part: markedPart(first!), reviewed: true }, 3),
      request('markViewed', { url: PR_URL, token: TOKEN, paths: [first!.path, second!.path] }, 4),
    ];
    const responses = await serveInOrder(lines, { fetch: transport.fetch, cacheDir: store });

    // Each recorded file is one part: the first is reviewed, the second is not.
    expect(responses[3]!.result).toEqual({ paths: [first!.path] });
    expect(transport.marked).toEqual([first!.path]);
    expect(transport.tokens.every((header) => header === `token ${TOKEN}`)).toBe(true);
    await removeCopy(store);
  });

  it('refuses to mirror a pull request it holds no finished review of, and calls GitHub for nothing', async () => {
    const transport = viewedFetch();
    const responses = await serveInOrder([initialize, request('markViewed', { url: PR_URL, token: TOKEN, paths: ['web/cart.ts'] }, 2)], { fetch: transport.fetch, cacheDir });

    expect(responses[1]!.error!.code).toBe(ENGINE_FAILED_CODE);
    expect(responses[1]!.error!.message).toContain('review the pull request again');
    expect(transport.marked).toEqual([]);
  });

  it('redacts the token from a mirror GitHub refused', async () => {
    const store = temporaryCacheDir();
    const transport = fixtureFetch();
    const refusing: typeof fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const body = typeof init?.body === 'string' ? init.body : '';
      if (url === GRAPHQL && body.includes('{ id }')) return Response.json({ data: null, errors: [{ message: `bad credentials ${TOKEN}` }] });
      return transport.fetch(input, init);
    };
    const reviewed = await serveInOrder([initialize, request('review', { url: PR_URL, token: TOKEN }, 2)], { fetch: refusing, cacheDir: store });
    const parts = (reviewed[1]!.result as ReviewResult).parts;
    const lines = [
      initialize,
      request('review', { url: PR_URL, token: TOKEN }, 2),
      ...parts.map((part, index) => request('markReviewed', { url: PR_URL, part: markedPart(part), reviewed: true }, 3 + index)),
      request('markViewed', { url: PR_URL, token: TOKEN, paths: [parts[0]!.path] }, 3 + parts.length),
    ];
    const responses = await serveInOrder(lines, { fetch: refusing, cacheDir: store });

    const failed = responses.at(-1)!;
    expect(failed.error!.message).toContain("GitHub's pull-request-id query failed: bad credentials [REDACTED]");
    expect(failed.error!.message).not.toContain(TOKEN);
    await removeCopy(store);
  });
});

describe('runRpcServer listing pull requests', () => {
  const initialize = request('initialize', { protocolVersion: ENGINE_PROTOCOL_VERSION });

  /** A fetch that answers every search with the recorded search of the reviewer's own pull requests, keeping the tokens it carried. */
  function searchFetch(): { fetch: typeof fetch; tokens: (string | null)[] } {
    const tokens: (string | null)[] = [];
    const answer = readFileSync(fileURLToPath(new URL('./fixtures/pull-requests/yours.json', import.meta.url)), 'utf8');
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url !== 'https://api.github.com/graphql') throw new Error(`unexpected request to ${url}`);
      tokens.push(new Headers(init?.headers).get('authorization'));
      return new Response(answer, { status: 200, headers: { 'content-type': 'application/json; charset=utf-8' } });
    };
    return { fetch: fetchImpl, tokens };
  }

  it('lists the reviewer’s open pull requests in their groups with the request’s token', async () => {
    const github = searchFetch();

    const responses = await serve([initialize, request('pullRequests/list', { token: TOKEN, repository: 'example-org/example-repo' }, 2)], github.fetch);

    const list = responses[1]!.result as PullRequestList;
    expect(list.outcome).toBe('listed');
    if (list.outcome !== 'listed') return;
    expect(list.groups.map(({ group, pullRequests }) => ({ group, numbers: pullRequests.map(({ number }) => number) }))).toEqual([
      { group: 'review requested', numbers: [7] },
      { group: 'yours', numbers: [] },
      { group: 'involving you', numbers: [] },
      { group: 'this repository', numbers: [] },
    ]);
    expect(github.tokens).toEqual(Array(4).fill(`token ${TOKEN}`));
  });

  it('answers a request without a token with the plain reason, asking GitHub nothing', async () => {
    const github = searchFetch();

    const responses = await serve([initialize, request('pullRequests/list', {}, 2)], github.fetch);

    expect(responses[1]!.result).toEqual({ outcome: 'signed out', reason: 'Not signed in to GitHub: sign in to list your pull requests.' });
    expect(github.tokens).toEqual([]);
  });

  it('answers GitHub out of reach with the plain reason', async () => {
    const offline = failingFetch(new TypeError('fetch failed', { cause: new Error('connect ECONNREFUSED') }));

    const responses = await serve([initialize, request('pullRequests/list', { token: TOKEN }, 2)], offline);

    expect(responses[1]!.result).toEqual({ outcome: 'unreachable', reason: 'GitHub could not be reached (connect ECONNREFUSED): check the connection and try again.' });
  });

  it('refuses a list before the handshake, and params that are not a token and an owner/name repository', async () => {
    const responses = await serve([
      request('pullRequests/list', { token: TOKEN }),
      request('initialize', { protocolVersion: ENGINE_PROTOCOL_VERSION }, 2),
      request('pullRequests/list', { token: 42 }, 3),
      request('pullRequests/list', { token: TOKEN, repository: 'example-org/example-repo is:closed' }, 4),
    ]);

    expect(responses[0]!.error).toMatchObject({ code: NOT_INITIALIZED_CODE });
    expect(responses[0]!.error!.message).toContain('initialize before pullRequests/list');
    for (const refused of responses.slice(2)) {
      expect(refused.error).toEqual({ code: JSON_RPC_INVALID_PARAMS, message: 'pullRequests/list needs params: { "token"?: string, "repository"?: "owner/name" }' });
    }
  });

  it('redacts the token from a search GitHub answered with an error', async () => {
    const failing: typeof fetch = async () => Response.json({ data: null, errors: [{ message: `bad credentials ${TOKEN}` }] });

    const responses = await serve([initialize, request('pullRequests/list', { token: TOKEN }, 2)], failing);

    expect(responses[1]!.error!.code).toBe(ENGINE_FAILED_CODE);
    expect(responses[1]!.error!.message).toBe("GitHub's pull-request search failed: bad credentials [REDACTED]");
  });
});
