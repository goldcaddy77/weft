import { describe, expect, it } from 'bun:test';

import { KEYS } from '../../storage/interface.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import { deserializeCheckpoint } from '../checkpoint.ts';
import { encode } from '../codec.ts';
import type { Context } from '../context.ts';
import { Engine } from '../engine.ts';
import type { WorkflowContext } from '../types.ts';

async function flush(): Promise<void> {
  await Bun.sleep(10);
}

describe('Acceptance criterion: Virtual-Object-style session state', () => {
  it('persists session state in checkpoint locals and restores it after recovery', async () => {
    const storage = new MemoryStorage();

    function createWorkflow() {
      return async function* (ctx: WorkflowContext) {
        const context = ctx as Context;
        const session = context.sessionState<number>('counter', 0);

        session.update((current) => (current ?? 0) + 1);
        const beforeRecovery = session.get();

        yield* context.waitForSignal('resume');

        const afterRecovery = session.update((current) => (current ?? 0) + 1);
        return { beforeRecovery, afterRecovery };
      };
    }

    const engine1 = new Engine({ storage });
    engine1.register('session-state-workflow', createWorkflow());

    await engine1.start('session-state-workflow', null, { id: 'wf-session-state' });
    await flush();

    const checkpointBeforeCrash = deserializeCheckpoint(
      (await storage.get(KEYS.checkpoint('wf-session-state')))!,
    );
    expect(checkpointBeforeCrash.locals).toEqual({
      sessionState: {
        counter: 1,
      },
    });

    engine1[Symbol.dispose]();

    const engine2 = new Engine({ storage });
    engine2.register('session-state-workflow', createWorkflow());

    const handles = await engine2.recoverAll();
    expect(handles).toHaveLength(1);

    await engine2.signal('wf-session-state', 'resume');
    await flush();

    const result = await handles[0]!.result();
    expect(result).toEqual({
      beforeRecovery: 1,
      afterRecovery: 2,
    });

    engine2[Symbol.dispose]();
  });

  it('rejects corrupted checkpoint locals that use reserved session-state keys', () => {
    const sessionState = Object.create(null) as Record<string, unknown>;
    sessionState['constructor'] = {
      polluted: true,
    };
    const corruptedCheckpoint = encode({
      workflowId: 'wf-corrupted-session-state',
      step: 1,
      locals: {
        sessionState,
      },
      accumulatedResults: [],
      pendingSignals: [],
      searchAttributes: {},
      version: '1.0.0',
      createdAt: Date.now(),
    });

    expect(() => deserializeCheckpoint(corruptedCheckpoint)).toThrow();
  });
});
