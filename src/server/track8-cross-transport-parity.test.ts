import { afterEach, describe, expect, it } from 'bun:test';

import type { Context } from '../core/context.ts';
import { Engine } from '../core/engine.ts';
import type { WorkflowContext } from '../core/types.ts';
import { MemoryStorage } from '../storage/memory.ts';
import { createEngineEventFeedBackend } from './engine-event-feed-backend.ts';
import { serve, type WeftServer } from './index.ts';
import { createLiveOperationRegistry } from './rest-bindings.ts';
import { runStdioSession } from './stdio-session.ts';
import {
  assertIdenticalFaultCode,
  assertIdenticalJson,
  assertShapeEquivalent,
  type ParityInvariants,
} from './track8-parity-invariants.ts';
import { createWorkflowEventFeed } from './workflow-event-feed.ts';

type WorkflowTerminalStatus = 'completed' | 'failed' | 'cancelled' | 'timed-out';
type WorkflowStatus = 'running' | WorkflowTerminalStatus;
type TransportName = 'rest' | 'json-rpc-http' | 'json-rpc-websocket' | 'json-rpc-stdio';

const registry = createLiveOperationRegistry();

function createHoldEngine(): Engine {
  const engine = new Engine({ storage: new MemoryStorage() });
  engine.register('hold', async function* (ctx: WorkflowContext) {
    return yield* (ctx as Context).waitForSignal('release');
  });
  return engine;
}

async function waitForStatus(
  engine: Engine,
  workflowId: string,
  status: WorkflowStatus,
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

async function postJsonRpc(
  server: WeftServer,
  method: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  const response = await fetch(`${server.url}/jsonrpc`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: crypto.randomUUID(),
      method,
      params,
    }),
  });
  expect(response.status).toBe(200);
  const body = (await response.json()) as { error?: unknown; result?: unknown };
  expect(body.error).toBeUndefined();
  return body.result;
}

function waitForMessage(
  webSocket: WebSocket,
  predicate: (parsed: unknown) => boolean,
  timeoutMilliseconds = 3_000,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      webSocket.removeEventListener('message', handler);
      reject(new Error('waitForMessage timed out'));
    }, timeoutMilliseconds);

    function handler(event: MessageEvent): void {
      let parsed: unknown;
      try {
        parsed = JSON.parse(String(event.data));
      } catch {
        return;
      }

      if (predicate(parsed)) {
        clearTimeout(timer);
        webSocket.removeEventListener('message', handler);
        resolve(parsed);
      }
    }

    webSocket.addEventListener('message', handler);
  });
}

function openWebSocket(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const webSocket = new WebSocket(url);
    webSocket.addEventListener('open', () => resolve(webSocket));
    webSocket.addEventListener('error', (event) => reject(event));
  });
}

function readableFromLines(lines: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const line of lines) {
        controller.enqueue(encoder.encode(line));
      }
      controller.close();
    },
  });
}

function collectingWritable(): {
  stream: WritableStream<Uint8Array>;
  lines(): string[];
} {
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  const complete: string[] = [];

  return {
    stream: new WritableStream<Uint8Array>({
      write(chunk) {
        buffer += decoder.decode(chunk, { stream: true });
        let newlineIndex = buffer.indexOf('\n');
        while (newlineIndex !== -1) {
          complete.push(buffer.slice(0, newlineIndex));
          buffer = buffer.slice(newlineIndex + 1);
          newlineIndex = buffer.indexOf('\n');
        }
      },
      close() {
        if (buffer.length > 0) {
          complete.push(buffer);
        }
      },
    }),
    lines() {
      return [...complete];
    },
  };
}

async function invokeStdioJsonRpc(
  engine: Engine,
  method: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  const feed = createWorkflowEventFeed(createEngineEventFeedBackend(engine));
  const output = collectingWritable();
  try {
    const result = await runStdioSession({
      input: readableFromLines([
        JSON.stringify({
          jsonrpc: '2.0',
          id: crypto.randomUUID(),
          method,
          params,
        }) + '\n',
      ]),
      output: output.stream,
      admission: { kind: 'allow-unauthenticated-local-admin' },
      registry,
      engine,
      feed,
    });

    expect(result.exitCode).toBe(0);
    const [firstLine] = output.lines();
    expect(firstLine).toBeDefined();
    const response = JSON.parse(firstLine!) as { error?: unknown; result?: unknown };
    expect(response.error).toBeUndefined();
    return response.result;
  } finally {
    feed.dispose();
  }
}

