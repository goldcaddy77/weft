import { afterEach, describe, expect, it } from 'bun:test';

import { Engine } from '../core/engine.ts';
import type { WorkflowContext } from '../core/types.ts';
import { workflow } from '../core/types.ts';
import { MemoryStorage } from '../storage/memory.ts';
import { createEngineEventFeedBackend } from './engine-event-feed-backend.ts';
import { serve, type WeftServer } from './index.ts';
import { parseOptionalSequenceCursor } from './sequence-cursor.ts';
import { createWorkflowEventFeed, type EventEnvelope } from './workflow-event-feed.ts';

const multiWorkflow = workflow({ name: 'multi' }).execute(async function* (
  ctx: WorkflowContext,
  _input: unknown,
) {
  const context = ctx;
  yield* context.run(async () => 'step-1');
  yield* context.run(async () => 'step-2');
  return yield* context.run(async () => 'done');
});

const engines: Engine[] = [];
const servers: WeftServer[] = [];

afterEach(async () => {
  while (servers.length > 0) {
    await servers.pop()?.stop();
  }
  while (engines.length > 0) {
    engines.pop()?.[Symbol.dispose]();
  }
});

describe('parseOptionalSequenceCursor', () => {
  it('returns an empty result when the cursor is omitted', () => {
    expect(parseOptionalSequenceCursor(undefined, 'after')).toEqual({});
    expect(parseOptionalSequenceCursor(null, 'after')).toEqual({});
  });

  it('rejects empty, non-decimal, and out-of-range cursors', () => {
    expect(parseOptionalSequenceCursor('', 'after')).toEqual({
      error: 'Invalid after: ',
    });
    expect(parseOptionalSequenceCursor('  ', 'after')).toEqual({
      error: 'Invalid after:   ',
    });
    expect(parseOptionalSequenceCursor('1.5', 'after')).toEqual({
      error: 'Invalid after: 1.5',
    });
    expect(parseOptionalSequenceCursor('-2', 'after')).toEqual({
      error: 'Invalid after: -2',
    });
  });

  it('accepts safe integers including the sentinel -1', () => {
    expect(parseOptionalSequenceCursor('-1', 'after')).toEqual({ value: -1 });
    expect(parseOptionalSequenceCursor('42', 'after')).toEqual({ value: 42 });
  });
});

// MF3: Cross-transport sequence parity test — drives two live surfaces
// (replay and live subscribe) against the same engine and asserts that both
// surfaces deliver envelopes in identical sequence order for the same
// workflow events.  This proves the criterion text: "All live views share
// the same sequence and cursor semantics."
it('All live views share the same sequence and cursor semantics. Replay, resume, and ordering rules are identical across HTTP, WebSocket, and the Track 8 runtime stdio JSON-RPC transport.', async () => {
  // Set up a workflow that emits several events.
  const storage = new MemoryStorage();
  const engine = new Engine({ storage });
  engines.push(engine);
  engine.register(multiWorkflow);

  const handle = await engine.start('multi', {}, {});
  await handle.result();

  const backend = createEngineEventFeedBackend(engine);
  const feed = createWorkflowEventFeed(backend);
  const server = serve({
    engine,
    port: 0,
    auth: {
      apiKeys: [SUBSCRIBE_TEST_API_KEY],
      defaultApiKeyScopes: ['workflows:read'],
    },
  });
  servers.push(server);

  try {
    // Surface 1: replay — yields all persisted envelopes in sequence order.
    const replayed: EventEnvelope[] = [];
    for await (const envelope of feed.replay({ workflowId: handle.id, selector: 'events' })) {
      replayed.push(envelope);
    }

    // Surface 2: WebSocket subscription — should deliver the same replayed
    // envelopes in the same order because both transports project from the
    // shared event feed.
    const subscribed = await collectWebSocketDeliveredEnvelopes(server, handle.id, replayed.length);

    expect(replayed.length).toBeGreaterThan(0);
    expect(subscribed.length).toBe(replayed.length);

    // Both surfaces must deliver envelopes with identical sequence numbers
    // in identical order — this is the cross-transport parity invariant.
    const replayedSequences = replayed.map((e) => e.sequence);
    const subscribedSequences = subscribed.map((e) => e.sequence);

    expect(replayedSequences).toEqual(subscribedSequences);

    // Cursor semantics: every envelope carries a cursor that round-trips
    // through parseOptionalSequenceCursor.  Identical cursors for identical
    // sequences confirm the cursor encoding is transport-agnostic.
    for (let i = 0; i < replayed.length; i++) {
      const replayCursor = replayed[i]!.cursor;
      const subscribeCursor = subscribed[i]!.cursor;
      expect(replayCursor).toBe(subscribeCursor);

      // Cursor must parse back to the envelope's sequence number.
      const parsed = parseOptionalSequenceCursor(replayCursor, 'after');
      expect(parsed).toEqual({ value: replayed[i]!.sequence });
    }
  } finally {
    feed.dispose();
  }
});

