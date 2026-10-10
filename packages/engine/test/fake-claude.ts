import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSync } from 'esbuild';
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

/**
 * The guard hook, bundled from source into one self-contained script the
 * way the package ships it, since the tests run against source with no
 * build.
 */
export const CLAUDE_GUARD = (() => {
  const outfile = join(mkdtempSync(join(tmpdir(), 'second-look-claude-guard-')), 'claude-guard.mjs');
  buildSync({
    entryPoints: [fileURLToPath(new URL('../src/claude-guard.ts', import.meta.url))],
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node20',
    logLevel: 'silent',
  });
  return outfile;
})();

export interface FakeClaudeCall extends RecordedRun {
  kind: 'run' | 'end' | 'hook';
  args: string[];
  stdin: string;
  /** For a hook call: the tool call, and what the guard hook answered. */
  id?: string;
  tool?: string;
  status?: number | null;
  stdout?: string;
}

/** One tool call a fake run makes, which runs the guard hook first. */
export interface FakeToolCall {
  name: string;
  input: Record<string, unknown>;
  /** Claude Code denies the call by a permission rule, before the hook runs, and reports it in the result. */
  deniedByRule?: boolean;
}

/** A scenario for the fake Claude Code: the contract's, plus Claude Code's own details. */
export interface FakeClaudeScenario extends ContractScenario {
  /** Flags the fake's help leaves out. */
  missingFlags?: string[];
  /** What the fake's help says about a flag, by flag, in place of "A flag"; it may wrap onto further lines. */
  flagHelp?: Record<string, string>;
  runs: (ContractRun & {
    /** Tool calls made before the answer. */
    toolCalls?: FakeToolCall[];
    /** Make the tool calls without running the guard hook, as when hooks are switched off. */
    skipGuard?: boolean;
    /** The permission mode the init event reports instead of the one asked for. */
    permissionMode?: string;
  })[];
}

/** A fake Claude Code playing the scenario, and the calls it recorded. */
export function fakeClaude(
  scenario: FakeClaudeScenario,
  options: { guardPath?: string; env?: NodeJS.ProcessEnv } = {},
): ContractAgent & { calls(): FakeClaudeCall[]; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'second-look-fake-claude-'));
  const missingFlags = scenario.missingFlags ?? (scenario.lacksLockdown ? ['--strict-mcp-config'] : []);
  writeFileSync(join(dir, 'scenario.json'), JSON.stringify({ ...scenario, missingFlags }));
  const adapter = claudeCodeAdapter({
    command: scenario.notInstalled ? [join(dir, 'no-such-claude')] : [process.execPath, FAKE_CLAUDE],
    guardPath: options.guardPath ?? CLAUDE_GUARD,
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
