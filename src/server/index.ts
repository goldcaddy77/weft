/**
 * Bun.serve() wrapper with WebSocket support, dashboard UI, and clean shutdown.
 *
 * @module server
 */

import { encode } from '../core/codec.ts';
import type { Engine } from '../core/engine.ts';
import {
  ActivityCompletedEvent,
  ActivityFailedEvent,
  ActivityStartedEvent,
  AttributesChangedEvent,
  SignalDeliveredEvent,
  SignalReceivedEvent,
  TokenEvent,
  UpdateCompletedEvent,
  UpdateReceivedEvent,
  WorkflowCancelledEvent,
  WorkflowCompletedEvent,
  WorkflowFailedEvent,
  WorkflowStartedEvent,
  WorkflowTimedOutEvent,
} from '../core/events.ts';
import { KEYS } from '../storage/interface.ts';
import { handleRequest } from './handler.ts';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ServeOptions {
  engine: Engine;
  port?: number;
  hostname?: string;
  /** Enable Bun's development mode (HMR, source maps, detailed errors). */
  development?: boolean;
  /** Dashboard HTML import for Bun's static route handler (e.g., `import dashboard from './index.html'`). */
  dashboard?: unknown;
}

export interface WeftServer extends Disposable {
  readonly port: number;
  readonly hostname: string;
  readonly url: string;
  stop(): void;
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface WebSocketData {
  pathname: string;
}

// ---------------------------------------------------------------------------
// WebSocket event broadcasting
// ---------------------------------------------------------------------------

/**
 * Serialize an engine event to a JSON message for WebSocket clients.
 *
 * The wire format matches the dashboard's `WorkflowEvent` interface:
 * `{ type: string; timestamp: number; data: Record<string, unknown> }`.
 */
function serializeEvent(event: Event): string | null {
  const data: Record<string, unknown> = {};

  // Extract all public properties from the event into the nested data bag
  for (const key of Object.keys(event)) {
    if (key === 'type') continue;
    const value = (event as unknown as Record<string, unknown>)[key];
    // Serialize Error objects to plain strings
    if (value instanceof Error) {
      data[key] = value.message;
    } else {
      data[key] = value;
    }
  }

  const message: { type: string; timestamp: number; data: Record<string, unknown> } = {
    type: event.type,
    timestamp: Date.now(),
    data,
  };

  return JSON.stringify(message);
}

/**
 * Attach event listeners to the engine that broadcast events via WebSocket
 * and persist each event to storage so GET /v1/workflows/:id/events returns data.
 * Returns a cleanup function that removes all listeners.
 */
function wireEventBroadcasting(engine: Engine, server: ReturnType<typeof Bun.serve>): () => void {
  const controller = new AbortController();
  const { signal } = controller;

  /**
   * Per-workflow monotonic sequence counter for event storage keys.
   *
   * On first access for a given workflow, the counter is initialized from
   * storage by scanning for the highest existing event key. This prevents
   * sequence numbers from resetting to 0 after a server restart, which would
   * silently overwrite previously persisted events.
   */
  const sequenceCounters = new Map<string, number>();
  const sequenceInitPromises = new Map<string, Promise<void>>();

  /** Ensure the sequence counter for a workflow is seeded from storage. */
  function ensureSequenceInitialized(workflowId: string): Promise<void> {
    const existing = sequenceInitPromises.get(workflowId);
    if (existing) return existing;

    const promise = (async () => {
      const prefix = `ev:${workflowId}:`;
      let highestSequence = -1;

      for await (const [key] of engine.storage.scan(prefix, { reverse: true, limit: 1 })) {
        // Key format: ev:{workflowId}:{zero-padded sequence}
        const parts = key.split(':');
        const sequencePart = parts[parts.length - 1];
        if (sequencePart !== undefined) {
          highestSequence = parseInt(sequencePart, 10);
        }
      }

      // Start after the highest existing sequence number.
      sequenceCounters.set(workflowId, highestSequence + 1);
    })();

    sequenceInitPromises.set(workflowId, promise);
    return promise;
  }

  function nextSequence(workflowId: string): number {
    const current = sequenceCounters.get(workflowId);
    if (current === undefined) {
      throw new Error(
        `Sequence counter for workflow "${workflowId}" accessed before initialization`,
      );
    }
    sequenceCounters.set(workflowId, current + 1);
    return current;
  }

  const eventTypes = [
    WorkflowStartedEvent.type,
    WorkflowCompletedEvent.type,
    WorkflowFailedEvent.type,
    WorkflowCancelledEvent.type,
    WorkflowTimedOutEvent.type,
    ActivityStartedEvent.type,
    ActivityCompletedEvent.type,
    ActivityFailedEvent.type,
    TokenEvent.type,
    SignalReceivedEvent.type,
    SignalDeliveredEvent.type,
    AttributesChangedEvent.type,
    UpdateReceivedEvent.type,
    UpdateCompletedEvent.type,
  ] as const;

  for (const eventType of eventTypes) {
    engine.addEventListener(
      eventType,
      (event) => {
        const workflowId =
          'workflowId' in event &&
          typeof (event as Record<string, unknown>)['workflowId'] === 'string'
            ? ((event as Record<string, unknown>)['workflowId'] as string)
            : undefined;
        if (workflowId === undefined) return;

        const message = serializeEvent(event);
        if (message === null) return;

        // Persist the event to storage for the REST events endpoint.
        // Sequence initialization is async (reads storage on first access per
        // workflow), so chain the persistence behind it. WebSocket publishing
        // is deferred until persistence succeeds so clients never see events
        // that failed to store.
        void (async () => {
          try {
            await ensureSequenceInitialized(workflowId);

            const parsed = JSON.parse(message) as {
              type: string;
              timestamp: number;
              data: Record<string, unknown>;
            };
            const sequence = nextSequence(workflowId);
            const storageKey = KEYS.event(workflowId, sequence);
            await engine.storage.put(storageKey, encode(parsed));

            // Publish to the workflow's watch channel
            const watchChannel = `/v1/workflows/${workflowId}/watch`;
            server.publish(watchChannel, message);

            // For token events, also publish to the stream channel
            if (eventType === TokenEvent.type) {
              const streamChannel = `/v1/workflows/${workflowId}/stream`;
              server.publish(streamChannel, message);
            }
          } catch (error) {
            console.error(
              `[weft] Failed to persist event "${eventType}" for workflow "${workflowId}":`,
              error,
            );
          }
        })();
      },
      { signal },
    );
  }

  return () => controller.abort();
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/** Start the Weft HTTP + WebSocket server with embedded dashboard. */
export function serve(options: ServeOptions): WeftServer {
  const port = options.port ?? 7233;
  const hostname = options.hostname ?? '0.0.0.0';
  const development = options.development ?? false;

  // The dashboard HTML is passed in via options or loaded dynamically.
  // When available, Bun's static route handler bundles and serves it
  // with HMR in dev mode and cached assets in production mode.
  const dashboard = options.dashboard ?? null;

  const routes: Record<string, unknown> = {};
  if (dashboard !== null) {
    routes['/ui'] = dashboard;
    routes['/ui/*'] = dashboard;
  }

  const server = Bun.serve<WebSocketData>({
    port,
    hostname,
    development,
    routes,
    async fetch(request) {
      const url = new URL(request.url);

      // WebSocket upgrade
      if (request.headers.get('upgrade') === 'websocket') {
        const upgraded = server.upgrade(request, { data: { pathname: url.pathname } });
        if (upgraded) return undefined;
        return new Response('WebSocket upgrade failed', { status: 400 });
      }

      // API routes via existing platform-agnostic handler
      return handleRequest(request, options.engine);
    },
    websocket: {
      open(ws) {
        const { pathname } = ws.data;
        if (pathname) {
          ws.subscribe(pathname);
        }
      },
      message(_ws, _message) {
        // Client messages not currently used
      },
      close(_ws) {
        // Subscriptions cleaned up automatically by Bun
      },
    },
  });

  // Wire up engine events → WebSocket broadcasting.
  // Wrap in try/catch so that if anything throws after the server is running,
  // both the server and listeners are cleaned up before the error propagates.
  let cleanupBroadcasting: (() => void) | undefined;
  try {
    cleanupBroadcasting = wireEventBroadcasting(options.engine, server);

    const resolvedPort = server.port ?? port;
    const resolvedHostname = server.hostname ?? hostname;

    return {
      port: resolvedPort,
      hostname: resolvedHostname,
      url: `http://${resolvedHostname}:${resolvedPort}`,
      stop() {
        cleanupBroadcasting!();
        void server.stop();
      },
      [Symbol.dispose]() {
        cleanupBroadcasting!();
        void server.stop();
      },
    };
  } catch (error) {
    cleanupBroadcasting?.();
    void server.stop();
    throw error;
  }
}
