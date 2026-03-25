/**
 * Bun.serve() wrapper with WebSocket support, dashboard UI, and clean shutdown.
 *
 * @module server
 */

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

/** Serialize an engine event to a JSON message for WebSocket clients. */
function serializeEvent(event: Event): string | null {
  const data: Record<string, unknown> = { type: event.type };

  // Extract all public properties from the event
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

  return JSON.stringify(data);
}

/** Attach event listeners to the engine that broadcast events via WebSocket. */
function wireEventBroadcasting(engine: Engine, server: ReturnType<typeof Bun.serve>): void {
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
    engine.addEventListener(eventType, (event) => {
      const workflowId = (event as unknown as Record<string, unknown>)['workflowId'] as
        | string
        | undefined;
      if (workflowId === undefined) return;

      const message = serializeEvent(event);
      if (message === null) return;

      // Publish to the workflow's watch channel
      const watchChannel = `/v1/workflows/${workflowId}/watch`;
      server.publish(watchChannel, message);

      // For token events, also publish to the stream channel
      if (eventType === TokenEvent.type) {
        const streamChannel = `/v1/workflows/${workflowId}/stream`;
        server.publish(streamChannel, message);
      }
    });
  }
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

  // Wire up engine events → WebSocket broadcasting
  wireEventBroadcasting(options.engine, server);

  const resolvedPort = server.port ?? port;
  const resolvedHostname = server.hostname ?? hostname;

  return {
    port: resolvedPort,
    hostname: resolvedHostname,
    url: `http://${resolvedHostname}:${resolvedPort}`,
    stop() {
      void server.stop();
    },
    [Symbol.dispose]() {
      void server.stop();
    },
  };
}
