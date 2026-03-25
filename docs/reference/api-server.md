# Server API

Weft includes a built-in HTTP + WebSocket server that exposes workflows over a REST API. The `serve()` function wraps `Bun.serve()` with WebSocket upgrade support and clean shutdown. The `handleRequest()` function is a platform-agnostic request handler you can embed in your own server.

## `serve()`

```ts
function serve(options: ServeOptions): WeftServer;
```

Start the Weft HTTP + WebSocket server. Returns a `WeftServer` handle for introspection and shutdown.

```ts
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

```ts
interface ServeOptions {
  engine: Engine;
  port?: number;
  hostname?: string;
}
```

| Field      | Type     | Default     | Description                             |
| ---------- | -------- | ----------- | --------------------------------------- |
| `engine`   | `Engine` | (required)  | The engine instance to expose over HTTP |
| `port`     | `number` | `7233`      | TCP port to listen on                   |
| `hostname` | `string` | `'0.0.0.0'` | Hostname/IP to bind to                  |

---

## `WeftServer`

```ts
interface WeftServer extends Disposable {
  readonly port: number;
  readonly hostname: string;
  readonly url: string;
  stop(): void;
}
```

| Property             | Type         | Description                                  |
| -------------------- | ------------ | -------------------------------------------- |
| `port`               | `number`     | The resolved port the server is listening on |
| `hostname`           | `string`     | The resolved hostname                        |
| `url`                | `string`     | Full URL string, e.g. `http://0.0.0.0:7233`  |
| `stop()`             | `() => void` | Gracefully shut down the server              |
| `[Symbol.dispose]()` | `() => void` | Same as `stop()` -- supports `using` syntax  |

```ts
{
  using server = serve({ engine });
  // server shuts down when this block exits
}
```

---

## `handleRequest()`

```ts
async function handleRequest(request: Request, engine: Engine): Promise<Response>;
```

A pure HTTP request handler that maps a `Request` to a `Response`. Has no Bun-specific dependencies -- suitable for embedding in any server framework that uses the Web `Request`/`Response` API.

```ts
import { handleRequest } from 'weft';

// Use inside a custom Bun.serve, Deno.serve, or any framework
const response = await handleRequest(request, engine);
```

---

## REST API Routes

The handler exposes the following routes under the `/v1` prefix:

### Health

| Method | Path         | Description                                                                            |
| ------ | ------------ | -------------------------------------------------------------------------------------- |
| `GET`  | `/v1/health` | Health check. Returns `{ status: 'ok' }`. Supports content negotiation (JSON/msgpack). |

### Workflows

| Method   | Path                       | Description                                                        |
| -------- | -------------------------- | ------------------------------------------------------------------ |
| `POST`   | `/v1/workflows`            | Start a new workflow                                               |
| `GET`    | `/v1/workflows`            | List workflows (query params: `status`, `type`, `limit`, `offset`) |
| `GET`    | `/v1/workflows/:id`        | Get workflow state                                                 |
| `DELETE` | `/v1/workflows/:id`        | Cancel a workflow                                                  |
| `GET`    | `/v1/workflows/:id/result` | Await workflow result (30s long-poll timeout)                      |

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

### Metrics

| Method | Path          | Description                                |
| ------ | ------------- | ------------------------------------------ |
| `GET`  | `/v1/metrics` | Prometheus-compatible metrics (text/plain) |

### WebSocket Routes

WebSocket upgrade is supported on the following paths:

| Path                       | Description                       |
| -------------------------- | --------------------------------- |
| `/v1/workflows/:id/watch`  | Observe workflow lifecycle events |
| `/v1/workflows/:id/stream` | Stream agent token output         |
| `/v1/tasks/:queue/stream`  | Worker task stream                |

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
