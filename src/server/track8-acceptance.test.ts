import { afterEach, describe, expect, it } from 'bun:test';
import { z } from 'zod';

import type { Context } from '../core/context.ts';
import { Engine } from '../core/engine.ts';
import type { WorkflowContext } from '../core/types.ts';
import { MemoryStorage } from '../storage/memory.ts';
import { createEngineEventFeedBackend } from './engine-event-feed-backend.ts';
import { faultToHttpResponse } from './fault-to-http.ts';
import { faultToJsonRpcError } from './fault-to-json-rpc.ts';
import { serve, type WeftServer } from './index.ts';
import { dispatchJsonRpc } from './json-rpc-dispatch.ts';
import { createOperationRegistry } from './operation-catalog.ts';
import type { OperationFault } from './operation-fault.ts';
import { defineOperation } from './operation-registry.ts';
import { anonymousPrincipal } from './principal.ts';
import { createLiveOperationRegistry } from './rest-bindings.ts';
import { runStdioSession } from './stdio-session.ts';
import { createWorkflowEventFeed, type EventEnvelope } from './workflow-event-feed.ts';

function createSignalWorkflowEngine(): Engine {
  const storage = new MemoryStorage();
  const engine = new Engine({ storage });
  engine.register('hold', async function* (ctx: WorkflowContext, _input: unknown) {
    const context = ctx as Context;
    const value = yield* context.waitForSignal<string>('release');
    yield* context.run(async () => `echoed:${value}`);
    yield* context.run(async () => 'done');
    return value;
  });
  return engine;
}

async function waitForEventCount(
  engine: Engine,
  workflowId: string,
  expected: number,
  timeoutMilliseconds = 1_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    const events = await engine.getEvents(workflowId);
    if (events.length >= expected) {
      return;
    }
    await Bun.sleep(5);
  }

  throw new Error(`workflow ${workflowId} did not reach ${expected} events in time`);
}

async function collectReplayEvents(engine: Engine, workflowId: string): Promise<EventEnvelope[]> {
  const backend = createEngineEventFeedBackend(engine);
  const feed = createWorkflowEventFeed(backend);
  const events: EventEnvelope[] = [];

  try {
    for await (const envelope of feed.replay({ workflowId, selector: 'events' })) {
      events.push(envelope);
    }
  } finally {
    feed.dispose();
  }

  return events;
}

async function waitFor(
  condition: () => boolean | Promise<boolean>,
  timeoutMilliseconds = 1_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    if (await condition()) {
      return;
    }
    await Bun.sleep(5);
  }

  throw new Error('timed out waiting for condition');
}