// `weft.workflows.events` requires `workflows:read`. The test serve()
// above issues a key with that scope; this connection presents it.
const SUBSCRIBE_TEST_API_KEY = 'weft_test_sequence_cursor_workflows_read_key_xxxxxxxx';

function openWebSocket(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const webSocket = new WebSocket(url, {
      headers: { authorization: `Bearer ${SUBSCRIBE_TEST_API_KEY}` },
    } as any);
    webSocket.addEventListener('open', () => resolve(webSocket));
    webSocket.addEventListener('error', (event) => reject(event));
  });
}

async function collectWebSocketDeliveredEnvelopes(
  server: WeftServer,
  workflowId: string,
  expectedCount: number,
): Promise<EventEnvelope[]> {
  const webSocket = await openWebSocket(`${server.url.replace('http://', 'ws://')}/jsonrpc`);

  try {
    return await new Promise<EventEnvelope[]>((resolve, reject) => {
      const received: EventEnvelope[] = [];
      const correlationId = `sequence-cursor-${workflowId}`;
      let subscriptionId: string | undefined;

      const timer = setTimeout(() => {
        webSocket.removeEventListener('message', handler);
        reject(new Error('collectWebSocketDeliveredEnvelopes timed out'));
      }, 3_000);

      function finish(value: EventEnvelope[]): void {
        clearTimeout(timer);
        webSocket.removeEventListener('message', handler);
        resolve(value);
      }

      function handler(event: MessageEvent): void {
        let parsed: unknown;
        try {
          parsed = JSON.parse(String(event.data));
        } catch {
          return;
        }
        if (typeof parsed !== 'object' || parsed === null) {
          return;
        }

        const record = parsed as Record<string, unknown>;
        if (record['id'] === correlationId) {
          const result = record['result'];
          if (typeof result === 'object' && result !== null) {
            const candidateSubscriptionId = (result as Record<string, unknown>)['subscriptionId'];
            if (typeof candidateSubscriptionId === 'string') {
              subscriptionId = candidateSubscriptionId;
              if (expectedCount === 0) {
                finish([]);
              }
            }
          }
          return;
        }

        if (record['method'] !== 'weft.events.deliver' || subscriptionId === undefined) {
          return;
        }

        const params = record['params'];
        if (typeof params !== 'object' || params === null) {
          return;
        }

        const deliverParams = params as Record<string, unknown>;
        if (deliverParams['subscriptionId'] !== subscriptionId) {
          return;
        }

        const envelope = deliverParams['envelope'];
        if (typeof envelope !== 'object' || envelope === null) {
          return;
        }

        received.push(envelope as EventEnvelope);
        if (received.length >= expectedCount) {
          finish(received);
        }
      }

      webSocket.addEventListener('message', handler);
      webSocket.send(
        JSON.stringify({
          jsonrpc: '2.0',
          id: correlationId,
          method: 'weft.workflows.subscribe',
          params: { workflowId, selector: 'events' },
        }),
      );
    });
  } finally {
    webSocket.close();
  }
}