async function invokeStdioJsonRpcExpectError(
  engine: Engine,
  method: string,
  params: Record<string, unknown>,
): Promise<{ code: number; data?: Record<string, unknown> }> {
  const feed = createWorkflowEventFeed(createEngineEventFeedBackend(engine));
  const output = collectingWritable();
  try {
    const result = await runStdioSession({
      input: readableFromLines([
        JSON.stringify({
          jsonrpc: '2.0',
          id: crypto.randomUUID(),
          method,
          params,
        }) + '\n',
      ]),
      output: output.stream,
      admission: { kind: 'allow-unauthenticated-local-admin' },
      registry,
      engine,
      feed,
    });

    expect(result.exitCode).toBe(0);
    const [firstLine] = output.lines();
    expect(firstLine).toBeDefined();
    const response = JSON.parse(firstLine!) as {
      error?: { code?: number; data?: Record<string, unknown> };
    };
    expect(response.error).toBeDefined();
    expect(typeof response.error?.code).toBe('number');
    return {
      code: response.error!.code!,
      ...(response.error?.data !== undefined ? { data: response.error.data } : {}),
    };
  } finally {
    feed.dispose();
  }
}

function assertSuccessParity(
  results: Record<TransportName, unknown>,
  invariants: ParityInvariants,
  label: string,
): void {
  const baselineTransport: TransportName = 'rest';
  const baseline = results[baselineTransport];

  for (const [transport, result] of Object.entries(results) as Array<[TransportName, unknown]>) {
    if (transport === baselineTransport) continue;

    if (invariants.successPayload === 'identical-json') {
      assertIdenticalJson(baseline, result, `${label}: ${baselineTransport} vs ${transport}`);
    } else {
      assertShapeEquivalent(baseline, result, `${label}: ${baselineTransport} vs ${transport}`);
    }
  }
}

async function invokeGetAcrossTransports(
  engine: Engine,
  server: WeftServer,
  workflowId: string,
): Promise<Record<TransportName, unknown>> {
  const restResponse = await fetch(`${server.url}/v1/workflows/${workflowId}`);
  expect(restResponse.status).toBe(200);
  const rest = await restResponse.json();

  const jsonRpcHttp = await postJsonRpc(server, 'weft.workflows.get', { workflowId });

  const webSocket = await openWebSocket(`${server.url.replace('http://', 'ws://')}/jsonrpc`);
  try {
    const messagePromise = waitForMessage(
      webSocket,
      (parsed) =>
        typeof parsed === 'object' &&
        parsed !== null &&
        (parsed as { id?: string }).id === 'track8-get',
    );
    webSocket.send(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 'track8-get',
        method: 'weft.workflows.get',
        params: { workflowId },
      }),
    );
    const webSocketResponse = (await messagePromise) as { error?: unknown; result?: unknown };
    expect(webSocketResponse.error).toBeUndefined();

    const stdio = await invokeStdioJsonRpc(engine, 'weft.workflows.get', { workflowId });

    return {
      rest,
      'json-rpc-http': jsonRpcHttp,
      'json-rpc-websocket': webSocketResponse.result,
      'json-rpc-stdio': stdio,
    };
  } finally {
    webSocket.close();
  }
}

