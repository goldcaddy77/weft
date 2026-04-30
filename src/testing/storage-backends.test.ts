import { afterEach, describe, expect, it, mock } from 'bun:test';

import { restoreRealTimers, useFakeTimers } from './fake-timers.ts';
import { flush, teardown, waitForWorkflowStatus } from './storage-backends.ts';

afterEach(() => {
  restoreRealTimers();
});

describe('waitForWorkflowStatus', () => {
  it('returns once the workflow reaches the requested status', async () => {
    let reads = 0;
    const engine = {
      get: mock(async () => {
        reads += 1;
        return { status: reads > 1 ? 'completed' : 'running' };
      }),
    };

    await expect(
      waitForWorkflowStatus(engine as never, 'workflow-1', 'completed', 50),
    ).resolves.toBeUndefined();
  });

  it('throws when the workflow never reaches the requested status before timeout', async () => {
    const engine = {
      get: mock(async () => ({ status: 'running' })),
    };

    await expect(
      waitForWorkflowStatus(engine as never, 'workflow-1', 'completed', 20),
    ).rejects.toThrow('Expected workflow "workflow-1" to reach status "completed"');
  });
});

describe('storage backend testing helpers', () => {
  it('flush resolves without throwing', async () => {
    await expect(flush()).resolves.toBeUndefined();
  });

  it('flush advances pending zero-delay timers under fake timers', async () => {
    useFakeTimers();

    let fired = false;
    setTimeout(() => {
      fired = true;
    }, 0);

    await flush();

    expect(fired).toBe(true);
  });

  it('teardown disposes the engine, flushes, and runs storage cleanup', async () => {
    const dispose = mock(() => {});
    const storageCleanup = mock(() => {});

    await expect(
      teardown({ [Symbol.dispose]: dispose } as never, storageCleanup),
    ).resolves.toBeUndefined();

    expect(dispose).toHaveBeenCalledTimes(1);
    expect(storageCleanup).toHaveBeenCalledTimes(1);
  });
});