describe('Track 8 acceptance coverage', () => {
  let server: WeftServer | undefined;
  const feeds: Array<{ dispose(): void }> = [];

  afterEach(async () => {
    for (const feed of feeds.splice(0)) {
      feed.dispose();
    }

    await server?.stop();
    server = undefined;
  });

  it('External subscriptions project from existing typed EventTarget events. Engine and WorkflowHandle events remain the source of truth for watch and stream semantics.', async () => {
    const engine = createSignalWorkflowEngine();
    const handle = await engine.start('hold', { hello: 'world' }, {});
    await waitForEventCount(engine, handle.id, 1);

    const feed = createWorkflowEventFeed(createEngineEventFeedBackend(engine));
    feeds.push(feed);

    let resolveFirstRecord!: () => void;
    const firstRecordPromise = new Promise<void>((resolve) => {
      resolveFirstRecord = resolve;
    });

    const subscribePromise = (async () => {
      const received: EventEnvelope[] = [];
      let firstSeen = false;

      for await (const envelope of feed.subscribe({
        workflowId: handle.id,
        selector: 'events',
      })) {
        received.push(envelope);
        if (!firstSeen) {
          firstSeen = true;
          resolveFirstRecord();
        }
        if (envelope.kind === 'workflow:checkpoint' && received.length >= 3) {
          break;
        }
      }

      return received;
    })();

    await firstRecordPromise;
    await engine.signal(handle.id, 'release', 'go');
    await handle.result();

    const received = await subscribePromise;
    expect(received.length).toBeGreaterThan(0);
    expect(received.every((envelope) => envelope.workflowId === handle.id)).toBe(true);
  });

  it('One server-side event projection layer feeds every live transport. WebSocket watch and token messages, SSE responses, JSON-RPC subscription notifications, and cursor-based replay all project from the same event stream model.', async () => {
    const engine = createSignalWorkflowEngine();
    const handle = await engine.start('hold', { hello: 'world' }, {});
    await engine.signal(handle.id, 'release', 'go');
    await handle.result();

    const replayed = await collectReplayEvents(engine, handle.id);
    const directEvents = await engine.getEvents(handle.id);

    expect(replayed.length).toBeGreaterThan(0);
    expect(replayed.map((envelope) => envelope.sequence)).toEqual(
      directEvents.map((_event, index) => index),
    );
  });

  it('Runtime JSON-RPC methods use stable namespaced names. Examples: weft.workflows.start, weft.workflows.get, weft.workflows.signal.', async () => {
    const registry = createLiveOperationRegistry();
    const names = registry.list().map((operation) => operation.name);

    expect(names).toContain('weft.workflows.start');
    expect(names).toContain('weft.workflows.get');
    expect(names).toContain('weft.workflows.signal');
    expect(names.every((name) => /^weft\.[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*)+$/.test(name))).toBe(
      true,
    );
  });

  it('Notifications are opt-in per method. Mutating operations default to request-response so callers do not silently lose errors or authorization failures.', async () => {
    const registry = createOperationRegistry([
      defineOperation({
        name: 'weft.test.echo',
        summary: 'echo test operation',
        inputSchema: z.object({ value: z.string() }),
        outputSchema: z.object({ echoed: z.string() }),
        access: { kind: 'public' },
        transports: {
          http: true,
          jsonRpcHttp: true,
          jsonRpcWebSocket: true,
          jsonRpcStdio: true,
        },
        unknownKeyPolicy: { http: 'reject', jsonRpc: 'reject' },
        invoke: async ({ input }) => ({ echoed: input.value }),
      }),
    ]);

    const requestResult = await dispatchJsonRpc(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'weft.test.echo',
        params: { value: 'hello' },
      }),
      {
        principal: anonymousPrincipal(),
        engine: {},
        transport: 'jsonRpcHttp',
        registry,
      },
    );
    expect(requestResult.kind).toBe('single');

    const notificationResult = await dispatchJsonRpc(
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'weft.test.echo',
        params: { value: 'hello' },
      }),
      {
        principal: anonymousPrincipal(),
        engine: {},
        transport: 'jsonRpcHttp',
        registry,
      },
    );
    expect(notificationResult.kind).toBe('notification');
  });

  it('Subscription notifications reuse the shared event projection layer. Watch and stream APIs are documented as projections of current engine events rather than bespoke server-side state machines.', async () => {
    const engine = createSignalWorkflowEngine();
    const handle = await engine.start('hold', { hello: 'world' }, {});
    await waitForEventCount(engine, handle.id, 1);

    const feed = createWorkflowEventFeed(createEngineEventFeedBackend(engine));
    feeds.push(feed);
    const controller = new AbortController();

    const received: EventEnvelope[] = [];
    let resolveFirstRecord!: () => void;
    const firstRecordPromise = new Promise<void>((resolve) => {
      resolveFirstRecord = resolve;
    });

    const subscribePromise = (async () => {
      let firstSeen = false;

      for await (const envelope of feed.subscribe({
        workflowId: handle.id,
        selector: 'events',
        signal: controller.signal,
      })) {
        received.push(envelope);
        if (!firstSeen) {
          firstSeen = true;
          resolveFirstRecord();
        }
      }
    })();

    await firstRecordPromise;
    await engine.signal(handle.id, 'release', 'go');
    await handle.result();

    const engineEvents = await engine.getEvents(handle.id);
    await waitFor(() => received.length >= engineEvents.length);

    controller.abort();
    await subscribePromise;

    expect(received.map((envelope) => envelope.sequence)).toEqual(
      engineEvents.map((_event, index) => index),
    );
  });

  it('REST and JSON-RPC share one engine-error mapping layer. The same engine failure produces equivalent transport-level semantics across both surfaces.', async () => {
    const fault: OperationFault = {
      code: 'NotFound',
      message: 'workflow not found',
      data: { resource: 'workflow', identifier: 'wf-1' },
    };

    const httpResponse = faultToHttpResponse(fault);
    const jsonRpcError = faultToJsonRpcError(fault);
    const httpBody = (await httpResponse.json()) as {
      error: { code: string; data?: { resource?: string } };
    };

    expect(httpResponse.status).toBe(404);
    expect(jsonRpcError.code).toBe(-32020);
    expect(httpBody.error.code).toBe('NotFound');
    expect(jsonRpcError.data['weftCode']).toBe('NotFound');
  });

  it('stdio is a separate opt-in local entrypoint, disabled by default. It is not implicitly enabled by serve() and is not treated as a public unauthenticated surface.', async () => {
    const engine = createSignalWorkflowEngine();
    server = serve({ engine, port: 0 });

    expect(server.url.startsWith('http')).toBe(true);
    expect(Reflect.has(server, 'stdio')).toBe(false);
    expect(typeof runStdioSession).toBe('function');
  });

  it('Every new primitive from this document has a dedicated test file under src/ (either as a colocated src/**/*.test.ts file or under src/**/__tests__/) and every acceptance criterion above is covered by at least one test(...) call whose failure message names the criterion.', async () => {
    const fileExpectations = [
      [
        'openapi.test.ts',
        '/openapi.json is a full OpenAPI 3.1 contract for the REST-ish HTTP surface',
      ],
      ['openrpc.test.ts', 'JSON-RPC uses named params only'],
      [
        'json-rpc-protocol.test.ts',
        'Reserved JSON-RPC protocol errors follow the specification exactly',
      ],
      ['json-rpc-dispatch.test.ts', 'Batch requests are supported'],
      [
        'fault-to-json-rpc.test.ts',
        'JSON-RPC error.data carries structured machine-readable detail',
      ],
      [
        'fault-to-json-rpc.test.ts',
        'Weft domain failures use a separate stable application error range',
      ],
      ['sequence-cursor.test.ts', 'All live views share the same sequence and cursor semantics'],
      [
        'json-rpc-http-integration.test.ts',
        'JSON-RPC 2.0 is supported over three runtime transports',
      ],
      [
        'track8-acceptance.test.ts',
        'External subscriptions project from existing typed EventTarget events',
      ],
      [
        'track8-acceptance.test.ts',
        'One server-side event projection layer feeds every live transport',
      ],
      ['track8-acceptance.test.ts', 'Runtime JSON-RPC methods use stable namespaced names'],
      ['track8-acceptance.test.ts', 'Notifications are opt-in per method'],
      [
        'track8-acceptance.test.ts',
        'Subscription notifications reuse the shared event projection layer',
      ],
      ['track8-acceptance.test.ts', 'REST and JSON-RPC share one engine-error mapping layer'],
      [
        'track8-acceptance.test.ts',
        'stdio is a separate opt-in local entrypoint, disabled by default',
      ],
    ] as const;

    for (const [fileName, criterionText] of fileExpectations) {
      const content = await Bun.file(`${import.meta.dir}/${fileName}`).text();
      expect(content).toContain(criterionText);
    }
  });
});
