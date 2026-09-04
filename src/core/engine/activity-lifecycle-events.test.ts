/**
 * Inline activity lifecycle events: `activity:started` / `activity:completed` /
 * `activity:failed` must fire on the ENGINE for inline execution (the default),
 * exactly once per attempt, carrying the operation identity, `attempt` and
 * (on completion) a wall-clock `duration`. Before this the classes existed and
 * the alert manager listened for them, but nothing on the inline path emitted
 * them. An async deferral emits `started` (and `async-pending`) only.
 */
import { afterEach, describe, expect, it } from 'bun:test';

import { MemoryStorage } from '../../storage/memory.ts';
import {
  ActivityAsyncPendingEvent,
  ActivityCompletedEvent,
  ActivityFailedEvent,
  ActivityStartedEvent,
} from '../events.ts';
import type { ActivityContext, WorkflowContext } from '../types.ts';
import { activity, workflow } from '../types.ts';
import { Engine } from './index.ts';

let engine: Engine | undefined;
afterEach(() => {
  engine?.[Symbol.dispose]();
  engine = undefined;
});

type Seen =
  | { kind: 'started'; operationId: string; workflowId: string; activityName: string; attempt: number }
  | { kind: 'completed'; operationId: string; workflowId: string; activityName: string; duration: number }
  | { kind: 'failed'; operationId: string; workflowId: string; activityName: string; attempt: number; message: string }
  | { kind: 'async-pending'; token: string; attempt: number };

function recordActivityEvents(target: Engine): Seen[] {
  const seen: Seen[] = [];
  target.addEventListener('activity:started', (event) => {
    if (!(event instanceof ActivityStartedEvent)) return;
    const { operationId, workflowId, activityName, attempt } = event;
    seen.push({ kind: 'started', operationId, workflowId, activityName, attempt });
  });
  target.addEventListener('activity:completed', (event) => {
    if (!(event instanceof ActivityCompletedEvent)) return;
    const { operationId, workflowId, activityName, duration } = event;
    seen.push({ kind: 'completed', operationId, workflowId, activityName, duration });
  });
  target.addEventListener('activity:failed', (event) => {
    if (!(event instanceof ActivityFailedEvent)) return;
    const { operationId, workflowId, activityName, attempt } = event;
    seen.push({ kind: 'failed', operationId, workflowId, activityName, attempt, message: event.error.message });
  });
  target.addEventListener('activity:async-pending', (event) => {
    if (!(event instanceof ActivityAsyncPendingEvent)) return;
    seen.push({ kind: 'async-pending', token: event.token, attempt: event.attempt });
  });
  return seen;
}

describe('inline activity lifecycle events', () => {
  it('emits started then completed, once, with the operation identity and a duration', async () => {
    const greet = activity({ name: 'greet', execute: async (name: string) => `hi ${name}` });
    const wf = workflow({ name: 'lifecycle-success' })
      .activities({ greet })
      .execute(async function* (ctx: WorkflowContext, input: string) {
        return yield* ctx.run(greet, input);
      });
    engine = new Engine({ storage: new MemoryStorage() });
    engine.register(wf);
    const seen = recordActivityEvents(engine);

    const handle = await engine.start('lifecycle-success', 'ada', { id: 'wf-lifecycle-success' });
    await expect(handle.result()).resolves.toBe('hi ada');

    expect(seen.map((e) => e.kind)).toEqual(['started', 'completed']);
    const [started, completed] = seen as [Extract<Seen, { kind: 'started' }>, Extract<Seen, { kind: 'completed' }>];
    expect(started.workflowId).toBe('wf-lifecycle-success');
    expect(started.activityName).toBe('greet');
    expect(started.attempt).toBe(1);
    expect(completed.operationId).toBe(started.operationId);
    expect(completed.activityName).toBe('greet');
    expect(completed.duration).toBeGreaterThanOrEqual(0);
  });

  it('emits failed for a failing attempt, then started/completed for the retry, with the right attempt numbers', async () => {
    let attempts = 0;
    const flaky = activity({
      name: 'flaky',
      retry: { maxAttempts: 2, initialBackoff: 0, backoffMultiplier: 1, maxBackoff: 0 },
      execute: async () => {
        attempts++;
        if (attempts === 1) throw new Error('retry me');
        return 'recovered';
      },
    });
    const wf = workflow({ name: 'lifecycle-retry' })
      .activities({ flaky })
      .execute(async function* (ctx: WorkflowContext) {
        return yield* ctx.run(flaky);
      });
    engine = new Engine({ storage: new MemoryStorage() });
    engine.register(wf);
    const seen = recordActivityEvents(engine);

    const handle = await engine.start('lifecycle-retry', null, { id: 'wf-lifecycle-retry' });
    await expect(handle.result()).resolves.toBe('recovered');

    expect(seen.map((e) => e.kind)).toEqual(['started', 'failed', 'started', 'completed']);
    const [s1, f1, s2] = seen as [
      Extract<Seen, { kind: 'started' }>,
      Extract<Seen, { kind: 'failed' }>,
      Extract<Seen, { kind: 'started' }>,
    ];
    expect(s1.attempt).toBe(1);
    expect(f1.attempt).toBe(1);
    expect(f1.message).toBe('retry me');
    expect(f1.activityName).toBe('flaky');
    expect(s2.attempt).toBe(2);
  });

  it('an async deferral emits started (and async-pending) but neither completed nor failed', async () => {
    const awaitCallback = activity({
      name: 'await-callback',
      // `completeAsync()` throws to park the activity; the body never returns normally.
      execute: (_input: void, context?: ActivityContext): unknown => context!.completeAsync(),
    });
    const wf = workflow({ name: 'lifecycle-async' })
      .activities({ 'await-callback': awaitCallback })
      .execute(async function* (ctx: WorkflowContext) {
        return yield* ctx.run(awaitCallback);
      });
    engine = new Engine({ storage: new MemoryStorage() });
    engine.register(wf);
    const seen = recordActivityEvents(engine);

    const handle = await engine.start('lifecycle-async', undefined, { id: 'wf-lifecycle-async' });
    // Let the activity run to its deferral and register the pending token.
    await new Promise((resolve) => {
      setTimeout(resolve, 20);
    });
    const pending = seen.find((e) => e.kind === 'async-pending');
    expect(pending).toBeDefined();
    expect(seen.map((e) => e.kind)).toEqual(['started', 'async-pending']);

    await engine.completeAsyncActivity(pending!.token, { decision: 'approved' });
    await expect(handle.result()).resolves.toEqual({ decision: 'approved' });
    // A deferral is neither a completion nor a failure of the executing attempt.
    expect(seen.filter((e) => e.kind === 'failed')).toHaveLength(0);
  });
});
