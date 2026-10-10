import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { stopAgentChildren } from '../../src/agent-children.js';
import { removeCopy } from '../../src/cache.js';
import {
  DEFAULT_SANDBOX_LIMITS,
  probeSandbox,
  runSandboxed,
  runtimeEnv,
  type SandboxRuntime,
} from '../../src/sandbox.js';

/**
 * The live suite for the sandboxed run: it starts real containers through
 * the docker or podman on the machine, so it never runs in `npm test` or
 * `npm run check`. CI runs it on Linux, where Docker is present; a
 * developer opts in with `npm run test:sandbox`.
 *
 * Each run gets a small public image pinned by digest and a copy made
 * here, and proves from inside the container that the host's home
 * folder, the engine's environment and the network are out of reach.
 * Every container is removed when it ends (`--rm`), and the image is
 * removed again unless it was already on the machine.
 */

const IMAGE = 'busybox@sha256:bdf57e528e45e4433820e045b29b4597825a1c9e38353532d90a01445013f82e';

/** A path longer than a tar header's name field, so the copy needs a PAX record. */
const DEEP_PATH = `${'nested-folder-'.repeat(8)}/${'deeper-folder-'.repeat(4)}/deep.txt`;

let runtime: SandboxRuntime;
let copyDir: string;
let imageWasPresent = false;

/** Runs the runtime's CLI with the same minimal environment the engine gives it. */
function runtimeCli(...args: string[]): { status: number | null; stdout: string } {
  const result = spawnSync(runtime.path, args, { env: runtimeEnv(process.env), encoding: 'utf8' });
  return { status: result.status, stdout: result.stdout };
}

/** The names of the sandboxed runs' containers still on the machine, running or not. */
function leftContainers(): string[] {
  return runtimeCli('ps', '-a', '--filter', 'name=second-look-', '--format', '{{.Names}}')
    .stdout.split('\n')
    .filter((line) => line.trim() !== '');
}

beforeAll(() => {
  copyDir = mkdtempSync(join(tmpdir(), 'second-look-sandbox-'));
  writeFileSync(join(copyDir, 'hello.txt'), 'hello from the copy\n', { mode: 0o444 });
  mkdirSync(join(copyDir, DEEP_PATH, '..'), { recursive: true });
  writeFileSync(join(copyDir, DEEP_PATH), 'deep file\n', { mode: 0o444 });
});

afterAll(async () => {
  await removeCopy(copyDir);
  if (runtime && !imageWasPresent) runtimeCli('rmi', IMAGE);
});

describe('a sandboxed run, live', () => {
  it('finds a runtime whose daemon or machine answers', async () => {
    const probe = await probeSandbox();
    if (!probe.usable) throw new Error(probe.reason);
    runtime = probe.runtime;
    imageWasPresent = runtimeCli('image', 'inspect', IMAGE).status === 0;
  });

  it('reaches no host home folder, host environment variable or network from inside the container', async () => {
    const canary = randomUUID();
    const script = [
      'echo "USER=$(id -u):$(id -g)"',
      'echo "HOME=$HOME"',
      'echo "HOMELIST=[$(ls -A ~)]"',
      'test -e "$1" && echo HOSTHOME=present || echo HOSTHOME=absent',
      'env',
      // Only loopback is configured: some kernels add idle tunnel devices to every namespace, but no route leads anywhere.
      'echo "ROUTES=$(tail -n +2 /proc/net/route | wc -l)"',
      'wget -T 3 -q -O /dev/null http://example.com >/dev/null 2>&1 && echo NAMED=reachable || echo NAMED=unreachable',
      'wget -T 3 -q -O /dev/null http://1.1.1.1 >/dev/null 2>&1 && echo ADDRESS=reachable || echo ADDRESS=unreachable',
      'echo "COPY=$(cat hello.txt)"',
      `echo "DEEP=$(cat '${DEEP_PATH}')"`,
      'touch written && echo WORK=writable',
      'touch /etc/written 2>/dev/null && echo ROOT=writable || echo ROOT=read-only',
    ].join('\n');

    const run = await runSandboxed(
      { runtime, image: IMAGE, copy: { commit: 'a'.repeat(40), path: copyDir }, argv: ['sh', '-c', script, 'sh', homedir()] },
      { env: { ...process.env, SECOND_LOOK_SANDBOX_CANARY: canary } },
    );

    expect(run.exitCode, run.output).toBe(0);
    expect(run).toMatchObject({ runtime: runtime.name, image: IMAGE, commit: 'a'.repeat(40) });
    const lines = run.output.split('\n');
    expect(lines).toContain('USER=65534:65534');
    expect(lines).toContain('HOME=/home/second-look');
    expect(lines).toContain('HOMELIST=[]');
    expect(lines).toContain('HOSTHOME=absent');
    expect(run.output).not.toContain(canary);
    expect(run.output).not.toContain('SECOND_LOOK_SANDBOX_CANARY');
    expect(lines).toContain('ROUTES=0');
    expect(lines).toContain('NAMED=unreachable');
    expect(lines).toContain('ADDRESS=unreachable');
    expect(lines).toContain('COPY=hello from the copy');
    expect(lines).toContain('DEEP=deep file');
    expect(lines).toContain('WORK=writable');
    expect(lines).toContain('ROOT=read-only');
    expect(leftContainers()).toEqual([]);
  }, 300_000);

  it('kills the container when the time limit passes', async () => {
    const run = await runSandboxed({
      runtime,
      image: IMAGE,
      copy: { commit: 'a'.repeat(40), path: copyDir },
      argv: ['sleep', '120'],
      limits: { ...DEFAULT_SANDBOX_LIMITS, timeoutMs: 3_000 },
    });

    expect(run.exitCode).toBeNull();
    expect(run.output).toContain('stopped after the time limit of 3 s');
    expect(run.durationMs).toBeLessThan(60_000);
    expect(leftContainers()).toEqual([]);
  }, 120_000);

  it('kills a running container when the engine is told to stop', async () => {
    const running = runSandboxed({
      runtime,
      image: IMAGE,
      copy: { commit: 'a'.repeat(40), path: copyDir },
      argv: ['sleep', '120'],
    });
    const deadline = Date.now() + 60_000;
    while (leftContainers().length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    expect(leftContainers()).toHaveLength(1);

    await stopAgentChildren();
    const run = await running;

    expect(run.exitCode).toBeNull();
    expect(run.output).toContain('stopped because the engine was told to stop');
    expect(leftContainers()).toEqual([]);
  }, 120_000);
});
