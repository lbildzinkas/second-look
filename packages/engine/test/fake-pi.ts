import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { piAdapter } from '../src/pi.js';
import {
  AGENT_OWN_LOGIN,
  ENGINE_GITHUB_TOKEN,
  type ContractAgent,
  type ContractRun,
  type ContractScenario,
  type RecordedRun,
} from './agent-contract.js';

export const FAKE_PI = fileURLToPath(new URL('./fixtures/fake-pi.mjs', import.meta.url));
export const GUARD = fileURLToPath(new URL('../src/pi-guard.ts', import.meta.url));

export interface FakeCall extends RecordedRun {
  kind: 'run' | 'end';
  args: string[];
  stdin: string;
}

/** A scenario for the fake Pi: the contract's, plus Pi's own details. */
export interface FakePiScenario extends ContractScenario {
  /** Flags the fake's help leaves out. */
  missingFlags?: string[];
  runs: (ContractRun & { toolUse?: boolean })[];
}

/** A fake Pi playing the scenario, and the calls it recorded. */
export function fakePi(
  scenario: FakePiScenario,
  options: { guardPath?: string; env?: NodeJS.ProcessEnv } = {},
): ContractAgent & { calls(): FakeCall[]; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'second-look-fake-pi-'));
  const missingFlags = scenario.missingFlags ?? (scenario.lacksLockdown ? ['--no-context-files'] : []);
  writeFileSync(join(dir, 'scenario.json'), JSON.stringify({ ...scenario, missingFlags }));
  const adapter = piAdapter({
    command: scenario.notInstalled ? [join(dir, 'no-such-pi')] : [process.execPath, FAKE_PI],
    guardPath: options.guardPath ?? GUARD,
    env: {
      ...options.env,
      PATH: process.env['PATH'],
      FAKE_PI_DIR: dir,
      GITHUB_TOKEN: ENGINE_GITHUB_TOKEN,
      GH_TOKEN: ENGINE_GITHUB_TOKEN,
      FAKE_AGENT_LOGIN: AGENT_OWN_LOGIN,
    },
    killGraceMs: 200,
  });
  const calls = (): FakeCall[] => {
    try {
      return readFileSync(join(dir, 'calls.jsonl'), 'utf8')
        .split('\n')
        .filter((line) => line !== '')
        .map((line) => JSON.parse(line) as FakeCall);
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
