import { describe, expect, it, spyOn } from 'bun:test';

import {
  minimalServeOptions,
  minimalServerContext,
} from './runtime/server-context.test-support.ts';
import { clampWorkerReconnectGracePeriod, registerStackDisposers } from './serve-internals.ts';

import type { EventBroadcastingHandle } from './index.ts';

describe('clampWorkerReconnectGracePeriod', () => {
  it('returns the 100ms default when undefined', () => {
    expect(clampWorkerReconnectGracePeriod(undefined)).toBe(100);
  });

  it('returns the 100ms default for non-finite values', () => {
    expect(clampWorkerReconnectGracePeriod(Number.NaN)).toBe(100);
    expect(clampWorkerReconnectGracePeriod(Number.POSITIVE_INFINITY)).toBe(100);
    expect(clampWorkerReconnectGracePeriod(Number.NEGATIVE_INFINITY)).toBe(100);
  });

  it('honors 0 as the explicit no-grace bypass', () => {
    expect(clampWorkerReconnectGracePeriod(0)).toBe(0);
  });

  it('honors finite positive values inside the 1..5000 range', () => {
    expect(clampWorkerReconnectGracePeriod(1)).toBe(1);
    expect(clampWorkerReconnectGracePeriod(250)).toBe(250);
    expect(clampWorkerReconnectGracePeriod(5_000)).toBe(5_000);
  });

  it('clamps negative values to 0', () => {
    expect(clampWorkerReconnectGracePeriod(-1)).toBe(0);
    expect(clampWorkerReconnectGracePeriod(-1_000)).toBe(0);
  });

  it('clamps values above 5000 to 5000', () => {
    expect(clampWorkerReconnectGracePeriod(5_001)).toBe(5_000);
    expect(clampWorkerReconnectGracePeriod(1_000_000)).toBe(5_000);
  });

  it('floors fractional values', () => {
    expect(clampWorkerReconnectGracePeriod(123.7)).toBe(123);
  });
});

describe('registerStackDisposers', () => {
  it('disposes the task queue from the timer-cleanup disposer', () => {
    const context = minimalServerContext();
    // registerStackDisposers wires terminal/cancellation listeners onto the
    // engine during registration, so the stub engine needs addEventListener.
    const options = {
      ...minimalServeOptions(),
      engine: { addEventListener() {}, removeEventListener() {} },
    } as unknown as ReturnType<typeof minimalServeOptions>;

    const disposeSpy = spyOn(context.taskQueue, Symbol.dispose);

    // Capture the registered disposers rather than driving a full server
    // teardown: the other disposers touch collaborators (workflowEventFeed,
    // mcpSessionManager, the engine) that a minimal context does not provide.
    // We only need to prove the timer-cleanup disposer — registered last, so
    // LIFO-disposed first — calls taskQueue[Symbol.dispose].
    const deferred: Array<() => void | Promise<void>> = [];
    const stack = {
      defer(callback: () => void | Promise<void>) {
        deferred.push(callback);
      },
    } as unknown as AsyncDisposableStack;

    const broadcastingHandle = { dispose() {} } as unknown as EventBroadcastingHandle;

    registerStackDisposers(stack, context, options, broadcastingHandle, () => {});

    const timerCleanupDisposer = deferred.at(-1);
    expect(timerCleanupDisposer).toBeDefined();
    timerCleanupDisposer!();

    expect(disposeSpy).toHaveBeenCalledTimes(1);
  });
});
