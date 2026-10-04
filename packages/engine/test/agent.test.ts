import { describe, expect, it } from 'vitest';
import {
  DEFAULT_AGENT_SETTINGS,
  parseAnswer,
  runAgentTasks,
  type AgentAdapter,
  type AgentProbe,
  type AgentStamp,
} from '../src/agent.js';
import { validateJson, type JsonSchema } from '../src/json-schema.js';

const SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['name', 'count', 'tags'],
  properties: {
    name: { type: 'string' },
    count: { type: ['integer', 'null'] },
    ratio: { type: 'number' },
    kind: { enum: ['a', 'b'] },
    tags: { type: 'array', items: { type: 'string' } },
  },
};

describe('validateJson', () => {
  it('accepts a value that meets the schema', () => {
    expect(validateJson({ name: 'x', count: 3, ratio: 2, tags: ['t'], kind: 'a' }, SCHEMA)).toEqual([]);
    expect(validateJson({ name: 'x', count: null, ratio: 0.5, tags: [] }, SCHEMA)).toEqual([]);
  });

  it('names every problem with the pointer of its value', () => {
    expect(validateJson({ name: 1, count: 1.5, tags: ['t', 2], kind: 'c', extra: true }, SCHEMA)).toEqual([
      '/name should be string, not integer',
      '/count should be integer or null, not number',
      '/tags/1 should be string, not integer',
      '/kind should be one of "a", "b"',
      'the answer has an unexpected "extra"',
    ]);
  });

  it('reports missing required fields and a wrong top-level type', () => {
    expect(validateJson({ name: 'x' }, SCHEMA)).toEqual(['the answer is missing "count"', 'the answer is missing "tags"']);
    expect(validateJson([], SCHEMA)).toEqual(['the answer should be object, not array']);
    expect(validateJson(null, SCHEMA)).toEqual(['the answer should be object, not null']);
  });
});

describe('parseAnswer', () => {
  it('reads a single JSON value, alone or in one fenced block', () => {
    expect(parseAnswer(' {"a":1}\n')).toEqual({ value: { a: 1 } });
    expect(parseAnswer('```json\n{"a":1}\n```')).toEqual({ value: { a: 1 } });
    expect(parseAnswer('```\n[1]\n```')).toEqual({ value: [1] });
  });

  it('never digs an answer out of surrounding prose', () => {
    expect(parseAnswer('Sure! {"a":1}')).toEqual({ error: 'the answer is not a single JSON value' });
    expect(parseAnswer('{"a":1} and {"b":2}')).toMatchObject({ error: expect.any(String) });
    expect(parseAnswer('')).toMatchObject({ error: expect.any(String) });
  });
});

describe('DEFAULT_AGENT_SETTINGS', () => {
  it('gives each run five minutes and runs two at once', () => {
    expect(DEFAULT_AGENT_SETTINGS).toEqual({ timeoutMs: 300_000, concurrency: 2 });
  });
});

const ANSWER_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['verdict'],
  properties: { verdict: { enum: ['yes', 'no'] } },
};

/** A stub adapter that always answers with the stamp it was given; no real agent runs. */
function stubAgent(options: { stamp?: AgentStamp; probe?: Partial<AgentProbe> } = {}): AgentAdapter {
  const stamp: AgentStamp = options.stamp ?? {
    agent: 'fake',
    agentVersion: '1.2.3',
    model: 'fake/model',
    effort: null,
    runAt: '2026-10-05T00:00:00.000Z',
  };
  return {
    agent: 'fake',
    probe: async () => ({
      agent: 'fake',
      version: '1.2.3',
      usable: true,
      supports: { effort: false },
      lockdown: [],
      ...options.probe,
    }),
    run: async () => ({ status: 'completed', text: '{"verdict":"yes"}', stamp }),
  };
}

describe('runAgentTasks with the account label', () => {
  const task = { root: '.', instructions: 'fixed', prompt: 'answer', schema: ANSWER_SCHEMA };

  it('stamps the reviewer\u2019s account label from the settings on every result', async () => {
    const { results } = await runAgentTasks(stubAgent(), [task], {
      ...DEFAULT_AGENT_SETTINGS,
      account: 'Claude Max (work)',
    });

    expect(results[0]!.ok).toBe(true);
    expect(results[0]!.stamp.account).toBe('Claude Max (work)');
  });

  it('stamps the label on a failed probe too, and stamps nothing without one', async () => {
    const unusable = stubAgent({ probe: { usable: false, reason: 'not installed' } });
    const labelled = await runAgentTasks(unusable, [task], {
      ...DEFAULT_AGENT_SETTINGS,
      account: 'Pi personal key',
    });
    expect(labelled.results[0]).toMatchObject({ ok: false, stamp: { account: 'Pi personal key' } });

    const unlabelled = await runAgentTasks(stubAgent(), [task], DEFAULT_AGENT_SETTINGS);
    expect(unlabelled.results[0]!.stamp).not.toHaveProperty('account');
  });
});
