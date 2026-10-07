import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DEFAULT_EFFORT, TESTED_RANKINGS } from '../src/ranking.js';
import { TESTED_MODELS, isTestedModel } from '../src/tested-models.js';
import type { TestedModel } from '../src/tested-models.js';

const TESTED: readonly TestedModel[] = [
  { agent: 'pi', agentVersion: '0.86.1', model: 'provider/tested', effort: DEFAULT_EFFORT, runDate: '2026-10-07T15:08:38.849Z', scores: { coverage: 1 } },
  { agent: 'pi', agentVersion: '0.86.1', model: 'provider/tested', effort: 'high', runDate: '2026-10-08T15:08:38.849Z', scores: { coverage: 1 } },
];

describe('isTestedModel', () => {
  it('matches the agent, model and effort, with the version published but not matched', () => {
    expect(isTestedModel(TESTED, 'pi', 'provider/tested')).toBe(true);
    expect(isTestedModel(TESTED, 'pi', 'provider/tested', DEFAULT_EFFORT)).toBe(true);
    expect(isTestedModel(TESTED, 'pi', 'provider/tested', 'high')).toBe(true);
    // The installed version drifts with the reviewer's machine, so the
    // match ignores it.
    expect(isTestedModel([{ ...TESTED[0]!, agentVersion: '9.9.9' }], 'pi', 'provider/tested')).toBe(true);
  });

  it('matches no other agent, model or effort', () => {
    expect(isTestedModel(TESTED, 'claude-code', 'provider/tested')).toBe(false);
    expect(isTestedModel(TESTED, 'pi', 'provider/untested')).toBe(false);
    expect(isTestedModel(TESTED, 'pi', 'provider/tested', 'low')).toBe(false);
    expect(isTestedModel(TESTED, 'pi', null)).toBe(false);
  });
});

describe('TESTED_MODELS', () => {
  it('keeps every ranking default a tested model', () => {
    // The agent ranking is the default only for a tested combination, so
    // every entry of TESTED_RANKINGS must name one.
    for (const ranking of TESTED_RANKINGS) {
      expect(isTestedModel(TESTED_MODELS, ranking.agent, ranking.model, ranking.effort)).toBe(true);
    }
  });

  it('publishes the current list on the docs page, in step with the constant', async () => {
    const page = await readFile(fileURLToPath(new URL('../../../docs/tested-models.md', import.meta.url)), 'utf8');
    expect(page).toContain('# The tested models');
    for (const model of TESTED_MODELS) {
      for (const field of [model.agentVersion, model.model, model.effort, model.runDate]) {
        expect(page).toContain(field);
      }
    }
  });
});
