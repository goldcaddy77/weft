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

    ws.close();
    await Bun.sleep(50);
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
});
