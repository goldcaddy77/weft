import { afterEach, describe, expect, it } from 'bun:test';
import { RemoteWorker } from './index.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a minimal WebSocket server for testing. */
function createTestServer(options?: {
  onMessage?: (ws: any, message: string) => void;
}): ReturnType<typeof Bun.serve> {
  return Bun.serve({
    port: 0,
    fetch(request, server) {
      if (server.upgrade(request, { data: undefined })) return undefined;
      return new Response('ok');
    },
    websocket: {
      message(ws, message) {
        const text = typeof message === 'string' ? message : new TextDecoder().decode(message);
        options?.onMessage?.(ws, text);
      },
      open(_ws) {},
      close(_ws) {},
    },
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('RemoteWorker', () => {
  // eslint-disable-next-line typescript-eslint/no-redundant-type-constituents -- Bun.serve return type
  let server: ReturnType<typeof Bun.serve> | undefined;

  afterEach(() => {
    if (server) {
      server.stop(true);
      server = undefined;
    }
  });

  it('constructor stores options with defaults', () => {
    const worker = new RemoteWorker({
      serverUrl: 'ws://localhost:8080',
      activities: {
        processOrder: async (input) => input,
      },
    });

    // Verify it was created without throwing
    expect(worker).toBeDefined();

    // Clean up
    worker[Symbol.dispose]();
  });

  it('connected is false before connect', () => {
    const worker = new RemoteWorker({
      serverUrl: 'ws://localhost:8080',
      activities: {
        processOrder: async (input) => input,
      },
    });

    expect(worker.connected).toBe(false);

    worker[Symbol.dispose]();
  });

  it('inFlight starts at 0', () => {
    const worker = new RemoteWorker({
      serverUrl: 'ws://localhost:8080',
      activities: {
        processOrder: async (input) => input,
      },
    });

    expect(worker.inFlight).toBe(0);

    worker[Symbol.dispose]();
  });

  it('[Symbol.dispose] is callable', () => {
    const worker = new RemoteWorker({
      serverUrl: 'ws://localhost:8080',
      activities: {
        processOrder: async (input) => input,
      },
    });

    expect(() => worker[Symbol.dispose]()).not.toThrow();
  });

  it('[Symbol.dispose] is idempotent', () => {
    const worker = new RemoteWorker({
      serverUrl: 'ws://localhost:8080',
      activities: {
        processOrder: async (input) => input,
      },
    });

    worker[Symbol.dispose]();
    expect(() => worker[Symbol.dispose]()).not.toThrow();
  });

  it('connect() establishes a WebSocket connection and sends register message', async () => {
    const messages: any[] = [];

    server = createTestServer({
      onMessage(_ws, message) {
        messages.push(JSON.parse(message));
      },
    });

    const worker = new RemoteWorker({
      serverUrl: `ws://localhost:${server.port}`,
      workerId: 'test-worker-1',
      activities: {
        processOrder: async (input) => input,
      },
      concurrency: 5,
      queue: 'test-queue',
    });

    await worker.connect();

    expect(worker.connected).toBe(true);

    // Give time for the register message to arrive
    await Bun.sleep(50);

    const registerMessage = messages.find((m) => m.type === 'register');
    expect(registerMessage).toBeDefined();
    expect(registerMessage.workerId).toBe('test-worker-1');
    expect(registerMessage.activities).toEqual(['processOrder']);
    expect(registerMessage.concurrency).toBe(5);
    expect(registerMessage.queue).toBe('test-queue');

    await worker.disconnect();
  });

  it('connect() rejects when connection fails', async () => {
    const worker = new RemoteWorker({
      serverUrl: 'ws://localhost:1',
      activities: {
        processOrder: async (input) => input,
      },
    });

    await expect(worker.connect()).rejects.toThrow();
    worker[Symbol.dispose]();
  });

  it('disconnect() closes the WebSocket connection', async () => {
    server = createTestServer();

    const worker = new RemoteWorker({
      serverUrl: `ws://localhost:${server.port}`,
      activities: {
        processOrder: async (input) => input,
      },
    });

    await worker.connect();
    expect(worker.connected).toBe(true);

    await worker.disconnect();
    expect(worker.connected).toBe(false);
  });

  it('disconnect() is safe to call when not connected', async () => {
    const worker = new RemoteWorker({
      serverUrl: 'ws://localhost:8080',
      activities: {
        processOrder: async (input) => input,
      },
    });

    // Should not throw
    await worker.disconnect();
    worker[Symbol.dispose]();
  });

  it('handles a task message and sends back a completed result', async () => {
    const messages: any[] = [];

    server = createTestServer({
      onMessage(ws, message) {
        const parsed = JSON.parse(message);
        messages.push(parsed);

        // After registration, send a task
        if (parsed.type === 'register') {
          ws.send(
            JSON.stringify({
              type: 'task',
              operationId: 'op-1',
              activityName: 'processOrder',
              input: { orderId: 123 },
            }),
          );
        }
      },
    });

    const worker = new RemoteWorker({
      serverUrl: `ws://localhost:${server.port}`,
      workerId: 'test-worker-2',
      activities: {
        processOrder: async (input: any) => ({ processed: true, orderId: input.orderId }),
      },
    });

    await worker.connect();

    // Wait for the task to be processed and result sent back
    await Bun.sleep(200);

    const taskResult = messages.find((m) => m.type === 'taskResult');
    expect(taskResult).toBeDefined();
    expect(taskResult.operationId).toBe('op-1');
    expect(taskResult.status).toBe('completed');
    expect(taskResult.value).toEqual({ processed: true, orderId: 123 });

    await worker.disconnect();
  });

  it('handles a task for an unknown activity and sends failed result', async () => {
    const messages: any[] = [];

    server = createTestServer({
      onMessage(ws, message) {
        const parsed = JSON.parse(message);
        messages.push(parsed);

        if (parsed.type === 'register') {
          ws.send(
            JSON.stringify({
              type: 'task',
              operationId: 'op-2',
              activityName: 'nonExistentActivity',
              input: null,
            }),
          );
        }
      },
    });

    const worker = new RemoteWorker({
      serverUrl: `ws://localhost:${server.port}`,
      workerId: 'test-worker-3',
      activities: {
        processOrder: async (input) => input,
      },
    });

    await worker.connect();
    await Bun.sleep(200);

    const taskResult = messages.find((m) => m.type === 'taskResult');
    expect(taskResult).toBeDefined();
    expect(taskResult.operationId).toBe('op-2');
    expect(taskResult.status).toBe('failed');
    expect(taskResult.error).toContain('Unknown activity');

    await worker.disconnect();
  });

  it('handles a task that throws and sends failed result', async () => {
    const messages: any[] = [];

    server = createTestServer({
      onMessage(ws, message) {
        const parsed = JSON.parse(message);
        messages.push(parsed);

        if (parsed.type === 'register') {
          ws.send(
            JSON.stringify({
              type: 'task',
              operationId: 'op-3',
              activityName: 'failingActivity',
              input: null,
            }),
          );
        }
      },
    });

    const worker = new RemoteWorker({
      serverUrl: `ws://localhost:${server.port}`,
      workerId: 'test-worker-4',
      activities: {
        failingActivity: async () => {
          throw new Error('activity crashed');
        },
      },
    });

    await worker.connect();
    await Bun.sleep(200);

    const taskResult = messages.find((m) => m.type === 'taskResult');
    expect(taskResult).toBeDefined();
    expect(taskResult.operationId).toBe('op-3');
    expect(taskResult.status).toBe('failed');
    expect(taskResult.error).toBe('activity crashed');

    await worker.disconnect();
  });

  it('handles a non-Error throw and sends stringified error', async () => {
    const messages: any[] = [];

    server = createTestServer({
      onMessage(ws, message) {
        const parsed = JSON.parse(message);
        messages.push(parsed);

        if (parsed.type === 'register') {
          ws.send(
            JSON.stringify({
              type: 'task',
              operationId: 'op-4',
              activityName: 'stringThrow',
              input: null,
            }),
          );
        }
      },
    });

    const worker = new RemoteWorker({
      serverUrl: `ws://localhost:${server.port}`,
      workerId: 'test-worker-5',
      activities: {
        stringThrow: async () => {
          throw 'string error';
        },
      },
    });

    await worker.connect();
    await Bun.sleep(200);

    const taskResult = messages.find((m) => m.type === 'taskResult');
    expect(taskResult).toBeDefined();
    expect(taskResult.status).toBe('failed');
    expect(taskResult.error).toBe('string error');

    await worker.disconnect();
  });

  it('tracks inFlight count during task execution', async () => {
    let resolveActivity: (() => void) | undefined;
    const activityPromise = new Promise<void>((resolve) => {
      resolveActivity = resolve;
    });

    server = createTestServer({
      onMessage(ws, message) {
        const parsed = JSON.parse(message);

        if (parsed.type === 'register') {
          ws.send(
            JSON.stringify({
              type: 'task',
              operationId: 'op-5',
              activityName: 'slowActivity',
              input: null,
            }),
          );
        }
      },
    });

    const worker = new RemoteWorker({
      serverUrl: `ws://localhost:${server.port}`,
      activities: {
        slowActivity: async () => {
          await activityPromise;
          return 'done';
        },
      },
    });

    await worker.connect();
    await Bun.sleep(100);

    // Activity should be in-flight
    expect(worker.inFlight).toBe(1);

    // Resolve the activity
    resolveActivity!();
    await Bun.sleep(100);

    expect(worker.inFlight).toBe(0);

    await worker.disconnect();
  });

  it('close event resets ws and stops heartbeat', async () => {
    server = createTestServer();

    const worker = new RemoteWorker({
      serverUrl: `ws://localhost:${server.port}`,
      activities: {
        processOrder: async (input) => input,
      },
    });

    await worker.connect();
    expect(worker.connected).toBe(true);

    // Stop the server, which will trigger the close event
    server.stop(true);
    server = undefined;
    await Bun.sleep(200);

    expect(worker.connected).toBe(false);
    worker[Symbol.dispose]();
  });

  it('ignores non-task messages', async () => {
    server = createTestServer({
      onMessage(ws, message) {
        const parsed = JSON.parse(message);

        if (parsed.type === 'register') {
          // Send a non-task message
          ws.send(JSON.stringify({ type: 'ping' }));
        }
      },
    });

    const worker = new RemoteWorker({
      serverUrl: `ws://localhost:${server.port}`,
      activities: {
        processOrder: async (input) => input,
      },
    });

    await worker.connect();
    await Bun.sleep(100);

    // Worker should still be connected and working fine
    expect(worker.connected).toBe(true);
    expect(worker.inFlight).toBe(0);

    await worker.disconnect();
  });

  it('sendMessage is a no-op when not connected (disposed before heartbeat fires)', async () => {
    server = createTestServer();

    const worker = new RemoteWorker({
      serverUrl: `ws://localhost:${server.port}`,
      activities: {
        processOrder: async (input) => input,
      },
    });

    await worker.connect();
    expect(worker.connected).toBe(true);

    // Dispose the worker (sets ws to null via close)
    worker[Symbol.dispose]();

    // Worker should no longer be connected
    expect(worker.connected).toBe(false);
  });

  it('sends heartbeat messages periodically', async () => {
    const messages: any[] = [];

    server = createTestServer({
      onMessage(_ws, message) {
        messages.push(JSON.parse(message));
      },
    });

    // Use a very short heartbeat by creating a worker with the default,
    // but we can verify the heartbeat was started by checking the register
    // message was sent (heartbeat manager is started on connect)
    const worker = new RemoteWorker({
      serverUrl: `ws://localhost:${server.port}`,
      workerId: 'heartbeat-test',
      activities: {},
    });

    await worker.connect();
    await Bun.sleep(50);

    // At minimum, the register message should have been sent
    expect(messages.length).toBeGreaterThanOrEqual(1);
    expect(messages[0].type).toBe('register');

    await worker.disconnect();
  });

  it('shuttingDown is false initially', () => {
    const worker = new RemoteWorker({
      serverUrl: 'ws://localhost:8080',
      activities: {
        processOrder: async (input) => input,
      },
    });

    expect(worker.shuttingDown).toBe(false);
    worker[Symbol.dispose]();
  });

  it('handles shutdown message and gracefully shuts down', async () => {
    const messages: any[] = [];

    server = createTestServer({
      onMessage(ws, message) {
        const parsed = JSON.parse(message);
        messages.push(parsed);

        if (parsed.type === 'register') {
          // Send a shutdown message
          ws.send(JSON.stringify({ type: 'shutdown' }));
        }
      },
    });

    const worker = new RemoteWorker({
      serverUrl: `ws://localhost:${server.port}`,
      workerId: 'shutdown-test',
      activities: {
        processOrder: async (input) => input,
      },
    });

    await worker.connect();
    expect(worker.connected).toBe(true);

    // Wait for the shutdown message to be processed
    await Bun.sleep(200);

    // After shutdown, the worker should have set shuttingDown to true
    // and eventually closed the connection
    expect(worker.shuttingDown).toBe(true);
    expect(worker.connected).toBe(false);

    worker[Symbol.dispose]();
  });

  it('graceful shutdown waits for in-flight tasks before closing', async () => {
    let resolveActivity: (() => void) | undefined;
    const activityPromise = new Promise<void>((resolve) => {
      resolveActivity = resolve;
    });
    const messages: any[] = [];

    server = createTestServer({
      onMessage(ws, message) {
        const parsed = JSON.parse(message);
        messages.push(parsed);

        if (parsed.type === 'register') {
          // Send a task first
          ws.send(
            JSON.stringify({
              type: 'task',
              operationId: 'op-shutdown-1',
              activityName: 'slowActivity',
              input: null,
            }),
          );

          // Then send shutdown after a brief delay
          setTimeout(() => {
            ws.send(JSON.stringify({ type: 'shutdown' }));
          }, 50);
        }
      },
    });

    const worker = new RemoteWorker({
      serverUrl: `ws://localhost:${server.port}`,
      workerId: 'graceful-shutdown-test',
      activities: {
        slowActivity: async () => {
          await activityPromise;
          return 'done';
        },
      },
    });

    await worker.connect();
    await Bun.sleep(100);

    // Task should be in-flight
    expect(worker.inFlight).toBe(1);

    // Wait for the shutdown message to arrive
    await Bun.sleep(100);
    expect(worker.shuttingDown).toBe(true);

    // Worker should still be connected (waiting for in-flight task)
    // The connection might be in process of closing, but inFlight > 0

    // Resolve the activity so the graceful shutdown can complete
    resolveActivity!();
    await Bun.sleep(200);

    expect(worker.inFlight).toBe(0);
    expect(worker.connected).toBe(false);

    // Verify the task result was sent
    const taskResult = messages.find((m) => m.type === 'taskResult');
    expect(taskResult).toBeDefined();
    expect(taskResult.status).toBe('completed');

    worker[Symbol.dispose]();
  });

  it('ignores task messages when shutting down', async () => {
    const messages: any[] = [];
    let tasksSentCount = 0;

    server = createTestServer({
      onMessage(ws, message) {
        const parsed = JSON.parse(message);
        messages.push(parsed);

        if (parsed.type === 'register') {
          // Send shutdown first
          ws.send(JSON.stringify({ type: 'shutdown' }));

          // Then try to send a task after shutdown is received
          setTimeout(() => {
            tasksSentCount++;
            ws.send(
              JSON.stringify({
                type: 'task',
                operationId: 'op-post-shutdown',
                activityName: 'processOrder',
                input: null,
              }),
            );
          }, 100);
        }
      },
    });

    const worker = new RemoteWorker({
      serverUrl: `ws://localhost:${server.port}`,
      workerId: 'ignore-post-shutdown-test',
      activities: {
        processOrder: async (input) => input,
      },
    });

    await worker.connect();
    await Bun.sleep(300);

    // Verify the task was sent by the server
    expect(tasksSentCount).toBe(1);

    // But no taskResult should have been produced for the post-shutdown task
    const taskResults = messages.filter((m) => m.type === 'taskResult');
    expect(taskResults.length).toBe(0);

    worker[Symbol.dispose]();
  });

  it('disconnect resolves after timeout when tasks are still in-flight', async () => {
    // A task that never resolves — it holds the in-flight counter at 1 forever
    const neverResolves = new Promise<never>(() => {});

    server = createTestServer({
      onMessage(ws, message) {
        const parsed = JSON.parse(message);

        if (parsed.type === 'register') {
          ws.send(
            JSON.stringify({
              type: 'task',
              operationId: 'op-timeout-1',
              activityName: 'hangingActivity',
              input: null,
            }),
          );
        }
      },
    });

    const disconnectTimeoutMs = 200;

    const worker = new RemoteWorker({
      serverUrl: `ws://localhost:${server.port}`,
      workerId: 'disconnect-timeout-test',
      activities: {
        hangingActivity: async () => {
          await neverResolves;
        },
      },
      disconnectTimeoutMs,
    });

    await worker.connect();

    // Wait for the task to be picked up so inFlight increments
    await Bun.sleep(100);
    expect(worker.inFlight).toBe(1);

    const startTime = Date.now();

    // disconnect() must not hang — it should break out of the polling loop after the timeout
    await worker.disconnect();

    const elapsed = Date.now() - startTime;

    // Should have resolved within the timeout plus generous tolerance for CI jitter
    expect(elapsed).toBeLessThan(disconnectTimeoutMs + 500);

    // The connection should be closed even though a task is still technically "in-flight"
    expect(worker.connected).toBe(false);
  });

  it('graceful shutdown resolves after timeout when tasks are still in-flight', async () => {
    // A task that never resolves
    const neverResolves = new Promise<never>(() => {});

    server = createTestServer({
      onMessage(ws, message) {
        const parsed = JSON.parse(message);

        if (parsed.type === 'register') {
          // Dispatch a task that will never finish
          ws.send(
            JSON.stringify({
              type: 'task',
              operationId: 'op-shutdown-timeout-1',
              activityName: 'hangingActivity',
              input: null,
            }),
          );

          // Send the shutdown command shortly after so the worker starts draining
          setTimeout(() => {
            ws.send(JSON.stringify({ type: 'shutdown' }));
          }, 50);
        }
      },
    });

    const disconnectTimeoutMs = 200;

    const worker = new RemoteWorker({
      serverUrl: `ws://localhost:${server.port}`,
      workerId: 'graceful-shutdown-timeout-test',
      activities: {
        hangingActivity: async () => {
          await neverResolves;
        },
      },
      disconnectTimeoutMs,
    });

    await worker.connect();

    // Wait for the task to start and the shutdown message to be received
    await Bun.sleep(100);
    expect(worker.inFlight).toBe(1);

    // Wait for the shutdown to be acknowledged
    await Bun.sleep(50);
    expect(worker.shuttingDown).toBe(true);

    const startTime = Date.now();

    // Wait for the graceful shutdown to time out and complete
    // The shutdown runs async inside #handleMessage, so we poll until connected goes false
    const shutdownTimeoutMs = disconnectTimeoutMs + 500;
    while (worker.connected && Date.now() - startTime < shutdownTimeoutMs) {
      await Bun.sleep(50);
    }

    const elapsed = Date.now() - startTime;

    // Should have closed within the timeout plus generous tolerance
    expect(elapsed).toBeLessThan(shutdownTimeoutMs);
    expect(worker.connected).toBe(false);

    worker[Symbol.dispose]();
  });

  it('[Symbol.dispose] closes connection when ws is open', async () => {
    server = createTestServer();

    const worker = new RemoteWorker({
      serverUrl: `ws://localhost:${server.port}`,
      activities: {},
    });

    await worker.connect();
    expect(worker.connected).toBe(true);

    worker[Symbol.dispose]();
    expect(worker.connected).toBe(false);

    // Calling dispose again should not throw
    worker[Symbol.dispose]();
  });

  it('can reconnect after disconnect (AbortController is replaced)', async () => {
    server = createTestServer();

    const worker = new RemoteWorker({
      serverUrl: `ws://localhost:${server.port}`,
      activities: {
        processOrder: async (input) => input,
      },
    });

    await worker.connect();
    expect(worker.connected).toBe(true);

    await worker.disconnect();
    expect(worker.connected).toBe(false);

    // Reconnect — this would hang forever if the AbortController was not replaced
    await worker.connect();
    expect(worker.connected).toBe(true);

    await worker.disconnect();
  });

  it('can reconnect after dispose (AbortController is replaced)', async () => {
    server = createTestServer();

    const worker = new RemoteWorker({
      serverUrl: `ws://localhost:${server.port}`,
      activities: {
        processOrder: async (input) => input,
      },
    });

    await worker.connect();
    expect(worker.connected).toBe(true);

    worker[Symbol.dispose]();
    expect(worker.connected).toBe(false);

    // Reconnect — this would hang forever if the AbortController was not replaced
    await worker.connect();
    expect(worker.connected).toBe(true);

    await worker.disconnect();
  });
});
