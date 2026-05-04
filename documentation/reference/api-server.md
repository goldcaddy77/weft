# Server API

Weft includes a built-in HTTP + WebSocket server that exposes workflows over a REST API. The `serve()` function wraps `Bun.serve()` with WebSocket upgrade support and clean shutdown. The `handleRequest()` function is a platform-agnostic request handler you can embed in your own server.

## `serve()`

```ts partial
function serve(options: ServeOptions): WeftServer;
```

Start the Weft HTTP + WebSocket server. Returns a `WeftServer` handle for introspection and shutdown.

```ts partial
import { Engine, serve } from 'weft';

const engine = new Engine();
engine.register('greet', async function* (context, name) {
  return `Hello, ${name}!`;
});

const server = serve({ engine, port: 7233 });
console.log(`Weft server running at ${server.url}`);
```

---

## `ServeOptions`

```ts partial
interface ServeOptions {
  engine: Engine;
  port?: number;
  hostname?: string;
  development?: boolean;
  dashboard?: boolean;
  auth?: AuthConfig;
  visibilityPollIntervalMs?: number;
  routingPolicy?: RoutingPolicy;
  schedulingPolicy?: SchedulingPolicy;
  prometheusExporter?: boolean;
  metricsCollector?: MetricsCollector;
}
```

| Field                      | Type               | Default          | Description                                          |
| -------------------------- | ------------------ | ---------------- | ---------------------------------------------------- |
| `engine`                   | `Engine`           | (required)       | The engine instance to expose over HTTP              |
| `port`                     | `number`           | `7233`           | TCP port to listen on                                |
| `hostname`                 | `string`           | `'0.0.0.0'`      | Hostname/IP to bind to                               |
| `development`              | `boolean`          | `false`          | Enable development mode with verbose error responses |
| `dashboard`                | `boolean`          | `true`           | Serve the web dashboard at `/ui`                     |
| `auth`                     | `AuthConfig`       | `undefined`      | Authentication configuration (JWT, mTLS, or custom)  |
| `visibilityPollIntervalMs` | `number`           | `1000`           | Polling interval for task visibility timeout checks  |
| `routingPolicy`            | `RoutingPolicy`    | `'least-loaded'` | Worker routing policy                                |
| `schedulingPolicy`         | `SchedulingPolicy` | `undefined`      | Scheduling policy for task dispatch                  |
| `prometheusExporter`       | `boolean`          | `false`          | Expose Prometheus metrics at `/v1/metrics`           |
| `metricsCollector`         | `MetricsCollector` | `undefined`      | Custom metrics collector instance                    |

See [configuration.md](./configuration.md) for `AuthConfig`, `RoutingPolicy`, and `SchedulingPolicy` details.

---

## `WeftServer`

```ts
interface WeftServer extends AsyncDisposable {
  readonly port: number;
  readonly hostname: string;
  readonly url: string;
  stop(): Promise<void>;
}
```

| Property                  | Type                  | Description                                       |
| ------------------------- | --------------------- | ------------------------------------------------- |
| `port`                    | `number`              | The resolved port the server is listening on      |
| `hostname`                | `string`              | The resolved hostname                             |
| `url`                     | `string`              | Full URL string, e.g. `http://0.0.0.0:7233`       |
| `stop()`                  | `() => Promise<void>` | Gracefully shut down the server                   |
| `[Symbol.asyncDispose]()` | `() => Promise<void>` | Same as `stop()` -- supports `await using` syntax |

```ts partial
{
  await using server = serve({ engine });
  // server shuts down when this block exits
}
```

---

## `handleRequest()`

```ts partial
async function handleRequest(
  request: Request,
  engine: Engine,
  options?: HandlerOptions,
): Promise<Response>;
```

A pure HTTP request handler that maps a `Request` to a `Response`. Has no Bun-specific dependencies -- suitable for embedding in any server framework that uses the Web `Request`/`Response` API.

`HandlerOptions` accepts an operation registry, REST bindings, and a Prometheus exporter. Omit it to use defaults.