async function invokeSignalTransport(
  transport: TransportName,
  servers: WeftServer[],
  engines: Engine[],
): Promise<{ callCount: number; result: unknown; workflowResult: unknown }> {
  const engine = createHoldEngine();
  engines.push(engine);

  let callCount = 0;
  const originalSignal = engine.signal.bind(engine);
  engine.signal = async (...args: Parameters<Engine['signal']>) => {
    callCount += 1;
    return originalSignal(...args);
  };

  const handle = await engine.start('hold', null, { id: `track8-signal-${transport}` });
  await waitForStatus(engine, handle.id, 'running');

  const server = serve({ engine, port: 0 });
  servers.push(server);

  let result: unknown;
  switch (transport) {
    case 'rest': {
      const response = await fetch(`${server.url}/v1/workflows/${handle.id}/signal/release`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ payload: 'released' }),
      });
      expect(response.status).toBe(200);
      result = await response.json();
      break;
    }
    case 'json-rpc-http':
      result = await postJsonRpc(server, 'weft.workflows.signal', {
        workflowId: handle.id,
        signalName: 'release',
        payload: 'released',
      });
      break;
    case 'json-rpc-websocket': {
      const webSocket = await openWebSocket(`${server.url.replace('http://', 'ws://')}/jsonrpc`);
      try {
        const messagePromise = waitForMessage(
          webSocket,
          (parsed) =>
            typeof parsed === 'object' &&
            parsed !== null &&
            (parsed as { id?: string }).id === 'track8-signal',
        );
        webSocket.send(
          JSON.stringify({
            jsonrpc: '2.0',
            id: 'track8-signal',
            method: 'weft.workflows.signal',
            params: {
              workflowId: handle.id,
              signalName: 'release',
              payload: 'released',
            },
          }),
        );
        const response = (await messagePromise) as { error?: unknown; result?: unknown };
        expect(response.error).toBeUndefined();
        result = response.result;
      } finally {
        webSocket.close();
      }
      break;
    }
    case 'json-rpc-stdio':
      result = await invokeStdioJsonRpc(engine, 'weft.workflows.signal', {
        workflowId: handle.id,
        signalName: 'release',
        payload: 'released',
      });
      break;
  }

  const workflowResult = await handle.result();
  return { callCount, result, workflowResult };
}

async function invokeStartTransport(
  transport: TransportName,
  servers: WeftServer[],
  engines: Engine[],
): Promise<{ callCount: number; result: unknown; state: unknown }> {
  const engine = createHoldEngine();
  engines.push(engine);

  let callCount = 0;
  const originalStart = engine.start.bind(engine);
  engine.start = async (...args: Parameters<Engine['start']>) => {
    callCount += 1;
    return originalStart(...args);
  };

  const server = serve({ engine, port: 0 });
  servers.push(server);

  let result: unknown;
  switch (transport) {
    case 'rest': {
      const response = await fetch(`${server.url}/v1/workflows`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'hold' }),
      });
      expect(response.status).toBe(201);
      result = await response.json();
      break;
    }
    case 'json-rpc-http':
      result = await postJsonRpc(server, 'weft.workflows.start', { type: 'hold' });
      break;
    case 'json-rpc-websocket': {
      const webSocket = await openWebSocket(`${server.url.replace('http://', 'ws://')}/jsonrpc`);
      try {
        const messagePromise = waitForMessage(
          webSocket,
          (parsed) =>
            typeof parsed === 'object' &&
            parsed !== null &&
            (parsed as { id?: string }).id === 'track8-start',
        );
        webSocket.send(
          JSON.stringify({
            jsonrpc: '2.0',
            id: 'track8-start',
            method: 'weft.workflows.start',
            params: { type: 'hold' },
          }),
        );
        const response = (await messagePromise) as { error?: unknown; result?: unknown };
        expect(response.error).toBeUndefined();
        result = response.result;
      } finally {
        webSocket.close();
      }
      break;
    }
    case 'json-rpc-stdio':
      result = await invokeStdioJsonRpc(engine, 'weft.workflows.start', { type: 'hold' });
      break;
  }

  const workflowId = (result as { id?: string }).id;
  expect(typeof workflowId).toBe('string');
  const state = await postJsonRpc(server, 'weft.workflows.get', { workflowId });
  return { callCount, result, state };
}

