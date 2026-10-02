import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { claudeCodeAdapter } from '../src/claude-code.js';
import {
  AGENT_OWN_LOGIN,
  ENGINE_GITHUB_TOKEN,
  type ContractAgent,
  type ContractRun,
  type ContractScenario,
  type RecordedRun,
} from './agent-contract.js';

export const FAKE_CLAUDE = fileURLToPath(new URL('./fixtures/fake-claude.mjs', import.meta.url));

export interface FakeClaudeCall extends RecordedRun {
  kind: 'run' | 'end';
  args: string[];
  stdin: string;
}

/** A scenario for the fake Claude Code: the contract's, plus the flags its help leaves out. */
export interface FakeClaudeScenario extends ContractScenario {
  /** Flags the fake's help leaves out. */
  missingFlags?: string[];
  runs: ContractRun[];
}

/** A fake Claude Code playing the scenario, and the calls it recorded. */
export function fakeClaude(
  scenario: FakeClaudeScenario,
  options: { env?: NodeJS.ProcessEnv } = {},
): ContractAgent & { calls(): FakeClaudeCall[]; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'second-look-fake-claude-'));
  const missingFlags = scenario.missingFlags ?? (scenario.lacksLockdown ? ['--strict-mcp-config'] : []);
  writeFileSync(join(dir, 'scenario.json'), JSON.stringify({ ...scenario, missingFlags }));
  const adapter = claudeCodeAdapter({
    command: scenario.notInstalled ? [join(dir, 'no-such-claude')] : [process.execPath, FAKE_CLAUDE],
    env: {
      ...options.env,
      PATH: process.env['PATH'],
      FAKE_CLAUDE_DIR: dir,
      GITHUB_TOKEN: ENGINE_GITHUB_TOKEN,
      GH_TOKEN: ENGINE_GITHUB_TOKEN,
      FAKE_AGENT_LOGIN: AGENT_OWN_LOGIN,
    },
    killGraceMs: 200,
  });
  const calls = (): FakeClaudeCall[] => {
    try {
      return readFileSync(join(dir, 'calls.jsonl'), 'utf8')
        .split('\n')
        .filter((line) => line !== '')
        .map((line) => JSON.parse(line) as FakeClaudeCall);
    } catch {
      return [];
    }
  };
  return {
    adapter,
    dir,
    calls,
    runs: () => calls().filter((call) => call.kind === 'run').map((call) => ({ ...call, prompt: call.stdin })),
    ends: () => calls().filter((call) => call.kind === 'end').map((call) => call.at),
  };
}
