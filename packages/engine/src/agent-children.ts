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
 * would not stop, such as a container's runtime CLI; it is waited for to
 * its end, so it bounds its own stopping.
 */
export function trackAgentChild<T extends ChildProcess>(child: T, stop?: () => Promise<void>): T {
  running.set(child, stop);
  child.once('close', () => running.delete(child));
  return child;
}

/**
 * Stops every agent child the engine has running. Each is asked to stop
 * with SIGTERM, or its own way — a stop of its own is waited for to its
 * end, within the bound it keeps itself — and whatever is still running
 * `graceMs` after that is killed outright. The returned promise settles
 * once every child is going down: closed, or killed outright at the
 * latest.
 */
export function stopAgentChildren(graceMs = 2000): Promise<void> {
  const children = [...running];
  running.clear();
  if (children.length === 0) return Promise.resolve();
  return Promise.all(
    children.map(async ([child, stop]) => {
      const closed = new Promise<void>((resolve) => child.once('close', () => resolve()));
      if (stop) await stop().catch(() => undefined);
      else child.kill('SIGTERM');
      await new Promise<void>((resolve) => {
        const straggler = setTimeout(() => {
          child.kill('SIGKILL');
          resolve();
        }, graceMs);
        void closed.then(() => {
          clearTimeout(straggler);
          resolve();
        });
      });
    }),
  ).then(() => undefined);
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
