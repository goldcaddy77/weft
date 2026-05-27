import { describe, expect, it } from 'bun:test';

import { emitWorkerMessageToEngine } from './worker-message-helpers.ts';

describe('emitWorkerMessageToEngine', () => {
  const message = {
    type: 'completed',
    workflowId: 'wf-1',
    result: 'done',
  } as const;

  it('returns true when the synchronous handler throws', () => {
    expect(
      emitWorkerMessageToEngine(() => {
        throw new Error('boom');
      }, message),
    ).toBe(true);
  });

  it('returns false for a synchronous success and maps async success or failure to booleans', async () => {
    expect(emitWorkerMessageToEngine(() => {}, message)).toBe(false);
    await expect(emitWorkerMessageToEngine(async () => {}, message)).resolves.toBe(false);
    await expect(
      emitWorkerMessageToEngine(async () => {
        throw new Error('boom');
      }, message),
    ).resolves.toBe(true);
  });
});
