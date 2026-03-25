/**
 * Bun.serve() wrapper with WebSocket support and clean shutdown.
 *
 * @module server
 */

import type { Engine } from '../core/engine.ts';
import { handleRequest } from './handler.ts';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ServeOptions {
  engine: Engine;
  port?: number;
  hostname?: string;
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
// Implementation
// ---------------------------------------------------------------------------

/** Start the Weft HTTP + WebSocket server. */
export function serve(options: ServeOptions): WeftServer {
  const port = options.port ?? 7233;
  const hostname = options.hostname ?? '0.0.0.0';

  const server = Bun.serve<WebSocketData>({
    port,
    hostname,
    async fetch(request) {
      const url = new URL(request.url);

      if (request.headers.get('upgrade') === 'websocket') {
        // WebSocket routes:
        // /v1/workflows/:id/watch  — workflow observation
        // /v1/workflows/:id/stream — token streaming
        // /v1/tasks/:queue/stream  — worker task stream
        const upgraded = server.upgrade(request, { data: { pathname: url.pathname } });
        if (upgraded) return undefined;
        return new Response('WebSocket upgrade failed', { status: 400 });
      }

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
        // Handle incoming WebSocket messages
      },
      close(_ws) {
        // Cleanup subscriptions
      },
    },
  });

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
