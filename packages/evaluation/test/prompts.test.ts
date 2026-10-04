import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { GROUPING_PROMPT_ID, GROUPING_PROMPT_VERSION } from '@second-look/engine';
import type { EvaluationCase } from '../src/case.js';
import {
  casesForPrompts,
  changedPathsSince,
  changedPrompts,
  loadRegistry,
  mappingProblems,
} from '../src/prompts.js';
import type { PromptRegistry } from '../src/prompts.js';

function evaluationCase(id: string, prompts: string[]): EvaluationCase {
  return { id, folder: id, record: { prompts } as EvaluationCase['record'], expected: { noise: {}, importantParts: [], claims: [] } };
}

const REGISTRY: PromptRegistry = {
  prompts: [
    { id: 'story', version: '1', files: ['packages/engine/prompts/story.md'] },
    { id: 'rank', version: '3', files: ['packages/engine/prompts/rank.md', 'packages/engine/prompts/shared.md'] },
  ],
};

const CASES = [
  evaluationCase('plain', []),
  evaluationCase('story-only', ['story']),
  evaluationCase('both', ['story', 'rank']),
];

describe('the prompt to case mapping', () => {
  it('holds when every prompt has a case and every named prompt is registered', () => {
    expect(mappingProblems(REGISTRY, CASES)).toEqual([]);
  });

  it('refuses a prompt with no case and a case naming an unknown prompt', () => {
    const problems = mappingProblems(REGISTRY, [
      evaluationCase('story-only', ['story']),
      evaluationCase('typo', ['stroy']),
    ]);
    expect(problems).toEqual([
      'case typo names the unregistered prompt stroy',
      'prompt rank has no case',
    ]);
  });

  it('selects the cases of the prompts whose files changed', () => {
    const changed = changedPrompts(REGISTRY, ['README.md', 'packages/engine/prompts/shared.md']);
    expect(changed.map((prompt) => prompt.id)).toEqual(['rank']);
    expect(casesForPrompts(CASES, changed).map((each) => each.id)).toEqual(['both']);
    expect(casesForPrompts(CASES, changedPrompts(REGISTRY, ['README.md']))).toEqual([]);
  });
});

describe('changedPathsSince', () => {
  it('lists nothing for a branch compared with itself', async () => {
    expect(await changedPathsSince('HEAD', process.cwd())).toEqual([]);
  });

  it('refuses a ref that reads as an option', async () => {
    await expect(changedPathsSince('--output=x', process.cwd())).rejects.toThrow(
      'not a git ref: --output=x',
    );
  });
});

describe("the repository's prompt registry", () => {
  it('registers the grouping prompt at the version the engine sends', async () => {
    const registry = await loadRegistry(fileURLToPath(new URL('../prompts.json', import.meta.url)));
    expect(registry.prompts).toContainEqual({
      id: GROUPING_PROMPT_ID,
      version: GROUPING_PROMPT_VERSION,
      files: ['packages/engine/src/grouping.ts'],
    });
  });
});

describe('the mapping over other folders', () => {
  it("checks only that a case's prompts are registered, since the prompts' own cases live in the repository", () => {
    const cases = [evaluationCase('private', ['story'])];
    expect(mappingProblems(REGISTRY, cases, { everyPromptHasACase: false })).toEqual([]);
    expect(mappingProblems(REGISTRY, [evaluationCase('private', ['nope'])], { everyPromptHasACase: false })).toEqual([
      'case private names the unregistered prompt nope',
    ]);
  });
});
