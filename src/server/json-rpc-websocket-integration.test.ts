/**
 * End-to-end integration — `serve()` WebSocket /jsonrpc endpoint wired to
 * the JSON-RPC WebSocket session adapter.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import type { Context } from '../core/context.ts';
import { Engine } from '../core/engine.ts';
import type { WorkflowContext } from '../core/types.ts';
import { MemoryStorage } from '../storage/memory.ts';
import { serve, type WeftServer } from './index.ts';

function waitForMessage(
  ws: WebSocket,
  predicate: (parsed: unknown) => boolean,
  timeoutMs = 3_000,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.removeEventListener('message', handler);
      reject(new Error('waitForMessage timed out'));
    }, timeoutMs);

    function handler(event: MessageEvent) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(String(event.data));
      } catch {
        return;
      }

      if (predicate(parsed)) {
        clearTimeout(timer);
        ws.removeEventListener('message', handler);
        resolve(parsed);
      }
    }

    ws.addEventListener('message', handler);
  });
}

function openWebSocket(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.addEventListener('open', () => resolve(ws));
    ws.addEventListener('error', (event) => reject(event));
  });
}

function createHoldEngine(): Engine {
  const storage = new MemoryStorage();
  const engine = new Engine({ storage });
  engine.register('hold', async function* (ctx: WorkflowContext, _input: unknown) {
    return yield* (ctx as Context).waitForSignal<string>('release');
  });
  return engine;
}

async function waitForStatus(
  engine: Engine,
  workflowId: string,
  status: 'running' | 'completed' | 'failed' | 'cancelled' | 'timed-out',
  timeoutMilliseconds = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    const state = await engine.get(workflowId);
    if (state?.status === status) return;
    await Bun.sleep(10);
  }
  throw new Error(`workflow ${workflowId} did not reach ${status} in time`);
}

describe('serve() — WebSocket /jsonrpc', () => {
  let server: WeftServer | undefined;
  let engine: Engine | undefined;

  beforeEach(() => {
    engine = createHoldEngine();
  });

  afterEach(async () => {
    await server?.stop();
    server = undefined;
    engine = undefined;
  });

  it('test a: weft.workflows.get over WS returns a JSON-RPC success envelope', async () => {
    engine = createHoldEngine();
    const handle = await engine.start('hold', {}, {});
    await waitForStatus(engine, handle.id, 'running');

    server = serve({ engine, port: 0 });
    const wsUrl = `${server.url.replace('http://', 'ws://')}/jsonrpc`;
    const ws = await openWebSocket(wsUrl);

    const responsePromise = waitForMessage(ws, (parsed: any) => parsed?.id === 42);
    ws.send(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 42,
        method: 'weft.workflows.get',
        params: { workflowId: handle.id },
      }),
    );

    const response = (await responsePromise) as any;
    expect(response.jsonrpc).toBe('2.0');
    expect(response.id).toBe(42);
    expect(response.result).toBeDefined();
    expect(response.result.id).toBe(handle.id);
    expect(response.result.status).toBe('running');

    ws.close();
  });

  it('test b: subscribe to events selector and receive weft.events.deliver notifications', async () => {
    engine = createHoldEngine();
    const handle = await engine.start('hold', {}, {});
    await waitForStatus(engine, handle.id, 'running');

    server = serve({ engine, port: 0 });
    const wsUrl = `${server.url.replace('http://', 'ws://')}/jsonrpc`;
    const ws = await openWebSocket(wsUrl);

    const subscribeResponsePromise = waitForMessage(
      ws,
      (parsed: any) => parsed?.id === 1 && parsed?.result?.subscriptionId,
    );
    ws.send(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'weft.workflows.subscribe',
        params: { workflowId: handle.id, selector: 'events' },
      }),
    );

    const subscribeResponse = (await subscribeResponsePromise) as any;
    expect(subscribeResponse.result.subscriptionId).toBeTruthy();
    const subscriptionId = subscribeResponse.result.subscriptionId as string;

    const deliverPromise = waitForMessage(
      ws,
      (parsed: any) =>
        parsed?.method === 'weft.events.deliver' &&
        parsed?.params?.subscriptionId === subscriptionId,
    );

    await engine.signal(handle.id, 'release', 'done');

    const delivered = (await deliverPromise) as any;
    expect(delivered.params.subscriptionId).toBe(subscriptionId);
    expect(delivered.params.envelope).toBeDefined();
    expect(delivered.params.envelope.workflowId).toBe(handle.id);
    // Tighten the assertion so a wrong-selector listener cannot
    // silently pass by hitting the `workflowId` check alone.
    expect(delivered.params.envelope.selector).toBe('events');
    expect(typeof delivered.params.envelope.kind).toBe('string');
    expect(typeof delivered.params.envelope.sequence).toBe('number');
    expect(delivered.params.envelope.sequence).toBeGreaterThanOrEqual(0);
    expect(typeof delivered.params.envelope.cursor).toBe('string');

    ws.close();
  });

  it('test c: unsubscribe stops further deliveries and close tears down cleanly', async () => {
    engine = createHoldEngine();
    const handle = await engine.start('hold', {}, {});
    await waitForStatus(engine, handle.id, 'running');

    server = serve({ engine, port: 0 });
    const wsUrl = `${server.url.replace('http://', 'ws://')}/jsonrpc`;
    const ws = await openWebSocket(wsUrl);

    const subscribeResponsePromise = waitForMessage(
      ws,
      (parsed: any) => parsed?.id === 1 && parsed?.result?.subscriptionId,
    );
    ws.send(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'weft.workflows.subscribe',
        params: { workflowId: handle.id, selector: 'events' },
      }),
    );
    const subscribeResponse = (await subscribeResponsePromise) as any;
    const subscriptionId = subscribeResponse.result.subscriptionId as string;

    const unsubscribeResponsePromise = waitForMessage(ws, (parsed: any) => parsed?.id === 2);
    ws.send(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'weft.workflows.unsubscribe',
        params: { subscriptionId },
      }),
    );
    const unsubscribeResponse = (await unsubscribeResponsePromise) as any;
    expect(unsubscribeResponse.result).toBeDefined();

    let deliveredAfterUnsubscribe = false;
    ws.addEventListener('message', (event: MessageEvent) => {
      let parsed: any;
      try {
        parsed = JSON.parse(String(event.data));
      } catch {
        return;
      }

      if (
        parsed?.method === 'weft.events.deliver' &&
        parsed?.params?.subscriptionId === subscriptionId
      ) {
        deliveredAfterUnsubscribe = true;
      }
    });

    await engine.signal(handle.id, 'release', 'done');
    await Bun.sleep(100);

    expect(deliveredAfterUnsubscribe).toBe(false);

    // Close the socket and guard against silently-swallowed errors
    // from `session.close()` — the close handler fires it fire-and-
    // forget with a `.catch(console.error)`, so a throw here would
    // surface only via `process.on('unhandledRejection')` otherwise.
    let leakedRejection: unknown = null;
    const rejectionHandler = (reason: unknown) => {
      leakedRejection = reason;
    };
    process.on('unhandledRejection', rejectionHandler);
    try {
      ws.close();
      await Bun.sleep(50);
    } finally {
      process.off('unhandledRejection', rejectionHandler);
    }
    expect(leakedRejection).toBeNull();
  });

  it('test d: missing Upgrade header still routes POST /jsonrpc through the HTTP adapter', async () => {
    engine = createHoldEngine();
    const handle = await engine.start('hold', {}, {});
    await waitForStatus(engine, handle.id, 'running');

    server = serve({ engine, port: 0 });

    const response = await fetch(`${server.url}/jsonrpc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 99,
        method: 'weft.workflows.get',
        params: { workflowId: handle.id },
      }),
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.jsonrpc).toBe('2.0');
    expect(body.id).toBe(99);
    expect(body.result?.id).toBe(handle.id);
  });

  it('test e: auth failure before upgrade returns 401 and does not attempt WS upgrade', async () => {
    engine = createHoldEngine();
    server = serve({
      engine,
      port: 0,
      auth: {
        apiKeys: ['weft_key_valid123456789012345678901'],
      },
    });

    const wsUrl = `${server.url.replace('http://', 'ws://')}/jsonrpc`;
    const ws = new WebSocket(wsUrl);

    const errorOrClose = await new Promise<{ type: string; code?: number }>((resolve) => {
      ws.addEventListener('error', () => resolve({ type: 'error' }));
      ws.addEventListener('close', (event: CloseEvent) =>
        resolve({ type: 'close', code: event.code }),
      );
    });

    expect(errorOrClose.type).toMatch(/error|close/);

    const response = await fetch(`${server.url}/jsonrpc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'weft.workflows.list',
        params: {},
      }),
    });
    expect(response.status).toBe(401);
  });

  it('test f: close without explicit unsubscribe tears down without unhandled rejections', async () => {
    // Adversarial: the client drops the connection without ever
    // calling `weft.workflows.unsubscribe`. The server's
    // `websocket.close` must invoke `session.close()`, which in
    // turn must abort the subscription pump and unregister the
    // engine listener — all without surfacing a process-level
    // unhandled-rejection event (from a late `emitter.send()` on a
    // closed socket, for example).
    engine = createHoldEngine();
    const handle = await engine.start('hold', {}, {});
    await waitForStatus(engine, handle.id, 'running');

    server = serve({ engine, port: 0 });
    const wsUrl = `${server.url.replace('http://', 'ws://')}/jsonrpc`;
    const ws = await openWebSocket(wsUrl);

    const subscribeResponsePromise = waitForMessage(
      ws,
      (parsed: any) => parsed?.id === 1 && parsed?.result?.subscriptionId,
    );
    ws.send(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'weft.workflows.subscribe',
        params: { workflowId: handle.id, selector: 'events' },
      }),
    );
    await subscribeResponsePromise;

    let leakedRejection: unknown = null;
    const rejectionHandler = (reason: unknown) => {
      leakedRejection = reason;
    };
    process.on('unhandledRejection', rejectionHandler);

    try {
      // Close without unsubscribing — the session should tear down
      // cleanly on the server side.
      ws.close();

      // Trigger commits AFTER close so any late emitter.send() on a
      // closed socket would either fire (expected: swallowed by the
      // session's try/catch) or leak as an unhandled rejection.
      await engine.signal(handle.id, 'release', 'done');
      await Bun.sleep(50);
    } finally {
      process.off('unhandledRejection', rejectionHandler);
    }

    expect(leakedRejection).toBeNull();
  });

  it('test g: authenticated principal survives the WS upgrade boundary', async () => {
    // Regression guard: Bun's `server.upgrade({ data })` stores the
    // `WebSocketData` object by reference, preserving methods and
    // identity. If a future change (or Bun version) ever structure-
    // cloned the upgrade data, an `AuthenticatedPrincipal`'s
    // `hasScope` method would become undefined after upgrade and
    // scope-gated operations would fail silently.
    //
    // We verify indirectly: configure api-key auth with a default
    // scope set, upgrade a WS connection with the valid key, and
    // call `weft.workflows.get` — which requires a principal. If
    // the principal did not survive the upgrade, dispatch would
    // reject with an authorization error instead of returning the
    // workflow.
    engine = createHoldEngine();
    const handle = await engine.start('hold', {}, {});
    await waitForStatus(engine, handle.id, 'running');

    const apiKey = 'weft_key_valid123456789012345678901';
    server = serve({
      engine,
      port: 0,
      auth: {
        apiKeys: [apiKey],
      },
    });

    const wsUrl = `${server.url.replace('http://', 'ws://')}/jsonrpc`;
    const ws = await new Promise<WebSocket>((resolve, reject) => {
      const socket = new WebSocket(wsUrl, {
        headers: { authorization: `Bearer ${apiKey}` },
        // oxlint-disable-next-line typescript/no-explicit-any -- Bun's WebSocket accepts a headers init option not in the lib.dom type.
      } as any);
      socket.addEventListener('open', () => resolve(socket));
      socket.addEventListener('error', (event: Event) => reject(event));
    });

    const responsePromise = waitForMessage(ws, (parsed: any) => parsed?.id === 1);
    ws.send(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'weft.workflows.get',
        params: { workflowId: handle.id },
      }),
    );

    const response = (await responsePromise) as any;
    expect(response.result).toBeDefined();
    expect(response.result.id).toBe(handle.id);

    ws.close();
  });
});
