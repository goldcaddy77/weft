# Server

You've built your workflows and tested them locally. Now you need to expose them over the network---accept HTTP requests to start workflows, send signals, query status, and stream results over WebSockets. Weft's server module wraps `Bun.serve()` with a complete REST API and WebSocket support.

## Starting the server

The `serve()` function takes an engine and optional network configuration, and returns a `WeftServer` handle.

```typescript
import { Engine } from 'weft';
import { serve } from 'weft/server';

const engine = new Engine({ storage });
engine.register('order', orderWorkflow);

const server = serve({
  engine,
  port: 7233, // default
  hostname: '0.0.0.0', // default
});

console.log(`Weft server listening at ${server.url}`);
```

The `ServeOptions` interface is minimal:

```typescript
interface ServeOptions {
  engine: Engine;
  port?: number; // default: 7233
  hostname?: string; // default: '0.0.0.0'
}
```

## The WeftServer handle

`serve()` returns a `WeftServer` that exposes the resolved port, hostname, URL, and a `stop()` method. It also implements `Disposable`, so you can use it with `using` for automatic cleanup.

```typescript
interface WeftServer extends Disposable {
  readonly port: number;
  readonly hostname: string;
  readonly url: string;
  stop(): void;
}
```

```typescript
{
  using server = serve({ engine });
  // Server is running...
} // Automatically stopped here
```

## REST API endpoints

The server exposes a versioned REST API under `/v1/`. All endpoints return JSON by default, with content negotiation for MessagePack (`Accept: application/msgpack`).

**Health check:**

```
GET /v1/health
→ { "status": "ok" }
```

**Start a workflow:**

```
POST /v1/workflows
{ "type": "order", "input": { ... }, "id": "custom-id", "executionTimeout": "24h" }
→ 201 { "id": "workflow-id" }
```

The `id` and `executionTimeout` fields are optional. If `id` is omitted, one is generated. Starting a workflow with a duplicate ID returns `409 Conflict`.

**List workflows:**

```
GET /v1/workflows?status=running&type=order&limit=50&offset=0
→ { "items": [...], "total": 142, "offset": 0, "limit": 50 }
```

Filter by `status`, `type`, or [search attributes](./search-attributes.md) using `attr.*` query parameters.

**Get workflow state:**

```
GET /v1/workflows/:id
→ { "id": "...", "type": "order", "status": "running", ... }
```

**Get workflow result:**

```
GET /v1/workflows/:id/result
→ { "result": { ... } }
```

If the workflow is still running, this endpoint blocks for up to 30 seconds waiting for completion. Returns `408` on timeout, `422` if the workflow failed or was cancelled.

**Cancel a workflow:**

```
DELETE /v1/workflows/:id
→ 204 No Content
```

**Send a signal:**

```
POST /v1/workflows/:id/signal/:name
{ "payload": { ... } }
→ { "ok": true }
```

**Send an update (synchronous request-response):**

```
POST /v1/workflows/:id/update/:name
{ "payload": { ... }, "timeout": 5000, "idempotencyKey": "..." }
→ { "updateId": "...", "result": { ... } }
```

See the [synchronous updates guide](./synchronous-updates.md) for details on the update model.

**Check update result:**

```
GET /v1/updates/:updateId
→ { "status": "completed", "result": { ... } }
→ { "status": "pending" }  (202 if still processing)
```

**Get/set search attributes:**

```
GET  /v1/workflows/:id/attributes
PATCH /v1/workflows/:id/attributes
{ "attributes": { "priority": 5, "region": "us-east" } }
```

**Metrics (Prometheus-compatible):**

```
GET /v1/metrics
→ text/plain with HELP/TYPE/value lines
```

## WebSocket upgrade paths

The server supports WebSocket connections for real-time streaming. When a request includes the `Upgrade: websocket` header, the server upgrades the connection and subscribes it to the matching path.

Three WebSocket routes are available:

- `/v1/workflows/:id/watch` --- observe workflow state changes in real time
- `/v1/workflows/:id/stream` --- stream tokens from agent workflows
- `/v1/tasks/:queue/stream` --- [remote worker](./remote-workers.md) task dispatch

## The `handleRequest()` function

Under the hood, `serve()` delegates to `handleRequest()`---a pure function that maps a `Request` to a `Response` with no Bun-specific dependencies. This is intentional. If you need to embed Weft's API inside an existing server or use a different HTTP framework, import `handleRequest` directly:

```typescript
import { handleRequest } from 'weft/server/handler';

// Inside your existing server
const response = await handleRequest(request, engine);
```

Route matching uses a table of regex patterns. Each route extracts named parameters (`:id`, `:name`, etc.) from the URL path and dispatches to the appropriate handler function.

## Content negotiation

All response-producing endpoints support content negotiation. If the `Accept` header includes `application/msgpack`, responses are serialized with MessagePack instead of JSON. This reduces payload size for binary-heavy responses. JSON is the default fallback.
