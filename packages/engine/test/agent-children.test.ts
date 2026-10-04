import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { stopAgentChildren } from '../src/agent-children.js';
import { fakePi } from './fake-pi.js';

const ENGINE_WITH_AGENT = fileURLToPath(new URL('./fixtures/engine-with-agent.ts', import.meta.url));

/** Runs the TypeScript engine fixture as a process, through vite-node. */
function viteNode(): string {
  const require = createRequire(import.meta.url);
  return join(dirname(require.resolve('vite-node/package.json')), 'vite-node.mjs');
}

/** The process id the fake agent recorded for its running run. */
async function runPid(dir: string): Promise<number> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const pid = recordedPid(dir);
    if (pid !== undefined) return pid;
    if (Date.now() > deadline) throw new Error('the fake agent did not start in time');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function recordedPid(dir: string): number | undefined {
  let lines: string[];
  try {
    lines = readFileSync(join(dir, 'calls.jsonl'), 'utf8').split('\n');
  } catch {
    return undefined;
  }
  for (const line of lines.reverse()) {
    if (!line.startsWith('{"kind":"run"')) continue;
    return (JSON.parse(line) as { pid?: number }).pid;
  }
  return undefined;
}

/** Whether a process id is still running, by asking the kernel, harmlessly. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Waits until the process id is gone, and fails the test if it stays. */
async function gone(pid: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (alive(pid) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  expect(alive(pid)).toBe(false);
}

/** The engine's first output line, or a failure saying it never came. */
function firstLine(child: ChildProcess): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('the engine said nothing in time')), 30_000);
    const lines = createInterface({ input: child.stdout! });
    lines.once('line', (line) => {
      clearTimeout(timer);
      lines.close();
      resolve(line);
    });
    child.once('exit', () => reject(new Error('the engine exited before it said anything')));
  });
}

describe('stopAgentChildren', () => {
  it('stops a running agent child the adapter started', async () => {
    const agent = fakePi({ runs: [{ hang: true }] });
    const run = agent.adapter.run({
      root: agent.dir,
      instructions: 'Instructions.',
      prompt: 'Run.',
      timeoutMs: 60_000,
    });
    const pid = await runPid(agent.dir);
    expect(alive(pid)).toBe(true);

    await stopAgentChildren(200);
    await gone(pid);
    expect((await run).status).toBe('failed');
  }, 30_000);

  it('kills an agent child that ignores the request to stop', async () => {
    const agent = fakePi({ runs: [{ hang: true, ignoreTerm: true }] });
    const run = agent.adapter.run({
      root: agent.dir,
      instructions: 'Instructions.',
      prompt: 'Run.',
      timeoutMs: 60_000,
    });
    const pid = await runPid(agent.dir);

    await stopAgentChildren(200);
    await gone(pid);
    await run;
  }, 30_000);
});

describe('the engine told to stop', () => {
  it('stops its running agent child before it dies of the signal', async () => {
    const engine = spawn(process.execPath, [viteNode(), ENGINE_WITH_AGENT], {
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    const { dir } = JSON.parse(await firstLine(engine)) as { dir: string };
    const pid = await runPid(dir);
    expect(alive(pid)).toBe(true);

    engine.kill('SIGTERM');
    const exited = new Promise<void>((resolve) => engine.once('exit', () => resolve()));
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 15_000))]);
    expect(engine.exitCode !== null || engine.signalCode !== null).toBe(true);
    await gone(pid);
  }, 60_000);
});
