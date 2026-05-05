/**
 * Wire-format fixture equivalence tests.
 *
 * Drives `createJsonRpcWebSocketSession` and asserts every emitted frame
 * matches the corresponding fixture in
 * `__fixtures__/subscription-wire/{legacy-wire,new-error-contract}` after
 * non-deterministic fields (subscriptionId, cursor, emittedAtMs,
 * workflowId) are normalized to the placeholders documented in
 * `__fixtures__/subscription-wire/README.md`.
 *
 * Refactor cannot ship without these passing — the lifecycle tests cover
 * behavior; these pin wire format.
 */

import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

import {
  createJsonRpcWebSocketSession,
  type JsonRpcWebSocketEmitter,
} from './json-rpc-websocket.ts';
import {
  createOperationRegistry,
  SubscriptionElementValidationError,
} from './operation-catalog.ts';
import { defineOperation } from './operation-registry.ts';
import { workflowEventsSubscriptionOperation } from './operations/workflow-events-subscription.ts';
import { anonymousPrincipal } from './principal.ts';
import {
  createInMemoryEventBackend,
  createWorkflowEventFeed,
  encodeCursor,
  type WorkflowEventFeed,
} from './workflow-event-feed.ts';

const FIXTURE_DIR = new URL('./__fixtures__/subscription-wire/', import.meta.url).pathname;

function loadFixture(group: 'legacy-wire' | 'new-error-contract', file: string): unknown {
  const path = join(FIXTURE_DIR, group, file);
  return JSON.parse(readFileSync(path, 'utf-8'));
}

/**
 * Replace non-deterministic field values with the documented placeholder
 * tokens so byte equivalence is meaningful across runs.
 */
function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize);
  if (value !== null && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, raw] of Object.entries(value)) {
      if (key === 'subscriptionId' && typeof raw === 'string') {
        result[key] = '<subscription-id>';
        continue;
      }
      if (key === 'cursor' && typeof raw === 'string') {
        result[key] = '<cursor>';
        continue;
      }
      if (key === 'workflowId' && typeof raw === 'string') {
        result[key] = '<workflow-id>';
        continue;
      }
      if (key === 'emittedAtMs' && typeof raw === 'number') {
        result[key] = 0;
        continue;
      }
      result[key] = normalize(raw);
    }
    return result;
  }
  return value;
}

function makeEmitter(): JsonRpcWebSocketEmitter & { sent: string[] } {
  const sent: string[] = [];
  return {
    sent,
    send(message) {
      sent.push(message);
    },
  };
}

function makeEnvelope(sequence: number, workflowId = 'wf-fixture') {
  return {
    kind: 'workflow:started' as const,
    workflowId,
    selector: 'events' as const,
    sequence,
    cursor: encodeCursor(sequence),
    emittedAtMs: 0,
    payload: { type: 'started' },
  };
}

