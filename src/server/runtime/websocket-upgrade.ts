import type { AuthContext } from '../authentication.ts';
import { authContextToPrincipal } from '../handler.ts';
import type { ServeOptions } from '../index.ts';
import { finalizeWebSocketUpgrade } from '../json-rpc-transport-helpers.ts';
import type { WebSocketData } from '../json-rpc-websocket-runtime.ts';
import { parseOptionalSequenceCursor } from '../sequence-cursor.ts';
import type { ServerContext } from './context.ts';
import { isOriginAllowed } from './cors.ts';

export const WORKER_STREAM_RE = /^\/v1\/tasks\/([\w-]+)\/stream$/;

const WORKFLOW_STREAM_RE = /^\/v1\/workflows\/([^/]+)\/stream$/;
const WORKFLOW_WATCH_RE = /^\/v1\/workflows\/([^/]+)\/watch$/;

function tryDecodePathComponent(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

/**
 * Match a URL pathname against a route regex and decode the first capture group.
 * Returns the decoded value, null if decoding fails, or undefined if the path
 * does not match.
 */
function matchUpgradePath(pathname: string, pattern: RegExp): string | null | undefined {
  const match = pattern.exec(pathname);
  if (!match?.[1]) return undefined;
  return tryDecodePathComponent(match[1]);
}

/** Classify a WebSocket request URL and extract relevant parameters. */
export function classifyConnection(
  url: URL,
): Pick<WebSocketData, 'connectionType' | 'workflowId' | 'queue'> | null {
  const { pathname } = url;

  const workflowStreamId = matchUpgradePath(pathname, WORKFLOW_STREAM_RE);
  if (workflowStreamId !== undefined) {
    return workflowStreamId === null
      ? null
      : { connectionType: 'stream', workflowId: workflowStreamId };
  }

  const workflowWatchId = matchUpgradePath(pathname, WORKFLOW_WATCH_RE);
  if (workflowWatchId !== undefined) {
    return workflowWatchId === null
      ? null
      : { connectionType: 'watch', workflowId: workflowWatchId };
  }

  const queue = matchUpgradePath(pathname, WORKER_STREAM_RE);
  if (queue !== undefined) {
    return queue === null ? null : { connectionType: 'worker', queue };
  }

  if (pathname === '/jsonrpc') {
    return { connectionType: 'jsonrpc' };
  }

  return { connectionType: 'generic' };
}

/**
 * Whether a WebSocket upgrade must be refused on origin grounds. CORS does not
 * govern the WebSocket handshake — the browser sends `Origin` but does not
 * enforce the server's CORS headers — so when a CORS policy is configured we
 * reject cross-origin upgrades from disallowed origins ourselves, before
 * `server.upgrade()`. A missing `Origin` (native clients, server-to-server) is
 * allowed; only a present-and-disallowed origin is a cross-origin browser
 * upgrade we refuse.
 */
function rejectsCrossOriginUpgrade(context: ServerContext, request: Request): boolean {
  const origin = request.headers.get('origin');
  return (
    context.corsPolicy !== null && origin !== null && !isOriginAllowed(context.corsPolicy, origin)
  );
}

/**
 * Resolve the connection principal for connection types that make post-upgrade
 * authorization decisions. Stream/watch sockets are one-way transports and do
 * not consume a principal. Returns `null` to signal a 401 response should be
 * sent, or `undefined` when no principal is needed for this connection type.
 */
function resolvePrincipal(
  connectionType: WebSocketData['connectionType'] | undefined,
  authContext: AuthContext | undefined,
): WebSocketData['principal'] | null | undefined {
  if (connectionType !== 'jsonrpc' && connectionType !== 'worker') return undefined;
  if (authContext === undefined) return undefined;
  try {
    return authContextToPrincipal(authContext);
  } catch (error) {
    console.error('[weft] WebSocket upgrade principal resolution failed', error);
    return null;
  }
}

export function handleWebSocketUpgrade(
  server: ReturnType<typeof Bun.serve>,
  context: ServerContext,
  options: ServeOptions,
  request: Request,
  url: URL,
  authContext?: AuthContext,
): Response | undefined | null {
  void options;

  if (request.headers.get('upgrade') !== 'websocket') {
    return null;
  }

  if (rejectsCrossOriginUpgrade(context, request)) {
    return new Response('Cross-origin WebSocket upgrade not allowed', { status: 403 });
  }

  const classification = classifyConnection(url);
  if (classification === null) {
    return new Response('Invalid encoded WebSocket path', { status: 400 });
  }

  const principal = resolvePrincipal(classification.connectionType, authContext);
  if (principal === null) {
    return new Response('Authentication context invalid', { status: 401 });
  }

  const resumeFromParam = url.searchParams.get('resumeFrom');
  const resumeFromResult = parseOptionalSequenceCursor(
    resumeFromParam,
    'resumeFrom query parameter',
  );
  if (resumeFromResult.error) {
    return new Response(resumeFromResult.error, { status: 400 });
  }
  const resumeFrom = resumeFromResult.value;

  return finalizeWebSocketUpgrade(server, request, {
    pathname: url.pathname,
    ...classification,
    ...(principal ? { principal } : {}),
    ...(resumeFrom !== undefined ? { resumeFrom } : {}),
  });
}