```ts partial
import { handleRequest } from 'weft';

// Use inside a custom Bun.serve, Deno.serve, or any framework
const response = await handleRequest(request, engine);
```

---

## REST API Routes

The handler exposes the following routes under the `/v1` prefix:

### Health

| Method | Path         | Description                                                                                                                    |
| ------ | ------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| `GET`  | `/v1/health` | Health check. Returns `{ status: 'ok' }`. Anonymous — no authentication required. Supports content negotiation (JSON/msgpack). |

### Workflows

| Method   | Path                       | Description                                                                   |
| -------- | -------------------------- | ----------------------------------------------------------------------------- |
| `POST`   | `/v1/workflows`            | Start a new workflow                                                          |
| `GET`    | `/v1/workflows`            | List workflows (query params: `status`, `type`, `limit`, `offset`)            |
| `GET`    | `/v1/workflows/:id`        | Get workflow state                                                            |
| `DELETE` | `/v1/workflows/:id`        | Cancel a workflow                                                             |
| `GET`    | `/v1/workflows/:id/result` | Await workflow result (30s default long-poll timeout, configurable up to 60s) |

#### Start Workflow -- Request Body

```json
{
  "type": "send-email",
  "input": { "to": "user@example.com", "body": "Hello!" },
  "id": "optional-custom-id",
  "executionTimeout": "5m"
}
```

Returns `201` with `{ "id": "<workflow-id>" }`.

#### List Workflows -- Query Parameters

| Parameter | Type     | Description                                    |
| --------- | -------- | ---------------------------------------------- |
| `status`  | `string` | Filter by status (e.g. `running`, `completed`) |
| `type`    | `string` | Filter by workflow type                        |
| `limit`   | `number` | Page size                                      |
| `offset`  | `number` | Page offset                                    |

### Signals

| Method | Path                             | Description      |
| ------ | -------------------------------- | ---------------- |
| `POST` | `/v1/workflows/:id/signal/:name` | Deliver a signal |

Request body: `{ "payload": <any> }` (optional).

### Updates

| Method | Path                             | Description                           |
| ------ | -------------------------------- | ------------------------------------- |
| `POST` | `/v1/workflows/:id/update/:name` | Send an update and await the response |
| `GET`  | `/v1/updates/:updateId`          | Poll for an update result             |

Update request body:

```json
{
  "payload": { "key": "value" },
  "timeout": 30000,
  "idempotencyKey": "optional-dedup-key"
}
```

### Attributes

| Method  | Path                           | Description                 |
| ------- | ------------------------------ | --------------------------- |
| `GET`   | `/v1/workflows/:id/attributes` | Get search attributes       |
| `PATCH` | `/v1/workflows/:id/attributes` | Set/merge search attributes |

PATCH body: `{ "attributes": { "key": "value" } }`.

### Schedules

| Method   | Path                        | Description        |
| -------- | --------------------------- | ------------------ |
| `POST`   | `/v1/schedules`             | Create a schedule  |
| `GET`    | `/v1/schedules`             | List schedules     |
| `GET`    | `/v1/schedules/:id`         | Get schedule state |
| `DELETE` | `/v1/schedules/:id`         | Delete a schedule  |
| `POST`   | `/v1/schedules/:id/pause`   | Pause a schedule   |
| `POST`   | `/v1/schedules/:id/unpause` | Unpause a schedule |

### Bulk Operations

| Method | Path                        | Description               |
| ------ | --------------------------- | ------------------------- |
| `POST` | `/v1/workflows/bulk/cancel` | Cancel multiple workflows |
| `POST` | `/v1/workflows/bulk/signal` | Signal multiple workflows |

### Checkpoints & Replay

| Method | Path                            | Description                       |
| ------ | ------------------------------- | --------------------------------- |
| `GET`  | `/v1/workflows/:id/checkpoints` | List workflow checkpoints         |
| `POST` | `/v1/workflows/:id/replay`      | Replay workflow from a checkpoint |
| `POST` | `/v1/workflows/:id/fork`        | Fork a workflow from a checkpoint |

### Reviews

