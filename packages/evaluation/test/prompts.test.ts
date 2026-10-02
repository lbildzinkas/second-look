import { describe, expect, it } from 'vitest';
import type { EvaluationCase } from '../src/case.js';
import {
  casesForPrompts,
  changedPathsSince,
  changedPrompts,
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
