import { afterEach, describe, expect, it, mock } from 'bun:test';

import type { WorkerPool } from '../workers/pool.ts';
import type { WorkerOutboundMessage } from './types.ts';
import { WorkerExecutionStrategy } from './worker-execution-strategy.ts';

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

interface MockWorker {
  postMessage: ReturnType<typeof mock>;
  terminate: ReturnType<typeof mock>;
  addEventListener: (type: string, listener: EventListener) => void;
  removeEventListener: (type: string, listener: EventListener) => void;
  // Internal: stored listeners for test simulation
  _listeners: Map<string, Set<EventListener>>;
}

function createMockWorker(): MockWorker {
  const listeners = new Map<string, Set<EventListener>>();

  return {
    postMessage: mock(() => {}),
    terminate: mock(() => {}),
    addEventListener(type: string, listener: EventListener) {
      if (!listeners.has(type)) {
        listeners.set(type, new Set());
      }
      listeners.get(type)!.add(listener);
    },
    removeEventListener(type: string, listener: EventListener) {
      listeners.get(type)?.delete(listener);
    },
    _listeners: listeners,
  };
}

/** Simulate dispatching an event to a mock worker's listeners. */
function dispatchToMockWorker(worker: MockWorker, type: string, event: Event): void {
  const typeListeners = worker._listeners.get(type);
  if (typeListeners) {
    for (const listener of typeListeners) {
      listener(event);
    }
  }
}