| Method | Path                                  | Description                         |
| ------ | ------------------------------------- | ----------------------------------- |
| `GET`  | `/v1/workflows/:id/reviews`           | List pending reviews for a workflow |
| `POST` | `/v1/workflows/:id/reviews/:reviewId` | Submit a review decision            |

### Discovery

| Method | Path            | Description                                    |
| ------ | --------------- | ---------------------------------------------- |
| `GET`  | `/openapi.json` | OpenAPI 3.1 contract for the operation catalog |
| `GET`  | `/openrpc.json` | OpenRPC 1.3.2 contract                         |

### Metrics

| Method | Path          | Description                                |
| ------ | ------------- | ------------------------------------------ |
| `GET`  | `/v1/metrics` | Prometheus-compatible metrics (text/plain) |

### WebSocket Routes

WebSocket upgrade is supported on the following paths:

| Path                       | Description                                                       |
| -------------------------- | ----------------------------------------------------------------- |
| `/v1/workflows/:id/watch`  | Observe workflow lifecycle events                                 |
| `/v1/workflows/:id/stream` | Stream agent token output                                         |
| `/v1/tasks/:queue/stream`  | Worker task stream                                                |
| `/jsonrpc`                 | JSON-RPC over WebSocket session for the unified operation catalog |

### Error Responses

All errors return JSON with an `error` field:

```json
{ "error": "Workflow with id \"abc\" already exists" }
```

| Status | Meaning                                                           |
| ------ | ----------------------------------------------------------------- |
| `400`  | Bad request (missing fields, invalid JSON, unknown workflow type) |
| `404`  | Resource not found                                                |
| `408`  | Timeout waiting for result or update response                     |
| `409`  | Conflict (duplicate workflow ID)                                  |
| `422`  | Workflow failed or cancelled (result endpoint)                    |
| `500`  | Internal server error                                             |

---

## Service Worker

The `weft/service-worker` module provides bootstrap functions for running the Weft engine inside a Service Worker. These functions wire `handleRequest()` into the Service Worker event model.

```ts partial
import { createFetchHandler, createLifecycleHandlers } from 'weft/service-worker';
```

---

### `ServiceWorkerOptions`

```ts partial
interface ServiceWorkerOptions {
  engine: Engine;
  pathPrefix?: string;
}
```

| Field        | Type     | Default    | Description                                       |
| ------------ | -------- | ---------- | ------------------------------------------------- |
| `engine`     | `Engine` | (required) | The engine instance to handle requests            |
| `pathPrefix` | `string` | `'/weft/'` | URL path prefix that identifies Weft API requests |

---

### `createFetchHandler()`

```ts partial
function createFetchHandler(options: ServiceWorkerOptions): (event: FetchEvent) => void;
```

Returns a `fetch` event listener. When the request URL matches the `pathPrefix`, the listener calls `event.respondWith()` with the result of `handleRequest()`. Non-matching requests pass through to the network.

```ts partial
self.addEventListener('fetch', createFetchHandler({ engine, pathPrefix: '/weft/' }));
```

---

### `createLifecycleHandlers()`

```ts partial
function createLifecycleHandlers(): {
  install: (event: ExtendableEvent) => void;
  activate: (event: ExtendableEvent) => void;
};
```

Returns `install` and `activate` event handlers.

- **`install`**: Calls `skipWaiting()` so the new Service Worker activates immediately without waiting for existing clients to close.
- **`activate`**: Calls `clients.claim()` so the Service Worker takes control of all open tabs without requiring a page reload.

```ts partial
const { install, activate } = createLifecycleHandlers();
self.addEventListener('install', install);
self.addEventListener('activate', activate);
```

---

### Timer wakeup

Use the engine's public scheduler from the Service Worker event handler:

```ts partial
self.addEventListener('periodicsync', (event) => {
  if (event.tag !== 'weft-timers') return;
  event.waitUntil(engine.scheduler.tick());
});
```

Register the matching tag from page code with `registration.periodicSync.register(...)`. See the [Service Worker guide](../guides/service-worker.md) for the full browser setup.
