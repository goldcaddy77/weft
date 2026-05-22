import { describe, expect, it } from 'bun:test';

import { Engine } from '../core/engine.ts';
import {
  clientContractEchoWorkflow,
  waitForQueryReadyForTesting,
} from './client-contract.test-support.ts';

describe('client contract test support', () => {
  it('retries query readiness until the workflow reports ready', async () => {
    let attempts = 0;
    const client = {
      query: async () => {
        attempts += 1;
        return attempts >= 3;
      },
    };

    await expect(
      waitForQueryReadyForTesting(client as never, 'workflow-ready'),
    ).resolves.toBeUndefined();
    expect(attempts).toBe(3);
  });

  it('throws when query handlers never become ready', async () => {
    const client = {
      query: async () => false,
    };

    await expect(waitForQueryReadyForTesting(client as never, 'workflow-stuck')).rejects.toThrow(
      'Workflow workflow-stuck did not expose query handlers',
    );
  });

  it('round-trips the echo workflow result', async () => {
    const engine = new Engine();
    try {
      engine.register(clientContractEchoWorkflow);

      const handle = await engine.start('client-contract-echo', { hello: 'world' });

      await expect(handle.result()).resolves.toEqual({ hello: 'world' });
    } finally {
      engine[Symbol.dispose]();
    }
  });
});