async function invokeBulkCancelTransport(
  transport: TransportName,
  servers: WeftServer[],
  engines: Engine[],
): Promise<{ callCount: number; result: unknown }> {
  const engine = createHoldEngine();
  engines.push(engine);

  let callCount = 0;
  const originalCancelAll = engine.cancelAll.bind(engine);
  engine.cancelAll = async (...args: Parameters<Engine['cancelAll']>) => {
    callCount += 1;
    return originalCancelAll(...args);
  };

  await engine.start('hold', null, {
    id: `track8-bulk-selected-a-${transport}`,
    tags: ['selected'],
  });
  await engine.start('hold', null, {
    id: `track8-bulk-selected-b-${transport}`,
    tags: ['selected'],
  });
  await engine.start('hold', null, {
    id: `track8-bulk-other-${transport}`,
    tags: ['other'],
  });

  await Promise.all([
    waitForStatus(engine, `track8-bulk-selected-a-${transport}`, 'running'),
    waitForStatus(engine, `track8-bulk-selected-b-${transport}`, 'running'),
    waitForStatus(engine, `track8-bulk-other-${transport}`, 'running'),
  ]);

  const server = serve({ engine, port: 0 });
  servers.push(server);

  let result: unknown;
  switch (transport) {
    case 'rest': {
      const response = await fetch(`${server.url}/v1/workflows/bulk/cancel`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ filter: { tags: ['selected'] } }),
      });
      expect(response.status).toBe(200);
      result = await response.json();
      break;
    }
    case 'json-rpc-http':
      result = await postJsonRpc(server, 'weft.workflows.bulk.cancel', {
        tags: ['selected'],
      });
      break;
    case 'json-rpc-websocket': {
      const webSocket = await openWebSocket(`${server.url.replace('http://', 'ws://')}/jsonrpc`);
      try {
        const messagePromise = waitForMessage(
          webSocket,
          (parsed) =>
            typeof parsed === 'object' &&
            parsed !== null &&
            (parsed as { id?: string }).id === 'track8-bulk-cancel',
        );
        webSocket.send(
          JSON.stringify({
            jsonrpc: '2.0',
            id: 'track8-bulk-cancel',
            method: 'weft.workflows.bulk.cancel',
            params: { tags: ['selected'] },
          }),
        );
        const response = (await messagePromise) as { error?: unknown; result?: unknown };
        expect(response.error).toBeUndefined();
        result = response.result;
      } finally {
        webSocket.close();
      }
      break;
    }
    case 'json-rpc-stdio':
      result = await invokeStdioJsonRpc(engine, 'weft.workflows.bulk.cancel', {
        tags: ['selected'],
      });
      break;
  }

  return { callCount, result };
}

