import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { ASK_KINDS, ASKS } from '@second-look/engine';
import { askCommand, REVIEW_COMMAND } from '../src/commands.js';
import { activate } from '../src/extension.js';
import { anchorOf } from '../src/tree.js';
import { claimsResult, judgedResult } from './results.js';
import { stub, stubContext } from './vscode-stub.js';

interface Manifest {
  contributes: {
    commands: { command: string; title: string }[];
    menus: Record<string, { command: string; when: string; group?: string }[]>;
  };
}

const MANIFEST = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8')) as Manifest;

describe('the asks in the manifest', () => {
  it("declares one command for each ask in the engine's registry, titled as the registry names it", () => {
    const declared = MANIFEST.contributes.commands.filter((command) => command.command.startsWith('second-look.ask.'));
    expect(declared).toEqual(ASK_KINDS.map((kind) => ({ command: askCommand(kind), title: ASKS[kind].title, category: 'Second Look' })));
    expect(askCommand('explain')).toBe('second-look.ask.explain');
  });

  it("offers each ask in a part row's context menu in the side bar, and hides it from the Command Palette", () => {
    const { menus } = MANIFEST.contributes;
    for (const kind of ASK_KINDS) {
      const entries = menus['webview/context']!.filter((entry) => entry.command === askCommand(kind));
      expect(entries.map((entry) => entry.when)).toEqual(["webviewId == 'second-look.reviewTree' && webviewSection == 'part'"]);
      expect(menus['commandPalette']).toContainEqual({ command: askCommand(kind), when: 'false' });
    }
  });
});

const FAKE_ENGINE = fileURLToPath(new URL('./fixtures/fake-engine.mjs', import.meta.url));
const PR_URL = 'https://github.com/example-org/example-repo/pull/42';
const TOKEN = 'ghp_test-token-do-not-print';
const workDir = mkdtempSync(join(tmpdir(), 'second-look-asks-'));

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
});

/** The verify ask as the side bar runs it, driven end to end against a fake engine
 * process that speaks the engine's real stdio protocol: the session the
 * activation builds, its quick picks, and the ask requests that reach the
 * engine, read from the log the fake engine keeps. */
describe('the verify ask the side bar runs', () => {
  beforeEach(() => stub.reset());

  /** Starts the extension against a fake engine answering with the result and ask answer given. */
  async function reviewWith(result: unknown, askResult: unknown, logName: string): Promise<void> {
    activate(stubContext() as never, {
      spawnEngine: (): ChildProcessWithoutNullStreams =>
        spawn(process.execPath, [FAKE_ENGINE], {
          stdio: ['pipe', 'pipe', 'pipe'],
          env: {
            ...process.env,
            FAKE_ENGINE_RESULT: JSON.stringify(result),
            FAKE_ENGINE_ASK_RESULT: JSON.stringify(askResult),
            FAKE_ENGINE_LOG: join(workDir, logName),
          },
        }),
    });
    stub.inputBoxResult = PR_URL;
    stub.session = { accessToken: TOKEN };
    await stub.commands.find((command) => command.id === REVIEW_COMMAND)!.handler();
  }

  /** The params of the ask requests that reached the engine, as the fake engine logged them. */
  function asks(logName: string): Record<string, unknown>[] {
    return readFileSync(join(workDir, logName), 'utf8')
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => JSON.parse(line) as { method?: string; params?: Record<string, unknown> })
      .filter((request) => request.method === 'ask')
      .flatMap((request) => (request.params === undefined ? [] : [request.params]));
  }

  it('picks the claim from the whole review when no part is named, and asks the claim the side bar names with no pick', async () => {
    const shown = judgedResult();
    const answer = {
      ask: 'verify',
      part: 0,
      partName: 'src/retry.py',
      sections: [{ heading: 'Verdict', text: 'verified, from the change itself: send retries a failed delivery.' }],
      cited: [{ path: 'src/retry.py', side: 'head' as const, line: 5, quote: 'return retry(send)' }],
      promptVersion: '5',
      stamp: { agent: 'pi', agentVersion: '0.86.1', model: 'zai/glm-4.6', effort: null, runAt: '2026-10-07T00:00:00.000Z' },
      claim: {
        index: 1,
        claim: {
          ...shown.claims!.claims[1]!,
          verdict: { kind: 'verified', source: 'the change itself', reason: 'send retries a failed delivery.', evidence: [{ path: 'src/retry.py', line: 5, quote: 'return retry(send)' }] },
        },
      },
    };
    await reviewWith(shown, answer, 'verify-pick.log');
    const verify = stub.commands.find((command) => command.id === askCommand('verify'))!.handler;

    // With no part named — the side bar's Verify a claim… — the reviewer picks from every claim of the review.
    stub.quickPickResult = { index: 1 };
    await verify();
    expect(stub.quickPicks).toEqual([
      {
        title: 'Verify this claim',
        items: shown.claims!.claims.map((claim) => expect.objectContaining({ label: claim.quote })),
      },
    ]);
    expect(asks('verify-pick.log')).toEqual([expect.objectContaining({ ask: 'verify', part: 0, claim: { index: 1 } })]);

    // With the claim named — a finding's Verify again — no pick: the ask names it alone.
    stub.quickPickResult = undefined;
    await verify({ anchor: anchorOf(shown.parts[0]!), claim: 2 });
    expect(stub.quickPicks).toHaveLength(1);
    expect(asks('verify-pick.log')).toEqual([
      expect.objectContaining({ ask: 'verify', part: 0, claim: { index: 1 } }),
      expect.objectContaining({ ask: 'verify', part: 0, claim: { index: 2 } }),
    ]);
    expect(stub.errorMessages).toEqual([]);
  });

  it('says why and asks nothing when the review listed no claim', async () => {
    const shown = claimsResult();
    shown.claims = { ...shown.claims!, claims: [] };
    await reviewWith(shown, undefined, 'verify-none.log');
    stub.quickPickResult = { index: 0 };
    await stub.commands.find((command) => command.id === askCommand('verify'))!.handler();
    expect(stub.quickPicks).toEqual([]);
    expect(asks('verify-none.log')).toEqual([]);
    expect(stub.informationMessages).toEqual(['No claim to verify: it shows once the review lists the claims.']);
  });
});