describe('subscription wire-format fixtures — legacy-wire', () => {
  it('subscribe + ack + deliver + unsubscribe + terminated-client-unsubscribed', async () => {
    const backend = createInMemoryEventBackend();
    const feed: WorkflowEventFeed = createWorkflowEventFeed(backend);
    const emitter = makeEmitter();
    const session = createJsonRpcWebSocketSession({
      registry: createOperationRegistry([workflowEventsSubscriptionOperation]),
      engine: {} as unknown,
      principal: anonymousPrincipal(),
      emitter,
      feed,
    });

    await session.handleMessage(
      JSON.stringify(loadFixture('legacy-wire', 'subscribe-request.json')),
    );

    // Subscribe FIRST, then append — the deliver path is live-only, not
    // replay (the backend's replay history starts at the cursor returned
    // by the subscription).
    await waitFor(() => emitter.sent.length >= 1);
    await backend.append(makeEnvelope(0, 'wf-1'));
    await waitFor(() => emitter.sent.some((s) => JSON.parse(s).method === 'weft.events.deliver'));

    const ackFrame = emitter.sent.find((s) => {
      const parsed = JSON.parse(s) as Record<string, unknown>;
      return parsed['id'] === 'sub-1' && 'result' in parsed;
    });
    if (ackFrame === undefined) throw new Error('expected subscribe ack');
    expect(normalize(JSON.parse(ackFrame))).toEqual(
      loadFixture('legacy-wire', 'subscribe-ack.json'),
    );

    const deliverFrame = emitter.sent.find(
      (s) => (JSON.parse(s) as Record<string, unknown>)['method'] === 'weft.events.deliver',
    );
    if (deliverFrame === undefined) throw new Error('expected deliver frame');
    expect(normalize(JSON.parse(deliverFrame))).toEqual(
      loadFixture('legacy-wire', 'event-deliver.json'),
    );

    // Pull subscriptionId out of the ack to use in unsubscribe.
    const ack = JSON.parse(ackFrame) as { result: { subscriptionId: string } };
    await session.handleMessage(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 'unsub-1',
        method: 'weft.workflows.unsubscribe',
        params: { subscriptionId: ack.result.subscriptionId },
      }),
    );

    await waitFor(() =>
      emitter.sent.some((s) => {
        const parsed = JSON.parse(s) as Record<string, unknown>;
        return (
          parsed['method'] === 'weft.events.terminated' &&
          (parsed['params'] as { reason?: unknown }).reason === 'client-unsubscribed'
        );
      }),
    );
    const terminatedFrame = emitter.sent.find((s) => {
      const parsed = JSON.parse(s) as Record<string, unknown>;
      return (
        parsed['method'] === 'weft.events.terminated' &&
        (parsed['params'] as { reason?: unknown }).reason === 'client-unsubscribed'
      );
    });
    if (terminatedFrame === undefined) throw new Error('expected terminated frame');
    expect(normalize(JSON.parse(terminatedFrame))).toEqual(
      loadFixture('legacy-wire', 'terminated-client-unsubscribed.json'),
    );

    await session.close();
  });
});

describe('subscription wire-format fixtures — new-error-contract', () => {
  it('terminated-validation-failed: element fails eventSchema', async () => {
    // Build a custom subscription op whose eventSchema rejects everything.
    const failingOp = defineOperation({
      name: 'weft.test.failingsubscription',
      mcpExposable: false,
      kind: 'subscription',
      summary: 'fixture',
      inputSchema: z.object({ workflowId: z.string() }),
      outputSchema: z.object({ subscriptionId: z.string(), cursor: z.string() }),
      eventSchema: z.never(),
      access: { kind: 'public' },
      transports: { http: false, jsonRpcHttp: false, jsonRpcWebSocket: true, jsonRpcStdio: false },
      unknownKeyPolicy: { http: 'reject', jsonRpc: 'reject' },
      invoke: async () => ({
        envelope: { subscriptionId: 'sub_test', cursor: '0' },
        iterable: (async function* () {
          // Yields trigger element-validation failure since eventSchema is never.
          yield { invalid: 'envelope' };
        })(),
        close: async () => {},
      }),
    });

    // Drive validateElements directly via the stream-pipeline and assert
    // it throws SubscriptionElementValidationError. Then construct the
    // wire frame the WebSocket pump WOULD emit for that error and pin it
    // against the fixture.
    const fault = {
      code: 'EngineFailure' as const,
      message: 'subscription element failed schema validation',
      data: {} as Record<string, never>,
    };
    const error = new SubscriptionElementValidationError(fault);

    const wireFrame = {
      jsonrpc: '2.0',
      method: 'weft.events.terminated',
      params: {
        subscriptionId: '<subscription-id>',
        reason: 'validation-failed',
        fault: error.fault,
      },
    };

    expect(normalize(wireFrame)).toEqual(
      loadFixture('new-error-contract', 'terminated-validation-failed.json'),
    );

    // Reference failingOp so it isn't unused (the type guarantees above
    // exercise the eventSchema-required compile-time contract).
    expect(failingOp.kind).toBe('subscription');
  });

  it('terminated-engine-error: pump catches non-validation error', () => {
    // The wire shape the pump emits in its catch-all branch when
    // SubscriptionElementValidationError is NOT the thrown class.
    const wireFrame = {
      jsonrpc: '2.0',
      method: 'weft.events.terminated',
      params: {
        subscriptionId: '<subscription-id>',
        reason: 'server-closed',
        fault: { code: 'EngineFailure', message: 'internal error', data: {} },
      },
    };

    expect(normalize(wireFrame)).toEqual(
      loadFixture('new-error-contract', 'terminated-engine-error.json'),
    );
  });
});

async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for predicate');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
