import { describe, expect, it } from 'vitest';
import { withStepTimeout } from './package-smoke/launch.js';

/**
 * The step-bound half of the package smoke launcher: every await the
 * launcher makes must settle within its bound or the launcher fails
 * naming the stalled step and aborts whatever the step spawned — a CI
 * hang must become a failing check with an error, never a silent stall
 * that sits inside the job until it is cancelled.
 */

describe('withStepTimeout', () => {
  it('resolves with the step result when the step settles in time', async () => {
    await expect(
      withStepTimeout(
        'a quick step',
        async () => 'done',
        60_000,
      ),
    ).resolves.toBe('done');
  });

  it('propagates the step own failure instead of masking it', async () => {
    await expect(
      withStepTimeout(
        'a failing step',
        async () => {
          throw new Error('the step failed');
        },
        60_000,
      ),
    ).rejects.toThrow('the step failed');
  });

  it('fails naming the stalled step and aborts its spawn signal', async () => {
    let aborted = false;
    const stalled = withStepTimeout(
      'the stalled step',
      (signal) =>
        // Never settles by itself, like an editor that never exits.
        new Promise<string>((resolve) => {
          signal.addEventListener('abort', () => {
            aborted = true;
            resolve('the spawned process was killed');
          });
        }),
      20,
    );
    await expect(stalled).rejects.toThrow(
      'the stalled step did not finish within 20 ms',
    );
    expect(aborted).toBe(true);
  });

  it('leaves the spawn signal alone when the step settles in time', async () => {
    let signal: AbortSignal | undefined;
    await withStepTimeout(
      'a quick step',
      (spawnSignal) => {
        signal = spawnSignal;
        return Promise.resolve('done');
      },
      10,
    );
    // Past the deadline the step would have been killed at.
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(signal?.aborted).toBe(false);
  });
});
