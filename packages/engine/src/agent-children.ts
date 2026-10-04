import type { ChildProcess } from 'node:child_process';

/**
 * The agent children the engine starts, kept so that none of them
 * outlives it: a review can be stopped while its agent is still grouping,
 * and the agent run the engine started must stop with the engine.
 */

/** The engine's running agent children. */
const running = new Set<ChildProcess>();

/** Remembers one agent child the engine started, until it closes. */
export function trackAgentChild<T extends ChildProcess>(child: T): T {
  running.add(child);
  child.once('close', () => running.delete(child));
  return child;
}

/**
 * Stops every agent child the engine has running. Each is asked to stop
 * with SIGTERM, whatever is still running after `graceMs` is killed
 * outright, and the returned promise settles once every child is going
 * down: when they have all closed, or right after the kills at the
 * latest.
 */
export function stopAgentChildren(graceMs = 2000): Promise<void> {
  const children = [...running];
  running.clear();
  for (const child of children) child.kill('SIGTERM');
  if (children.length === 0) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const stragglers = setTimeout(() => {
      for (const child of children) child.kill('SIGKILL');
      resolve();
    }, graceMs);
    void Promise.all(
      children.map((child) => new Promise<void>((closed) => child.once('close', () => closed()))),
    ).then(() => {
      clearTimeout(stragglers);
      resolve();
    });
  });
}

/**
 * Stops the engine's running agent children when it is told to stop: on
 * SIGINT or SIGTERM every agent child the engine started is stopped
 * first, then the engine dies of the signal it was sent.
 */
export function stopAgentChildrenOnSignal(): void {
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      void stopAgentChildren().finally(() => process.kill(process.pid, signal));
    });
  }
}
