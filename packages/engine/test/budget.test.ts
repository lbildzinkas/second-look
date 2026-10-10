import { describe, expect, it } from 'vitest';
import { agentRunLimitReason, runAgentTasks, type AgentTask } from '../src/agent.js';
import {
  BudgetLimitError,
  NO_BUDGET_LIMITS,
  budgetLimitsProblem,
  budgetMeter,
  budgetOf,
  hasAgentRunLeft,
  limitReason,
  limitedFetch,
  meteredFetch,
  spentLimit,
} from '../src/budget.js';
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
    // Settings that do not stop at the budget only count, as for the reviewer's asks and drafts.
    expect(results.every((result) => result.ok)).toBe(true);
  });

  it('starts a task only while a run is left, and its retry only while another is, saying which limit stopped it', async () => {
    const meter = budgetMeter({ agentRuns: 1, filesFetched: 0, downloadMiB: 0 });
    const agent = scriptedAgent(['not json', '{"ok":true}']);
    const settings = { timeoutMs: 1000, concurrency: 1, budget: meter, stopAtBudget: true };
    const { results } = await runAgentTasks(agent, [task, task], settings);

    expect(agent.requests).toHaveLength(1);
    expect(meter.used.agentRuns).toBe(1);
    expect(results[0]).toMatchObject({
      ok: false,
      reason: 'budget-limit',
      attempts: 1,
      message:
        'the answer was invalid (the answer is not a single JSON value) and was not retried: the review used its 1 agent run; raise `second-look.budget.agentRuns` to retry it',
      stamp: { agent: 'fake', model: 'fake/model' },
    });
    expect(results[1]).toMatchObject({
      ok: false,
      reason: 'budget-limit',
      attempts: 0,
      message: 'the agent was not run: the review used its 1 agent run; raise `second-look.budget.agentRuns` to run it',
      stamp: { agent: 'fake', agentVersion: '1.2.3', model: null },
    });
    expect(agentRunLimitReason(results[1]!, settings, 'check it')).toBe('the review used its 1 agent run; raise `second-look.budget.agentRuns` to check it');
  });

  it('lets no two tasks running at once take the same last run', async () => {
    const meter = budgetMeter({ agentRuns: 3, filesFetched: 0, downloadMiB: 0 });
    const agent = scriptedAgent(['{"ok":true}', '{"ok":true}', '{"ok":true}']);
    const { results } = await runAgentTasks(agent, [task, task, task, task], { timeoutMs: 1000, concurrency: 4, budget: meter, stopAtBudget: true });

    expect(agent.requests).toHaveLength(3);
    expect(results.filter((result) => result.ok)).toHaveLength(3);
    expect(results.filter((result) => !result.ok && result.reason === 'budget-limit')).toHaveLength(1);
  });

  it('has no limit to stop at when the limit is 0', async () => {
    const meter = budgetMeter();
    const agent = scriptedAgent(['not json', '{"ok":true}']);
    const { results } = await runAgentTasks(agent, [task], { timeoutMs: 1000, concurrency: 1, budget: meter, stopAtBudget: true });
    expect(results[0]).toMatchObject({ ok: true, attempts: 2 });
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

describe('the limits', () => {
  it('says which limit is reached, agent runs first, and nothing while every one has room', () => {
    const meter = budgetMeter({ agentRuns: 2, filesFetched: 3, downloadMiB: 1 });
    expect(spentLimit(meter)).toBeUndefined();
    meter.used.downloadBytes = 1024 * 1024;
    expect(spentLimit(meter)).toBe('downloadMiB');
    meter.used.filesFetched = 3;
    expect(spentLimit(meter)).toBe('filesFetched');
    meter.used.agentRuns = 2;
    expect(hasAgentRunLeft(meter)).toBe(false);
    expect(spentLimit(meter)).toBe('agentRuns');
    // A limit of 0 is never reached.
    expect(spentLimit({ limits: NO_BUDGET_LIMITS, used: { agentRuns: 99, filesFetched: 99, downloadBytes: 1e9 } })).toBeUndefined();
  });

  it('names the limit and the setting that raises it', () => {
    const meter = budgetMeter({ agentRuns: 12, filesFetched: 1, downloadMiB: 2.5 });
    expect(limitReason(meter, 'agentRuns', 'check it')).toBe('the review used its 12 agent runs; raise `second-look.budget.agentRuns` to check it');
    expect(limitReason(meter, 'filesFetched', 'fetch it')).toBe('the review fetched its 1 file; raise `second-look.budget.filesFetched` to fetch it');
    expect(limitReason(meter, 'downloadMiB', 'download more')).toBe('the review downloaded its 2.5 MiB; raise `second-look.budget.downloadMiB` to download more');
  });
});

describe('limitedFetch', () => {
  it('counts like the metering fetch while every limit has room', async () => {
    const meter = budgetMeter({ agentRuns: 0, filesFetched: 2, downloadMiB: 1 });
    const transport = chunkedFetch(['abc', 'defgh']);
    expect(await (await limitedFetch(transport.fetch, meter)('https://example.com/a')).text()).toBe('abcdefgh');
    expect(meter.used).toEqual({ agentRuns: 0, filesFetched: 1, downloadBytes: 8 });
  });

  it('starts no download once the files fetched reach their limit, naming it', async () => {
    const meter = budgetMeter({ agentRuns: 0, filesFetched: 1, downloadMiB: 0 });
    const transport = chunkedFetch(['abc']);
    const fetchImpl = limitedFetch(transport.fetch, meter);
    await (await fetchImpl('https://example.com/a')).text();

    const refused = fetchImpl('https://example.com/b');
    await expect(refused).rejects.toBeInstanceOf(BudgetLimitError);
    await expect(refused).rejects.toMatchObject({
      limit: 'filesFetched',
      message: 'the review fetched its 1 file; raise `second-look.budget.filesFetched` to download more',
    });
    expect(transport.urls).toEqual(['https://example.com/a']);
    expect(meter.used.filesFetched).toBe(1);
  });

  it('starts no download once the bytes reach the size limit, and fails a body as it passes it', async () => {
    const meter = budgetMeter({ agentRuns: 0, filesFetched: 0, downloadMiB: 8 / (1024 * 1024) });
    const transport = chunkedFetch(['abcde', 'fghij', 'klm']);
    const fetchImpl = limitedFetch(transport.fetch, meter);

    const passing = (await fetchImpl('https://example.com/a')).text();
    await expect(passing).rejects.toMatchObject({ limit: 'downloadMiB', message: expect.stringContaining('raise `second-look.budget.downloadMiB` to download more') });
    // The chunk that passed the limit is counted, and nothing after it is read.
    expect(meter.used.downloadBytes).toBe(10);
    await expect(fetchImpl('https://example.com/b')).rejects.toMatchObject({ limit: 'downloadMiB' });
    expect(transport.urls).toEqual(['https://example.com/a']);
  });

  it('refuses nothing with no limits', async () => {
    const meter = budgetMeter();
    meter.used = { agentRuns: 0, filesFetched: 500, downloadBytes: 1e9 };
    const transport = chunkedFetch(['abc']);
    expect(await (await limitedFetch(transport.fetch, meter)('https://example.com/a')).text()).toBe('abc');
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