describe('cross-transport parity', () => {
  const servers: WeftServer[] = [];
  const engines: Engine[] = [];

  afterEach(async () => {
    while (servers.length > 0) {
      await servers.pop()?.stop();
    }
    while (engines.length > 0) {
      engines.pop()?.[Symbol.dispose]();
    }
  });

  it('REST and JSON-RPC requests dispatch into the same Engine methods', async () => {
    const invariants: ParityInvariants = {
      successPayload: 'identical-json',
      errorMapping: 'one-to-one',
      authBehavior: 'identical',
      sideEffects: 'invoked-once-per-call',
    };

    const engine = createHoldEngine();
    engines.push(engine);
    const handle = await engine.start('hold', null, { id: 'track8-parity-get' });
    await waitForStatus(engine, handle.id, 'running');

    const server = serve({ engine, port: 0 });
    servers.push(server);

    const results = await invokeGetAcrossTransports(engine, server, handle.id);
    assertSuccessParity(results, invariants, 'weft.workflows.get');
  });

  it('REST and JSON-RPC share one engine-error mapping layer', async () => {
    const engine = createHoldEngine();
    engines.push(engine);

    const server = serve({ engine, port: 0 });
    servers.push(server);

    const workflowId = 'nonexistent-workflow-id';

    const restResponse = await fetch(`${server.url}/v1/workflows/${workflowId}`);
    expect(restResponse.status).toBe(404);
    await restResponse.json();

    const jsonRpcHttpResponse = await fetch(`${server.url}/jsonrpc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'track8-not-found-http',
        method: 'weft.workflows.get',
        params: { workflowId },
      }),
    });
    expect(jsonRpcHttpResponse.status).toBe(200);
    const jsonRpcHttpBody = (await jsonRpcHttpResponse.json()) as {
      error?: { code?: number; data?: Record<string, unknown> };
    };
    expect(jsonRpcHttpBody.error).toBeDefined();
    expect(jsonRpcHttpBody.error?.data?.['weftCode']).toBe('NotFound');

    const webSocket = await openWebSocket(`${server.url.replace('http://', 'ws://')}/jsonrpc`);
    try {
      const messagePromise = waitForMessage(
        webSocket,
        (parsed) =>
          typeof parsed === 'object' &&
          parsed !== null &&
          (parsed as { id?: string }).id === 'track8-not-found-websocket',
      );
      webSocket.send(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 'track8-not-found-websocket',
          method: 'weft.workflows.get',
          params: { workflowId },
        }),
      );
      const webSocketBody = (await messagePromise) as {
        error?: { code?: number; data?: Record<string, unknown> };
      };
      expect(webSocketBody.error).toBeDefined();
      expect(webSocketBody.error?.data?.['weftCode']).toBe('NotFound');

      const stdioError = await invokeStdioJsonRpcExpectError(engine, 'weft.workflows.get', {
        workflowId,
      });
      expect(stdioError.data?.['weftCode']).toBe('NotFound');

      assertIdenticalFaultCode(
        String(jsonRpcHttpBody.error?.code),
        String(webSocketBody.error?.code),
        'weft.workflows.get NotFound: json-rpc-http vs json-rpc-websocket',
      );
      assertIdenticalFaultCode(
        String(jsonRpcHttpBody.error?.code),
        String(stdioError.code),
        'weft.workflows.get NotFound: json-rpc-http vs json-rpc-stdio',
      );
    } finally {
      webSocket.close();
    }
  });

  it('keeps weft.workflows.signal parity across REST, JSON-RPC HTTP, JSON-RPC WebSocket, and JSON-RPC stdio', async () => {
    const invariants: ParityInvariants = {
      successPayload: 'identical-json',
      errorMapping: 'one-to-one',
      authBehavior: 'identical',
      sideEffects: 'invoked-once-per-call',
    };

    const results = {
      rest: await invokeSignalTransport('rest', servers, engines),
      'json-rpc-http': await invokeSignalTransport('json-rpc-http', servers, engines),
      'json-rpc-websocket': await invokeSignalTransport('json-rpc-websocket', servers, engines),
      'json-rpc-stdio': await invokeSignalTransport('json-rpc-stdio', servers, engines),
    };

    assertSuccessParity(
      {
        rest: results.rest.result,
        'json-rpc-http': results['json-rpc-http'].result,
        'json-rpc-websocket': results['json-rpc-websocket'].result,
        'json-rpc-stdio': results['json-rpc-stdio'].result,
      },
      invariants,
      'weft.workflows.signal',
    );

    for (const outcome of Object.values(results)) {
      expect(outcome.callCount).toBe(1);
      expect(outcome.workflowResult).toBe('released');
      expect(outcome.result).toEqual({ ok: true });
    }
  });

  it('keeps weft.workflows.start parity across REST, JSON-RPC HTTP, JSON-RPC WebSocket, and JSON-RPC stdio', async () => {
    const invariants: ParityInvariants = {
      successPayload: 'shape-equivalent',
      errorMapping: 'one-to-one',
      authBehavior: 'identical',
      sideEffects: 'invoked-once-per-call',
    };

    const results = {
      rest: await invokeStartTransport('rest', servers, engines),
      'json-rpc-http': await invokeStartTransport('json-rpc-http', servers, engines),
      'json-rpc-websocket': await invokeStartTransport('json-rpc-websocket', servers, engines),
      'json-rpc-stdio': await invokeStartTransport('json-rpc-stdio', servers, engines),
    };

    assertSuccessParity(
      {
        rest: results.rest.result,
        'json-rpc-http': results['json-rpc-http'].result,
        'json-rpc-websocket': results['json-rpc-websocket'].result,
        'json-rpc-stdio': results['json-rpc-stdio'].result,
      },
      invariants,
      'weft.workflows.start',
    );

    for (const outcome of Object.values(results)) {
      expect(outcome.callCount).toBe(1);
      expect((outcome.state as { id?: string }).id).toBe((outcome.result as { id?: string }).id);
    }
  });

  it('keeps weft.workflows.bulk.cancel parity across REST, JSON-RPC HTTP, JSON-RPC WebSocket, and JSON-RPC stdio', async () => {
    const invariants: ParityInvariants = {
      successPayload: 'shape-equivalent',
      errorMapping: 'one-to-one',
      authBehavior: 'identical',
      sideEffects: 'invoked-once-per-call',
    };

    const results = {
      rest: await invokeBulkCancelTransport('rest', servers, engines),
      'json-rpc-http': await invokeBulkCancelTransport('json-rpc-http', servers, engines),
      'json-rpc-websocket': await invokeBulkCancelTransport('json-rpc-websocket', servers, engines),
      'json-rpc-stdio': await invokeBulkCancelTransport('json-rpc-stdio', servers, engines),
    };

    assertSuccessParity(
      {
        rest: results.rest.result,
        'json-rpc-http': results['json-rpc-http'].result,
        'json-rpc-websocket': results['json-rpc-websocket'].result,
        'json-rpc-stdio': results['json-rpc-stdio'].result,
      },
      invariants,
      'weft.workflows.bulk.cancel',
    );

    for (const outcome of Object.values(results)) {
      expect(outcome.callCount).toBe(1);
      expect((outcome.result as { cancelled?: number }).cancelled).toBe(2);
    }
  });
});
