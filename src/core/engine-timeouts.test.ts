import { describe, expect, it } from 'bun:test';

import { KEYS } from '../storage/interface.ts';
import { TestEngine } from '../testing/test-engine.ts';
import { decode } from './codec.ts';
import type { Context } from './context.ts';
import { WorkflowTimedOutEvent } from './events.ts';
import { WorkflowTimeoutError } from './timeouts.ts';
import type { WorkflowContext, WorkflowState } from './types.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function flush(): Promise<void> {
  await Bun.sleep(10);
}

const slowActivity = async (..._args: unknown[]) => {
  await Bun.sleep(999_999);
  return 'done';
};

/** Suppress unhandled rejection from a handle's result promise. */
function suppressResult(handle: { result(): Promise<unknown> }): void {
  handle.result().catch(() => {});
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Execution Timeouts', () => {
  it('sets workflow status to "timed-out" when deadline expires', async () => {
    const engine = new TestEngine();

    engine.register('slow', async function* (ctx: WorkflowContext) {
      yield* (ctx as Context).run(slowActivity);
      return 'never';
    });

    const handle = await engine.start('slow', undefined, {
      executionTimeout: '1 second',
    });
    suppressResult(handle);

    // Advance past the deadline
    await engine.advanceTime('2 seconds');
    await flush();

    // Check workflow state in storage
    const stateBytes = await engine.storage.get(KEYS.workflow(handle.id));
    expect(stateBytes).not.toBeNull();
    const state = decode(stateBytes!) as WorkflowState;
    expect(state.status).toBe('timed-out');

    engine[Symbol.dispose]();
  });

  it('dispatches WorkflowTimedOutEvent when deadline expires', async () => {
    const engine = new TestEngine();
    const events: WorkflowTimedOutEvent[] = [];

    engine.addEventListener(WorkflowTimedOutEvent.type, ((event: WorkflowTimedOutEvent) => {
      events.push(event);
    }) as EventListener);

    engine.register('slow', async function* (ctx: WorkflowContext) {
      yield* (ctx as Context).run(slowActivity);
      return 'never';
    });

    const handle = await engine.start('slow', undefined, {
      executionTimeout: '5 seconds',
    });
    suppressResult(handle);

    await engine.advanceTime('6 seconds');
    await flush();

    expect(events.length).toBe(1);
    expect(events[0]!.workflowId).toBe(handle.id);
    expect(events[0]!.timeoutType).toBe('execution');
    expect(events[0]!.elapsed).toBeGreaterThan(0);

    engine[Symbol.dispose]();
  });

  it('rejects result promise with WorkflowTimeoutError', async () => {
    const engine = new TestEngine();

    engine.register('slow', async function* (ctx: WorkflowContext) {
      yield* (ctx as Context).run(slowActivity);
      return 'never';
    });

    const handle = await engine.start('slow', undefined, {
      executionTimeout: '1 second',
    });

    // Catch inline to avoid unhandled rejection during advanceTime
    const resultPromise = handle.result().catch((error: unknown) => error);

    await engine.advanceTime('2 seconds');
    await flush();

    const error = await resultPromise;
    expect(error).toBeInstanceOf(WorkflowTimeoutError);
    const timeoutError = error as WorkflowTimeoutError;
    expect(timeoutError.workflowId).toBe(handle.id);
    expect(timeoutError.timeoutType).toBe('execution');
    expect(timeoutError.elapsed).toBeGreaterThan(0);

    engine[Symbol.dispose]();
  });

  it('does not dispatch WorkflowCancelledEvent on timeout', async () => {
    const engine = new TestEngine();
    let cancelledCount = 0;

    engine.addEventListener('workflow:cancelled', () => {
      cancelledCount++;
    });

    engine.register('slow', async function* (ctx: WorkflowContext) {
      yield* (ctx as Context).run(slowActivity);
      return 'never';
    });

    const handle = await engine.start('slow', undefined, {
      executionTimeout: '1 second',
    });
    suppressResult(handle);

    await engine.advanceTime('2 seconds');
    await flush();

    expect(cancelledCount).toBe(0);

    engine[Symbol.dispose]();
  });

  it('ctx.executionTimeRemaining returns correct value during execution', async () => {
    const engine = new TestEngine();
    let capturedRemaining: number | undefined;

    const captureRemaining = async (...args: unknown[]) => {
      capturedRemaining = args[0] as number;
      return capturedRemaining;
    };

    engine.register('check-time', async function* (ctx: WorkflowContext) {
      const remaining = (ctx as Context).executionTimeRemaining;
      yield* (ctx as Context).run(captureRemaining, remaining);
      return remaining;
    });

    await engine.start('check-time', undefined, {
      executionTimeout: '10 seconds',
    });

    await flush();

    // The remaining time should be close to 10 seconds (10000ms)
    expect(capturedRemaining).toBeDefined();
    expect(capturedRemaining!).toBeLessThanOrEqual(10_000);
    expect(capturedRemaining!).toBeGreaterThan(9_000);

    engine[Symbol.dispose]();
  });

  it('ctx.executionTimeRemaining returns Infinity when no timeout set', async () => {
    const engine = new TestEngine();
    let capturedRemaining: number | undefined;

    const captureRemaining = async (...args: unknown[]) => {
      capturedRemaining = args[0] as number;
      return capturedRemaining;
    };

    engine.register('no-timeout', async function* (ctx: WorkflowContext) {
      const remaining = (ctx as Context).executionTimeRemaining;
      yield* (ctx as Context).run(captureRemaining, remaining);
      return remaining;
    });

    await engine.start('no-timeout', undefined);
    await flush();

    expect(capturedRemaining).toBe(Infinity);

    engine[Symbol.dispose]();
  });

  it('cleans up deadline timer when workflow completes before timeout', async () => {
    const engine = new TestEngine();
    let timedOutCount = 0;

    engine.addEventListener(WorkflowTimedOutEvent.type, () => {
      timedOutCount++;
    });

    const fastActivity = async () => 'fast';

    engine.register('fast', async function* (ctx: WorkflowContext) {
      const result = yield* (ctx as Context).run(fastActivity);
      return result;
    });

    const handle = await engine.start('fast', undefined, {
      executionTimeout: '10 seconds',
    });

    const result = await handle.result();
    expect(result).toBe('fast');

    // Advance past the original deadline — should NOT trigger a timeout
    await engine.advanceTime('15 seconds');
    await flush();

    // Verify the workflow is still completed, not timed-out
    const stateBytes = await engine.storage.get(KEYS.workflow(handle.id));
    const state = decode(stateBytes!) as WorkflowState;
    expect(state.status).toBe('completed');
    expect(timedOutCount).toBe(0);

    engine[Symbol.dispose]();
  });

  it('cleans up deadline timer when workflow is cancelled before timeout', async () => {
    const engine = new TestEngine();
    let timedOutCount = 0;

    engine.addEventListener(WorkflowTimedOutEvent.type, () => {
      timedOutCount++;
    });

    engine.register('cancellable', async function* (ctx: WorkflowContext) {
      yield* (ctx as Context).run(slowActivity);
      return 'never';
    });

    const handle = await engine.start('cancellable', undefined, {
      executionTimeout: '10 seconds',
    });
    suppressResult(handle);

    // Cancel before the deadline
    await handle.cancel();
    await flush();

    // Advance past the original deadline
    await engine.advanceTime('15 seconds');
    await flush();

    // Should not have timed out — was already cancelled
    expect(timedOutCount).toBe(0);

    engine[Symbol.dispose]();
  });

  it('cleans up deadline timer when workflow fails before timeout', async () => {
    const engine = new TestEngine();
    let timedOutCount = 0;

    engine.addEventListener(WorkflowTimedOutEvent.type, () => {
      timedOutCount++;
    });

    engine.register('failing', async function* (_ctx: WorkflowContext) {
      throw new Error('boom');
    });

    const handle = await engine.start('failing', undefined, {
      executionTimeout: '10 seconds',
    });

    // Let the failure propagate
    try {
      await handle.result();
    } catch {
      // expected
    }
    await flush();

    // Advance past the original deadline
    await engine.advanceTime('15 seconds');
    await flush();

    // Should not have timed out — was already failed
    expect(timedOutCount).toBe(0);

    engine[Symbol.dispose]();
  });

  it('forwards WorkflowTimedOutEvent to workflow handle', async () => {
    const engine = new TestEngine();
    const handleEvents: WorkflowTimedOutEvent[] = [];

    engine.register('slow', async function* (ctx: WorkflowContext) {
      yield* (ctx as Context).run(slowActivity);
      return 'never';
    });

    const handle = await engine.start('slow', undefined, {
      executionTimeout: '1 second',
    });
    suppressResult(handle);

    handle.addEventListener(WorkflowTimedOutEvent.type, ((event: WorkflowTimedOutEvent) => {
      handleEvents.push(event);
    }) as EventListener);

    await engine.advanceTime('2 seconds');
    await flush();

    expect(handleEvents.length).toBe(1);
    expect(handleEvents[0]!.workflowId).toBe(handle.id);

    engine[Symbol.dispose]();
  });
});
