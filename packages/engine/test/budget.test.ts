import { describe, expect, it } from 'vitest';
import { runAgentTasks, type AgentTask } from '../src/agent.js';
import { NO_BUDGET_LIMITS, budgetLimitsProblem, budgetMeter, budgetOf, meteredFetch } from '../src/budget.js';
import { scriptedAgent } from './helpers.js';

/** A fetch that answers each request with the given body chunks, recording the requests. */
function chunkedFetch(chunks: readonly string[], init: ResponseInit = {}): { fetch: typeof fetch; urls: string[] } {
  const urls: string[] = [];
  return {
    urls,
    fetch: async (input) => {
      urls.push(String(input));
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
          controller.close();
        },
      });
      return new Response(body, { status: 200, headers: { 'content-type': 'text/plain' }, ...init });
    },
  };
}

describe('budgetMeter', () => {
  it('starts with nothing used, and no limits when none are given', () => {
    expect(budgetOf(budgetMeter())).toEqual({
      limits: { agentRuns: 0, filesFetched: 0, downloadMiB: 0 },
      used: { agentRuns: 0, filesFetched: 0, downloadBytes: 0 },
    });
    expect(budgetMeter(NO_BUDGET_LIMITS).limits).not.toBe(NO_BUDGET_LIMITS);
  });

  it('keeps only the three limits it meters', () => {
    const limits = { agentRuns: 3, filesFetched: 40, downloadMiB: 2.5, extra: 1 };
    expect(budgetMeter(limits).limits).toEqual({ agentRuns: 3, filesFetched: 40, downloadMiB: 2.5 });
  });
});

describe('meteredFetch', () => {
  it('counts each response as one file and its bytes as they stream through', async () => {
    const meter = budgetMeter();
    const transport = chunkedFetch(['abc', 'defgh']);
    const fetchImpl = meteredFetch(transport.fetch, meter);

    const response = await fetchImpl('https://example.com/a');
    // The file counts at once; its bytes only as the body is read.
    expect(meter.used).toEqual({ agentRuns: 0, filesFetched: 1, downloadBytes: 0 });
    expect(await response.text()).toBe('abcdefgh');
    expect(meter.used).toEqual({ agentRuns: 0, filesFetched: 1, downloadBytes: 8 });

    await (await fetchImpl('https://example.com/b')).arrayBuffer();
    expect(meter.used).toEqual({ agentRuns: 0, filesFetched: 2, downloadBytes: 16 });
    expect(transport.urls).toEqual(['https://example.com/a', 'https://example.com/b']);
  });

  it('keeps the response as it came: status, headers, URL and redirect flag', async () => {
    const meter = budgetMeter();
    const original = new Response('missing', { status: 404, statusText: 'Not Found', headers: { 'x-test': 'yes' } });
    Object.defineProperties(original, { url: { value: 'https://example.com/gone' }, redirected: { value: true } });
    const response = await meteredFetch(async () => original, meter)('https://example.com/gone');

    expect(response.status).toBe(404);
    expect(response.ok).toBe(false);
    expect(response.statusText).toBe('Not Found');
    expect(response.headers.get('x-test')).toBe('yes');
    expect(response.url).toBe('https://example.com/gone');
    expect(response.redirected).toBe(true);
    expect(await response.text()).toBe('missing');
    expect(meter.used).toEqual({ agentRuns: 0, filesFetched: 1, downloadBytes: 7 });
  });

  it('counts a response with no body as a file of no bytes', async () => {
    const meter = budgetMeter();
    const response = await meteredFetch(async () => new Response(null, { status: 204 }), meter)('https://example.com/');
    expect(response.status).toBe(204);
    expect(meter.used).toEqual({ agentRuns: 0, filesFetched: 1, downloadBytes: 0 });
  });

  it('counts nothing for a request that never answered', async () => {
    const meter = budgetMeter();
    const failing = meteredFetch(async () => {
      throw new TypeError('fetch failed');
    }, meter);
    await expect(failing('https://example.com/')).rejects.toThrow('fetch failed');
    expect(meter.used).toEqual({ agentRuns: 0, filesFetched: 0, downloadBytes: 0 });
  });
});

describe('runAgentTasks on a budget', () => {
  const task: AgentTask = {
    root: '/copy',
    instructions: 'Answer.',
    prompt: 'Answer.',
    schema: { type: 'object', required: ['ok'], properties: { ok: { type: 'boolean' } } },
  };

  it('counts every started attempt, the retry included', async () => {
    const meter = budgetMeter({ agentRuns: 1, filesFetched: 0, downloadMiB: 0 });
    // The first task answers at once; the second is retried after an invalid answer.
    const agent = scriptedAgent(['{"ok":true}', 'not json', '{"ok":true}']);
    const { results } = await runAgentTasks(agent, [task, task], { timeoutMs: 1000, concurrency: 1, budget: meter });

    expect(results.map((result) => result.attempts)).toEqual([1, 2]);
    expect(agent.requests).toHaveLength(3);
    expect(meter.used.agentRuns).toBe(3);
    // Nothing is refused yet: the limit of one run only counts.
    expect(results.every((result) => result.ok)).toBe(true);
  });

  it('counts a run that times out, and no run for an agent it never started', async () => {
    const meter = budgetMeter();
    const timingOut = { ...scriptedAgent([]), run: async () => ({ status: 'timeout' as const, text: '', stamp: { agent: 'fake', agentVersion: '1', model: null, effort: null, runAt: '2026-10-10T00:00:00.000Z' } }) };
    await runAgentTasks(timingOut, [task], { timeoutMs: 1000, concurrency: 1, budget: meter });
    expect(meter.used.agentRuns).toBe(1);

    const unusable = scriptedAgent([], { usable: false, reason: 'too old' });
    await runAgentTasks(unusable, [task, task], { timeoutMs: 1000, concurrency: 1, budget: meter });
    expect(meter.used.agentRuns).toBe(1);
  });
});

describe('budgetLimitsProblem', () => {
  it('accepts three limits of 0 or more, a fraction of a mebibyte included', () => {
    expect(budgetLimitsProblem({ agentRuns: 0, filesFetched: 0, downloadMiB: 0 })).toBeUndefined();
    expect(budgetLimitsProblem({ agentRuns: 12, filesFetched: 300, downloadMiB: 0.5 })).toBeUndefined();
  });

  it('refuses anything else, naming the shape', () => {
    for (const value of [
      null,
      [],
      'none',
      { agentRuns: -1, filesFetched: 0, downloadMiB: 0 },
      { agentRuns: 1.5, filesFetched: 0, downloadMiB: 0 },
      { agentRuns: 1, filesFetched: '2', downloadMiB: 0 },
      { agentRuns: 1, filesFetched: 2 },
      { agentRuns: 1, filesFetched: 2, downloadMiB: -0.1 },
      { agentRuns: 1, filesFetched: 2, downloadMiB: Number.POSITIVE_INFINITY },
    ]) {
      expect(budgetLimitsProblem(value)).toContain('the budget must be { "agentRuns": number, "filesFetched": number, "downloadMiB": number }');
    }
  });
});