function createMockPool(workers: MockWorker[]): WorkerPool {
  let acquireIndex = 0;
  const released: MockWorker[] = [];

  return {
    acquire: mock(async () => {
      if (acquireIndex < workers.length) {
        return workers[acquireIndex++] as unknown as Worker;
      }
      throw new Error('No more workers');
    }),
    release: mock((worker: Worker) => {
      released.push(worker as unknown as MockWorker);
    }),
    get availableCount() {
      return 0;
    },
    get totalCount() {
      return workers.length;
    },
    get pendingCount() {
      return 0;
    },
    [Symbol.dispose]() {},
    async [Symbol.asyncDispose]() {},
  } as unknown as WorkerPool;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('WorkerExecutionStrategy', () => {
  let strategy: WorkerExecutionStrategy;
  let messages: WorkerOutboundMessage[];
  let mockWorkers: MockWorker[];
  let mockPool: WorkerPool;

  afterEach(() => {
    strategy?.[Symbol.dispose]();
  });

  function setup(workerCount: number = 1): void {
    mockWorkers = Array.from({ length: workerCount }, () => createMockWorker());
    mockPool = createMockPool(mockWorkers);
    strategy = new WorkerExecutionStrategy(mockPool);
    messages = [];
    strategy.onMessage((message) => messages.push(message));
  }

  /** Return the first mock worker, asserting it exists. */
  function firstWorker(): MockWorker {
    const worker = mockWorkers[0];
    expect(worker).toBeDefined();
    return worker!;
  }

  /** Return the first message, asserting it exists. */
  function firstMessage(): WorkerOutboundMessage {
    expect(messages).toHaveLength(1);
    const message = messages[0];
    expect(message).toBeDefined();
    return message!;
  }

  // -------------------------------------------------------------------------
  // startWorkflow
  // -------------------------------------------------------------------------

  describe('startWorkflow', () => {
    it('acquires a worker and sends a run message', async () => {
      setup();

      const checkpoint = new ArrayBuffer(8);
      strategy.startWorkflow({
        workflowId: 'wf-1',
        workflowType: 'test',
        input: { value: 42 },
        checkpoint,
      });

      // Allow the async acquire to complete
      await Bun.sleep(10);

      const worker = firstWorker();
      expect(mockPool.acquire).toHaveBeenCalled();
      expect(worker.postMessage).toHaveBeenCalledTimes(1);

      const sentMessage = worker.postMessage.mock.calls[0]![0];
      expect(sentMessage.type).toBe('run');
      expect(sentMessage.workflowId).toBe('wf-1');
      expect(sentMessage.workflowType).toBe('test');
      expect(sentMessage.input).toEqual({ value: 42 });
    });

    it('wires up onmessage on the acquired worker', async () => {
      setup();

      strategy.startWorkflow({
        workflowId: 'wf-1',
        workflowType: 'test',
        input: null,
        checkpoint: new ArrayBuffer(0),
      });

      await Bun.sleep(10);

      const worker = firstWorker();
      // Verify that message listeners were added to the worker
      expect(worker._listeners.get('message')?.size).toBeGreaterThan(0);
    });

    it('emits a failed message if pool acquisition fails', async () => {
      mockWorkers = [];
      mockPool = createMockPool([]);
      strategy = new WorkerExecutionStrategy(mockPool);
      messages = [];
      strategy.onMessage((message) => messages.push(message));

      strategy.startWorkflow({
        workflowId: 'wf-fail',
        workflowType: 'test',
        input: null,
        checkpoint: new ArrayBuffer(0),
      });

      await Bun.sleep(10);

      const message = firstMessage();
      expect(message.type).toBe('failed');
      expect(message.workflowId).toBe('wf-fail');
    });
  });

  describe('broadcast forwarding', () => {
    it('forwards signal:received messages from BroadcastChannel to the assigned worker', async () => {
      const originalBroadcastChannel = globalThis.BroadcastChannel;
      let broadcastListener: ((event: MessageEvent) => void) | undefined;

      class MockBroadcastChannel {
        addEventListener(_type: string, listener: (event: MessageEvent) => void): void {
          broadcastListener = listener;
        }

        removeEventListener(): void {}

        close(): void {}
      }

      globalThis.BroadcastChannel = MockBroadcastChannel as unknown as typeof BroadcastChannel;

      try {
        setup();
        strategy[Symbol.dispose]();
        strategy = new WorkerExecutionStrategy(mockPool, { broadcastEvents: true });
        messages = [];
        strategy.onMessage((message) => messages.push(message));

        strategy.startWorkflow({
          workflowId: 'wf-broadcast',
          workflowType: 'test',
          input: null,
          checkpoint: new ArrayBuffer(0),
        });

        await Bun.sleep(10);

        const worker = firstWorker();
        const callsBefore = worker.postMessage.mock.calls.length;
        expect(broadcastListener).toBeDefined();

        broadcastListener!(
          new MessageEvent('message', {
            data: { type: 'signal:received', workflowId: 'wf-broadcast', signalName: 'ready' },
          }),
        );

        expect(worker.postMessage.mock.calls.length).toBe(callsBefore + 1);
        expect(worker.postMessage.mock.calls.at(-1)?.[0]).toEqual({
          type: 'signal:received',
          workflowId: 'wf-broadcast',
          signalName: 'ready',
        });
      } finally {
        globalThis.BroadcastChannel = originalBroadcastChannel;
      }
    });

    it('ignores missing BroadcastChannel support when broadcastEvents is enabled', () => {
      const originalBroadcastChannel = globalThis.BroadcastChannel;

      const UnavailableBroadcastChannel = function (): never {
        throw new Error('BroadcastChannel unavailable');
      };
      globalThis.BroadcastChannel =
        UnavailableBroadcastChannel as unknown as typeof BroadcastChannel;

      try {
        expect(() => {
          strategy = new WorkerExecutionStrategy(createMockPool([]), { broadcastEvents: true });
        }).not.toThrow();
      } finally {
        globalThis.BroadcastChannel = originalBroadcastChannel;
      }
    });
  });

  // -------------------------------------------------------------------------
  // Worker message forwarding
  // -------------------------------------------------------------------------

  describe('message forwarding', () => {
    it('forwards checkpoint messages from the worker', async () => {
      setup();

      strategy.startWorkflow({
        workflowId: 'wf-1',
        workflowType: 'test',
        input: null,
        checkpoint: new ArrayBuffer(0),
      });

      await Bun.sleep(10);

      const worker = firstWorker();

      // Simulate worker sending a checkpoint message
      const checkpointMessage: WorkerOutboundMessage = {
        type: 'checkpoint',
        workflowId: 'wf-1',
        checkpoint: new ArrayBuffer(0),
        operationRequest: {
          id: 'op-1',
          workflowId: 'wf-1',
          kind: 'activity',
          queue: 'default',
          activityName: 'doSomething',
          attempt: 1,
          retryPolicy: {
            maxAttempts: 3,
            initialBackoff: 1000,
            backoffMultiplier: 2,
            maxBackoff: 30000,
          },
          scheduledAt: Date.now(),
        },
      };

      dispatchToMockWorker(
        worker,
        'message',
        new MessageEvent('message', { data: checkpointMessage }),
      );

      const message = firstMessage();
      expect(message).toEqual(checkpointMessage);
    });

    it('releases the worker on completed messages', async () => {
      setup();

      strategy.startWorkflow({
        workflowId: 'wf-1',
        workflowType: 'test',
        input: null,
        checkpoint: new ArrayBuffer(0),
      });

      await Bun.sleep(10);

      const worker = firstWorker();

      const completedMessage: WorkerOutboundMessage = {
        type: 'completed',
        workflowId: 'wf-1',
        result: 'done',
      };

      dispatchToMockWorker(
        worker,
        'message',
        new MessageEvent('message', { data: completedMessage }),
      );

      const message = firstMessage();
      expect(message.type).toBe('completed');
      expect(mockPool.release).toHaveBeenCalledTimes(1);
    });

    it('releases the worker on failed messages', async () => {
      setup();

      strategy.startWorkflow({
        workflowId: 'wf-1',
        workflowType: 'test',
        input: null,
        checkpoint: new ArrayBuffer(0),
      });

      await Bun.sleep(10);

      const worker = firstWorker();

      const failedMessage: WorkerOutboundMessage = {
        type: 'failed',
        workflowId: 'wf-1',
        error: 'something broke',
      };

      dispatchToMockWorker(worker, 'message', new MessageEvent('message', { data: failedMessage }));

      const message = firstMessage();
      expect(message.type).toBe('failed');
      expect(mockPool.release).toHaveBeenCalledTimes(1);
    });
  });

  // -------------------------------------------------------------------------
  // resumeWorkflow
  // -------------------------------------------------------------------------

  describe('resumeWorkflow', () => {
    it('sends a resume message to the assigned worker', async () => {
      setup();

      strategy.startWorkflow({
        workflowId: 'wf-1',
        workflowType: 'test',
        input: null,
        checkpoint: new ArrayBuffer(0),
      });

      await Bun.sleep(10);

      const worker = firstWorker();
      const checkpoint = new ArrayBuffer(16);
      strategy.resumeWorkflow({
        workflowId: 'wf-1',
        checkpoint,
        operationResult: { status: 'completed', value: 42 },
      });

      // The first call is the 'run' message, the second is 'resume'
      expect(worker.postMessage).toHaveBeenCalledTimes(2);

      const resumeMessage = worker.postMessage.mock.calls[1]![0];
      expect(resumeMessage.type).toBe('resume');
      expect(resumeMessage.workflowId).toBe('wf-1');
      expect(resumeMessage.operationResult).toEqual({ status: 'completed', value: 42 });
    });

    it('emits failed when no worker is assigned', () => {
      setup();

      strategy.resumeWorkflow({
        workflowId: 'wf-unknown',
        checkpoint: new ArrayBuffer(0),
        operationResult: { status: 'completed', value: null },
      });

      const message = firstMessage();
      expect(message.type).toBe('failed');
      expect(message.workflowId).toBe('wf-unknown');
    });
  });

  // -------------------------------------------------------------------------
  // cancelWorkflow
  // -------------------------------------------------------------------------

  describe('cancelWorkflow', () => {
    it('sends a cancel message to the assigned worker', async () => {
      setup();

      strategy.startWorkflow({
        workflowId: 'wf-1',
        workflowType: 'test',
        input: null,
        checkpoint: new ArrayBuffer(0),
      });

      await Bun.sleep(10);

      strategy.cancelWorkflow('wf-1');

      const worker = firstWorker();
      // First call is 'run', second is 'cancel'
      expect(worker.postMessage).toHaveBeenCalledTimes(2);

      const cancelMessage = worker.postMessage.mock.calls[1]![0];
      expect(cancelMessage.type).toBe('cancel');
      expect(cancelMessage.workflowId).toBe('wf-1');

      // Worker should have been released back to the pool
      expect(mockPool.release).toHaveBeenCalledTimes(1);
    });

    it('does nothing when no worker is assigned', () => {
      setup();

      // Should not throw
      strategy.cancelWorkflow('wf-nonexistent');
    });
  });

  // -------------------------------------------------------------------------
  // Worker errors
  // -------------------------------------------------------------------------

  describe('worker errors', () => {
    it('is a no-op when the worker was already released by a racing completion', async () => {
      setup();

      strategy.startWorkflow({
        workflowId: 'wf-1',
        workflowType: 'test',
        input: null,
        checkpoint: new ArrayBuffer(0),
      });

      await Bun.sleep(10);

      const worker = firstWorker();

      // Step 1: simulate the worker sending a completed message, which triggers
      // #releaseWorker and removes the worker from the internal map.
      const completedMessage: WorkerOutboundMessage = {
        type: 'completed',
        workflowId: 'wf-1',
        result: 'done',
      };

      dispatchToMockWorker(
        worker,
        'message',
        new MessageEvent('message', { data: completedMessage }),
      );

      // Step 2: now fire an error event for the same workflowId — the race
      // guard should detect the worker is already gone and return early.
      const errorEvent = new ErrorEvent('error', {
        message: 'Late crash after completion',
      });

      dispatchToMockWorker(worker, 'error', errorEvent);

      // Only the completed message should have been emitted; no failed message.
      expect(messages).toHaveLength(1);
      expect(messages[0]!.type).toBe('completed');

      // terminate() must not have been called — the worker was cleanly released,
      // not crashed.
      expect(worker.terminate).not.toHaveBeenCalled();
    });

    it('emits a failed message when the worker crashes', async () => {
      setup();

      strategy.startWorkflow({
        workflowId: 'wf-1',
        workflowType: 'test',
        input: null,
        checkpoint: new ArrayBuffer(0),
      });

      await Bun.sleep(10);

      const worker = firstWorker();

      // Simulate worker crash
      const errorEvent = new ErrorEvent('error', {
        message: 'Worker crashed unexpectedly',
      });

      dispatchToMockWorker(worker, 'error', errorEvent);

      const message = firstMessage();
      expect(message.type).toBe('failed');
      expect(message.workflowId).toBe('wf-1');

      if (message.type === 'failed') {
        expect(message.error).toContain('Worker crashed');
      }

      // Worker should NOT be released back to pool (it crashed)
      expect(mockPool.release).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Disposal
  // -------------------------------------------------------------------------

  describe('disposal', () => {
    it('disposes the pool on synchronous dispose', () => {
      setup();

      strategy[Symbol.dispose]();

      // Should be callable without error
      expect(true).toBe(true);
    });

    it('disposes the pool on async dispose', async () => {
      setup();

      await strategy[Symbol.asyncDispose]();

      // Should complete without error
      expect(true).toBe(true);
    });
  });
});
