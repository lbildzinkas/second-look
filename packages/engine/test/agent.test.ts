import { describe, expect, it } from 'vitest';
import { DEFAULT_AGENT_SETTINGS, parseAnswer } from '../src/agent.js';
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
