import { z } from 'zod';

import { defineOperation } from '../operation-registry.ts';
import type { Cursor, EventEnvelope, WorkflowEventFeed } from '../workflow-event-feed.ts';

const INITIAL_SUBSCRIPTION_CURSOR: Cursor = '-1';

const workflowEventsSubscriptionInput = z.object({
  workflowId: z.string().min(1),
  selector: z.enum(['events', 'tokens']).optional().default('events'),
  fromCursor: z.string().optional(),
});

const workflowEventsSubscriptionEnvelope = z.object({
  subscriptionId: z.string(),
  cursor: z.string(),
});

export type WorkflowEventsSubscriptionInput = z.infer<typeof workflowEventsSubscriptionInput>;
export type WorkflowEventsSubscriptionEnvelope = z.infer<typeof workflowEventsSubscriptionEnvelope>;

/**
 * Cataloged subscription operation for replay-plus-live workflow events.
 * The WebSocket session owns the lifecycle primitive; this operation owns
 * validation, authorization, and feed wiring.
 */
export const workflowEventsSubscriptionOperation = defineOperation<
  WorkflowEventsSubscriptionInput,
  WorkflowEventsSubscriptionEnvelope
>({
  name: 'weft.workflows.events',
  mcpExposable: false,
  kind: 'subscription',
  summary: 'Subscribe to workflow events with replay-from-cursor',
  tags: ['Events'],
  inputSchema: workflowEventsSubscriptionInput,
  outputSchema: workflowEventsSubscriptionEnvelope,
  eventSchema: z.object({
    kind: z.string(),
    workflowId: z.string(),
    selector: z.enum(['events', 'tokens']),
    sequence: z.number(),
    cursor: z.string(),
    emittedAtMs: z.number(),
    payload: z.unknown(),
  }),
  access: { kind: 'public' },
  transports: { http: false, jsonRpcHttp: false, jsonRpcWebSocket: true, jsonRpcStdio: false },
  unknownKeyPolicy: { http: 'strip', jsonRpc: 'reject' },
  invoke: async ({ input, engine }) => {
    // The WebSocket subscription session is the only caller and passes
    // `{ feed }` as the engine value for this catalog operation.
    const feed = (engine as { feed: WorkflowEventFeed }).feed;
    const controller = new AbortController();
    const startingCursor = input.fromCursor ?? INITIAL_SUBSCRIPTION_CURSOR;
    const iterable: AsyncIterable<EventEnvelope> = feed.subscribe({
      workflowId: input.workflowId,
      selector: input.selector,
      ...(input.fromCursor === undefined ? {} : { fromCursor: input.fromCursor }),
      signal: controller.signal,
    });

    return {
      envelope: { subscriptionId: `sub_${crypto.randomUUID()}`, cursor: startingCursor },
      iterable,
      close: async () => {
        controller.abort();
      },
    };
  },
});
