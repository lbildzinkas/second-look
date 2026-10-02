import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import type { EvaluationCase } from './case.js';

/**
 * One prompt the companion sends an agent, versioned like code (ADR 0006).
 * Its cases are the cases whose `case.json` names its id.
 */
export interface PromptEntry {
  id: string;
  version: string;
  /** The prompt's source files, relative to the repository root. */
  files: string[];
}

/** The prompt registry, `prompts.json`. */
export interface PromptRegistry {
  prompts: PromptEntry[];
}

export async function loadRegistry(path: string): Promise<PromptRegistry> {
  return JSON.parse(await readFile(path, 'utf8')) as PromptRegistry;
}

/**
 * Checks that prompts and cases map onto each other: every prompt a case
 * names is registered, and every registered prompt has at least one case,
 * since no prompt lands without its evaluation. Returns the problems.
 */
export function mappingProblems(
  registry: PromptRegistry,
  cases: readonly EvaluationCase[],
): string[] {
  const known = new Set(registry.prompts.map((prompt) => prompt.id));
  const problems = cases.flatMap((evaluationCase) =>
    evaluationCase.record.prompts
      .filter((id) => !known.has(id))
      .map((id) => `case ${evaluationCase.id} names the unregistered prompt ${id}`),
  );
  for (const prompt of registry.prompts) {
    if (!cases.some((evaluationCase) => evaluationCase.record.prompts.includes(prompt.id))) {
      problems.push(`prompt ${prompt.id} has no case`);
    }
  }
  return problems;
}

/** The prompts whose source files are among the changed paths. */
export function changedPrompts(
  registry: PromptRegistry,
  changedPaths: readonly string[],
): PromptEntry[] {
  const changed = new Set(changedPaths);
  return registry.prompts.filter((prompt) => prompt.files.some((file) => changed.has(file)));
}

/** The cheap subset: the cases tied to any of the given prompts. */
export function casesForPrompts(
  cases: readonly EvaluationCase[],
  prompts: readonly PromptEntry[],
): EvaluationCase[] {
  const ids = new Set(prompts.map((prompt) => prompt.id));
  return cases.filter((evaluationCase) => evaluationCase.record.prompts.some((id) => ids.has(id)));
}

/**
 * The paths this branch changed since it left the given ref, relative to
 * the repository root, as `git diff --name-only <ref>...HEAD` lists them.
 */
export async function changedPathsSince(ref: string, cwd: string): Promise<string[]> {
  if (ref.startsWith('-')) throw new Error(`not a git ref: ${ref}`);
  const { stdout } = await promisify(execFile)(
    'git',
    ['diff', '--name-only', `${ref}...HEAD`, '--'],
    { cwd },
  );
  return stdout.split('\n').filter((line) => line !== '');
}
