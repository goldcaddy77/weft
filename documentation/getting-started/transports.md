# Choosing a transport

Weft exposes runtime operations over four transports. They all route through the same operation catalog, so the operation you call and the result you get back are the same regardless of which one you pick. The choice is about what fits your deployment.

## REST (`/v1/*`)

The default. Every cataloged operation has a REST binding with a conventional HTTP method and path. Use REST when:

- You're calling from a language or tool that speaks HTTP fluently
- You want `curl` or Postman to work without any setup
- You're integrating with infrastructure that expects HTTP (load balancers, API gateways, proxies)

Discovery: `GET /openapi.json` returns the full OpenAPI 3.1 contract.

## JSON-RPC over HTTP (`POST /jsonrpc`)

One endpoint, all operations, named by method. Use JSON-RPC HTTP when:

- You want to batch multiple calls into a single round-trip
- You're building a client library and want a uniform dispatch path
- You prefer named params over REST's path/query/body split

A minimal client looks like this:

```ts partial
type JsonRpcError = { code: number; data?: unknown; message: string };
type JsonRpcEnvelope =
  | { error: JsonRpcError; result?: never }
  | { error?: never; result: { id: string } };

function isJsonRpcError(value: unknown): value is JsonRpcError {
  if (typeof value !== 'object' || value === null) return false;
  const error = value as Record<string, unknown>;
  return typeof error['code'] === 'number' && typeof error['message'] === 'string';
}

function isJsonRpcEnvelope(value: unknown): value is JsonRpcEnvelope {
  if (typeof value !== 'object' || value === null) return false;
  const envelope = value as Record<string, unknown>;
  const hasError = 'error' in envelope;
  const hasResult = 'result' in envelope;
  if (hasError === hasResult) return false;
  if (hasError) return isJsonRpcError(envelope['error']);
  return true;
}

const response = await fetch('http://localhost:7233/jsonrpc', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'weft.workflows.start',
    // Named params only — the OpenRPC contract documents paramStructure: "by-name"
    params: { type: 'helloWorld', input: 'Alice' },
  }),
});

const raw = await response.json();
if (!isJsonRpcEnvelope(raw)) {
  throw new Error(`Malformed JSON-RPC response: ${JSON.stringify(raw)}`);
}
const envelope = raw;

if ('error' in envelope) {
  // JSON-RPC errors carry a code (Weft uses the -32000 application range),
  // a message, and structured data with the HTTP-equivalent status.
  console.error('RPC error:', envelope.error);
  process.exit(1);
}

console.log('Started workflow:', envelope.result.id);
```

Discovery: `GET /openrpc.json` returns the OpenRPC 1.3.2 contract. You can also call `rpc.discover` over JSON-RPC itself—it returns the same document.

## JSON-RPC over WebSocket (`WS /jsonrpc`)

Same JSON-RPC protocol, persistent connection. Use WebSocket when:

- You need live event streams or subscription notifications
- You're already using WebSocket for workflow observation and want one connection
- Latency matters—once the socket is established you skip the per-call HTTP request/response cycle

Authentication happens at upgrade time. Every subsequent call on the connection reuses the established principal; you don't re-authenticate per frame.

## JSON-RPC over stdio

Opt-in, disabled by default. Newline-delimited JSON over standard input/output. Use stdio when:

- You're building a local tool or CLI that embeds a Weft engine
- You want the full operation catalog accessible from a subprocess
- You don't want to run an HTTP server

Enable it explicitly in `serve()`—it is not started automatically. Local process boundaries are the default authorization guard; optional startup-token hardening is available for stricter deployments.

## What's not on the parity surface

A few endpoints are intentionally REST-only or unauthenticated:

- `GET /openapi.json` and `GET /openrpc.json` — describe the catalog; mounting them as catalog operations creates a circular self-description
- `GET /v1/health` — anonymous liveness probe for load balancers
- `GET /v1/metrics` — Prometheus exposition format (`text/plain`); the JSON-shaped form is `weft.system.metrics` on the catalog

SSE (`GET /v1/workflows/:id/sse`) is transport-specific—the JSON-RPC analogue is WebSocket subscription notifications.
