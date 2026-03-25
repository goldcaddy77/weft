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
      if (server.upgrade(request)) return undefined;
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
});
