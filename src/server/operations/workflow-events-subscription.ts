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
 *
 * **Security model.** Subscriptions are capability grants for the lifetime
 * of the WebSocket session: the catalog access policy is checked once at
 * subscribe time, and once granted the subscription continues delivering
 * events until the client unsubscribes, the socket closes, or the feed
 * terminates. There is no per-event re-authorization in v1, so a token's
 * scope must be revoked AT THE SOCKET LEVEL (close + reconnect) to stop
 * event delivery — token revocation alone does not terminate active
 * subscriptions. This is documented as a known v1 constraint; per-event
 * filtering is a planned future refinement.
 *
 * Access is scoped to `workflows:read` rather than `public` to prevent
 * unauthenticated callers from observing event streams of arbitrary
 * workflows. Operators that need looser access can override the registry
 * with a custom operation definition.
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
  // optionalAuth: matches the project's default-no-auth ergonomics for
  // unauthenticated callers (so `serve({ engine })` keeps the live event
  // surface usable in dev) while requiring `workflows:read` once a caller
  // authenticates. Operators that need stricter behavior should configure
  // `serve({ auth: ... })` and rely on the authentication layer rejecting
  // the connection entirely; this access policy then enforces the
  // workflows:read scope on the resulting authenticated principal.
  access: {
    kind: 'optionalAuth',
    authenticatedScopes: { kind: 'anyOf', scopes: ['workflows:read'] },
  },
  // optionalAuth is not public; explicitly mark this operation as
  // discoverable so /openapi.json, /openrpc.json, and /asyncapi.json all
  // include it. Without this flag the discovery filter hides the
  // operation, which would break clients that introspect the API surface.
  discoverable: true,
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
