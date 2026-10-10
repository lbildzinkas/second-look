import type { ChildProcess } from 'node:child_process';

/**
 * The agent children the engine starts, kept so that none of them
 * outlives it: a review can be stopped while its agent is still grouping,
 * and the agent run the engine started must stop with the engine. A
 * sandboxed run's container is one of them too: killing the runtime's
 * CLI would leave the container running, so it is stopped its own way.
 */

/** The engine's running agent children, each with how it is stopped when not by a signal. */
const running = new Map<ChildProcess, (() => Promise<void>) | undefined>();

/**
 * Remembers one agent child the engine started, until it closes. `stop`
 * replaces the request to stop with SIGTERM, for a child that a signal
 * would not stop, such as a container's runtime CLI.
 */
export function trackAgentChild<T extends ChildProcess>(child: T, stop?: () => Promise<void>): T {
  running.set(child, stop);
  child.once('close', () => running.delete(child));
  return child;
}

/**
 * Stops every agent child the engine has running. Each is asked to stop
 * with SIGTERM, or its own way, whatever is still running after `graceMs`
 * is killed outright, and the returned promise settles once every child
 * is going down: when they have all closed and every stop of their own
 * has finished, or right after the kills at the latest.
 */
export function stopAgentChildren(graceMs = 2000): Promise<void> {
  const children = [...running];
  running.clear();
  if (children.length === 0) return Promise.resolve();
  const stops = children.map(([child, stop]) => {
    if (stop) return stop().catch(() => undefined);
    child.kill('SIGTERM');
    return Promise.resolve();
  });
  return new Promise<void>((resolve) => {
    const stragglers = setTimeout(() => {
      for (const [child] of children) child.kill('SIGKILL');
      resolve();
    }, graceMs);
    void Promise.all([
      ...stops,
      ...children.map(([child]) => new Promise<void>((closed) => child.once('close', () => closed()))),
    ]).then(() => {
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
