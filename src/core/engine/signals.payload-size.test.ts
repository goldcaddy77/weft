import { describe, expect, it } from 'bun:test';

import { MemoryStorage } from '../../storage/memory.ts';
import { sleepForTesting } from '../../testing/fake-timers.ts';
import { Engine } from '../engine.ts';
import { PayloadSizeExceededError } from '../payload-size.ts';
import { type WorkflowContext, workflow } from '../types.ts';

async function flush(): Promise<void> {
  await sleepForTesting(10);
}

const signalPrefix = (workflowId: string): string => `sig:${workflowId}:`;

// A workflow that parks waiting for a signal so the signal write path is live.
const waiterWorkflow = workflow({ name: 'waiter' }).execute(async function* (ctx: WorkflowContext) {
  return yield* ctx.waitForSignal('release');
});

async function countSignalKeys(storage: MemoryStorage, workflowId: string): Promise<number> {
  let count = 0;
  for await (const _key of storage.keys(signalPrefix(workflowId))) {
    count += 1;
  }
  return count;
}

describe('payload-size cap — signal payload', () => {
  it('rejects an oversize signal payload before writing any signal key', async () => {
    const storage = new MemoryStorage();
    const engine = new Engine({ storage, payloadSize: { maxBytes: 64 } });
    engine.register(waiterWorkflow);

    const handle = await engine.start('waiter', null, { id: 'wf-signal' });
    handle.result().catch(() => {});
    await flush();

    const oversize = 'x'.repeat(1024);
    let thrown: unknown;
    try {
      await engine.signal('wf-signal', 'release', oversize);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(PayloadSizeExceededError);
    expect((thrown as PayloadSizeExceededError).payloadKind).toBe('signal payload');
    expect(await countSignalKeys(storage, 'wf-signal')).toBe(0);

    engine[Symbol.dispose]();
  });

  it('admits a signal payload at or below the limit', async () => {
    const storage = new MemoryStorage();
    const engine = new Engine({ storage, payloadSize: { maxBytes: 1024 } });
    engine.register(waiterWorkflow);

    const handle = await engine.start('waiter', null, { id: 'wf-signal-ok' });
    const resultPromise = handle.result();
    await flush();

    await engine.signal('wf-signal-ok', 'release', 'ping');
    await flush();

    expect(await resultPromise).toBe('ping');

    engine[Symbol.dispose]();
  });
});
