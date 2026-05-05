# RemoteWorker Wire Protocol

This document describes the WebSocket-based protocol Weft uses to dispatch activity tasks to remote workers. The protocol is the same one the built-in TypeScript `RemoteWorker` (in `src/worker/index.ts`) speaks; documenting it lets SDK authors in other languages implement compatible workers without reverse-engineering the source.

> [!NOTE]
> The TypeScript implementation in `src/worker/index.ts` is canonical. This document describes that implementation as it exists today. It may lag behind source changes; cross-check before relying on details for cross-language SDK work.

## At a glance

- **Transport**: WebSocket (text frames, JSON-encoded messages).
- **Endpoint**: `/v1/tasks/:queue/stream` on the Weft server. Connect to one queue per WebSocket.
- **Direction**: bidirectional. Workers send `register`, `heartbeat`, `taskResult`. Server sends `task`, `cancel`, `shutdown`.
- **Heartbeat**: workers heartbeat every 10 seconds.
- **Authentication**: not currently part of the protocol envelope. Auth happens at the WebSocket transport layer (URL or HTTP upgrade headers).
- **Versioning**: no version handshake currently. Implementations should treat the TypeScript types in `src/worker/index.ts` as the canonical contract for the `weft` version they target.
- **Close codes**: no application-level close codes defined. Use standard WebSocket close codes.

## Connecting

The server exposes one WebSocket endpoint per task queue:

```
ws://server.example.com/v1/tasks/:queue/stream
wss://server.example.com/v1/tasks/:queue/stream
```

`:queue` is URL-encoded. The default queue is `default`. A worker connects to exactly one queue per WebSocket connection — to serve multiple queues, open one connection per queue.

The TypeScript `RemoteWorker` accepts the full URL via its `serverUrl` option:

```ts
import { RemoteWorker } from 'weft';

using worker = new RemoteWorker({
  serverUrl: 'ws://localhost:7233/v1/tasks/default/stream',
  activities: { sendEmail },
  concurrency: 5,
  queue: 'default',
});
await worker.connect();
```

### Authentication

Authentication is **not currently specified at the protocol envelope** — there is no auth field on `register` and no auth handshake message. Any auth must happen at the WebSocket transport layer:

- A token in the connection URL (`?token=...`), or
- An HTTP `Authorization` header on the upgrade request, or
- A cookie set on the same origin.

Production deployments should use TLS (`wss://`) and pin auth to whichever transport mechanism the server enforces.

## Lifecycle

```
Worker                              Server
  |                                   |
  |--- WebSocket open ------------->  |
  |                                   |
  |--- register ------------------>   |   (worker added to registry)
  |                                   |
  |   <---------------- task ------   |   (per available capacity)
  |--- taskResult ----------------->  |
  |                                   |
  |   <----------- task ----------    |
  |--- taskResult ----------------->  |
  |                                   |
  |--- heartbeat (every 10s) ------>  |   (extends visibility on
  |                                   |    in-flight tasks)
  |                                   |
  |   <---- cancel (operationId) -    |   (optional, when a task
  |                                   |    needs to be aborted)
  |                                   |
  |   <---- shutdown -------------    |   (optional, server-initiated
  |                                   |    graceful drain)
  |--- WebSocket close ------------>  |
```

The connection is the registration. There is **no `register` acknowledgement, no `registerError` reply, and no version handshake** — once the WebSocket is open and the `register` message has been sent, the worker proceeds as if registration succeeded. If the server rejects the registration (for instance, an empty `workerId`), it silently drops the message and the worker stays connected without ever receiving tasks. An idle queue and a rejected registration are indistinguishable from the worker's perspective.

> [!WARNING]
> The protocol does not currently let an SDK observe registration failure. Until `registerAck` / `registerError` exist, treat this as a known limitation rather than a robust contract. SDK authors should:
>
> 1. Validate `workerId`, `activities`, `concurrency`, and queue locally before sending `register`. The server enforces `workerId.length > 0`, `concurrency` clamped to `[1, 1000]`, and at least one entry in `activities` if you expect to receive tasks; mirror those validations client-side.
> 2. Treat task arrival as the only positive runtime signal. For an SDK conformance suite, send a known-good registration and assert that a synthetic task round-trips within a deployment-defined timeout.
> 3. Configure a worker-side timeout for "no traffic at all" (no tasks _and_ no incoming messages over some interval beyond the heartbeat cadence). On timeout, log, close the WebSocket with a standard close code, and reconnect rather than waiting indefinitely.
>
> Adding `registerAck` to the wire protocol is tracked in the roadmap. Until it lands, server- and client-side behavior described in this section is a description of current behavior, not a recommended protocol pattern.

The server tracks the worker by its `workerId` in an in-memory registry. If the WebSocket closes without a graceful shutdown, the server eventually times out the worker's claim on any in-flight tasks (visibility timeout). Those tasks become eligible for redispatch to other workers.

## Message catalog

All messages are JSON objects with a `type` discriminator.

**Worker handling of unknown server messages**: ignore. New server-to-worker message types may appear in future `weft` versions; an SDK that ignores unknown ones forward-compatibly survives version skew.

**Server handling of unknown worker messages**: the current TypeScript server silently drops messages whose `type` it doesn't recognize, with no warning logged. SDK authors should treat this as an implementation wart, not a contract: a misspelled message type or a typo'd field name will fail silently. Validate your outgoing messages locally against the message catalog before sending. The drift-prevention test that locks this behavior down is tracked in the roadmap; until then, the cost of a typo is silent task loss.

### Worker → Server

#### `register`

Sent immediately after the WebSocket opens.

```json
{
  "type": "register",
  "workerId": "<string>",
  "activities": ["<activity-name>", ...],
  "concurrency": 10,
  "queue": "default"
}
```

| Field         | Type         | Required | Description                                                                                         |
| ------------- | ------------ | -------- | --------------------------------------------------------------------------------------------------- |
| `type`        | `"register"` | Yes      | Message discriminator.                                                                              |
| `workerId`    | string       | Yes      | Stable identifier for this worker. The server rejects (silently drops) empty strings.               |
| `activities`  | string[]     | Yes      | Names of activities this worker can execute. The server only dispatches matching tasks.             |
| `concurrency` | number       | No       | Maximum concurrent tasks. Server clamps to `[1, 1000]`. Defaults to `10` if missing or non-numeric. |
| `queue`       | string       | No       | Queue name. The server prefers the queue derived from the URL path; this field is informational.    |

The server processes `register` only on worker-stream paths (`/v1/tasks/:queue/stream`). On other WebSocket endpoints (e.g., `/jsonrpc`), `register` messages are ignored.

#### `heartbeat`

Sent every 10 seconds while connected. Tells the server the worker is alive and extends the visibility timeout on every in-flight task assigned to this worker.

```json
{
  "type": "heartbeat",
  "workerId": "<string>"
}
```

| Field      | Type          | Required | Description                               |
| ---------- | ------------- | -------- | ----------------------------------------- |
| `type`     | `"heartbeat"` | Yes      | Message discriminator.                    |
| `workerId` | string        | Yes      | The same `workerId` used at registration. |

The server extends each in-flight task's deadline by the task's visibility timeout. A heartbeat that arrives while the worker has no in-flight tasks is still valuable — it keeps the server-side liveness tracker fresh.

The TypeScript `RemoteWorker` heartbeat interval is exactly 10,000 ms. SDK authors should match this cadence; the server's visibility-timeout assumption depends on it.

#### `taskResult`

Sent when an in-flight task completes, fails, or is cancelled.

**Success:**

```json
{
  "type": "taskResult",
  "operationId": "<string>",
  "status": "completed",
  "value": <any-json>
}
```

**Failure:**

```json
{
  "type": "taskResult",
  "operationId": "<string>",
  "status": "failed",
  "error": "<message>"
}
```

**Cancellation:**

```json
{
  "type": "taskResult",
  "operationId": "<string>",
  "status": "cancelled",
  "cancelled": true,
  "error": "Task cancelled"
}
```

| Field         | Type                                     | Required                    | Description                                                             |
| ------------- | ---------------------------------------- | --------------------------- | ----------------------------------------------------------------------- |
| `type`        | `"taskResult"`                           | Yes                         | Message discriminator.                                                  |
| `operationId` | string                                   | Yes                         | The `operationId` from the corresponding `task` message.                |
| `status`      | `"completed" \| "failed" \| "cancelled"` | Yes                         | Outcome.                                                                |
| `value`       | any JSON-serializable value              | Yes if `completed`          | Activity result.                                                        |
| `error`       | string                                   | Yes if `failed`/`cancelled` | Human-readable error message. SDKs should extract from `Error.message`. |
| `cancelled`   | `true`                                   | Conventional if `cancelled` | Set by the TypeScript implementation. Servers don't depend on it.       |

The server treats `cancelled` as a terminal failure: the inflight record transitions to `resolved` with status `failed`.

**Contract**: SDKs MUST echo the exact opaque `operationId` from the corresponding `task` message in every `taskResult`. The server does not infer the task identity from the WebSocket connection alone. The current TypeScript server's behavior on a missing `operationId` is to log a warning and decrement only the worker's in-flight counter, leaving the inflight tracking record to leak until the visibility timeout reclaims it; SDK authors should treat that as an implementation wart, not a recovery path. Always send `operationId` exactly as received.

If `status` is anything other than `completed`, `failed`, or `cancelled`, the server logs a warning and treats the result as `failed`.

### Server → Worker

#### `task`

Dispatched when the server has work for this worker.

```json
{
  "type": "task",
  "operationId": "<string>",
  "activityName": "<string>",
  "input": <any-json>,
  "attempt": 1,
  "headers": { "<key>": "<value>" }
}
```

| Field          | Type                     | Required | Description                                                                          |
| -------------- | ------------------------ | -------- | ------------------------------------------------------------------------------------ |
| `type`         | `"task"`                 | Yes      | Message discriminator.                                                               |
| `operationId`  | string                   | Yes      | Unique identifier the worker echoes back in `taskResult`.                            |
| `activityName` | string                   | Yes      | Name of the activity to execute. Must be in the worker's `activities` list.          |
| `input`        | any JSON value           | Yes      | Activity input. Worker passes it through to the activity function.                   |
| `attempt`      | number                   | No       | Retry counter. Present on retries; absent on the first attempt.                      |
| `headers`      | `Record<string, string>` | No       | Interceptor-propagated headers from the dispatch path. Pass through to interceptors. |

If the worker doesn't recognize `activityName`, it should respond with a `taskResult` of `status: "failed"` and `error: "Unknown activity: <name>"`. The TypeScript implementation does this automatically.

#### `cancel`

Server requests cancellation of an in-flight task.

```json
{
  "type": "cancel",
  "operationId": "<string>"
}
```

| Field         | Type       | Required | Description                                           |
| ------------- | ---------- | -------- | ----------------------------------------------------- |
| `type`        | `"cancel"` | Yes      | Message discriminator.                                |
| `operationId` | string     | Yes      | The task to cancel. Workers ignore non-string values. |

Workers should signal cancellation to the activity (typically by aborting an `AbortSignal`) and report the eventual outcome via `taskResult` with `status: "cancelled"`.

#### `shutdown`

Server requests graceful shutdown of the worker.

```json
{
  "type": "shutdown"
}
```

The TypeScript implementation:

1. Sets a `shuttingDown` flag, refusing new `task` messages.
2. Stops the heartbeat.
3. Drains in-flight tasks (waits up to `disconnectTimeoutMs`, default 30,000 ms).
4. Aborts any tasks still running after the deadline.
5. Closes the WebSocket.

SDK authors are encouraged to follow the same pattern. The drain timeout is a soft limit—the server expects the worker to disconnect afterwards.

## Behavior gaps

These behaviors are unspecified or only partially specified by the current protocol. SDK authors should be aware:

- **No `register` acknowledgement.** Treat task arrival as the implicit success signal.
- **No protocol versioning.** Implementations should assume the protocol matches the `weft` version they target. Breaking changes will land alongside source changes; track them in [the migration guide](../guides/migration.md).
- **No application-level close codes.** Standard WebSocket close codes (`1000`, `1001`, `1006`, `1011`) are used as-is; the protocol defines no codes of its own.
- **Reconnect with in-flight tasks.** When a worker disconnects with tasks in flight, the server eventually times them out via the visibility deadline. Tasks become eligible for redispatch to any worker subscribed to the queue, including a reconnected instance of the original worker. The protocol does not have an explicit "resume in-flight tasks" message — a reconnecting worker rejoins as a fresh worker.
- **`operationId` uniqueness.** The TypeScript server uses operation identifiers that are unique per task across the engine's lifetime. Workers should treat them as opaque strings and not assume any structure.
- **Unknown messages.** Both sides ignore message types they don't recognize. Implementations adding experimental message types should document the type prefix they use.

## Conformance

A conformance test suite for cross-language SDKs is not yet shipped. SDK authors should at minimum verify:

1. **Connect and register.** Open a WebSocket, send `register`, observe that the worker becomes visible in the server's worker registry.
2. **Receive and execute a task.** Server dispatches `task`, worker runs the activity, sends `taskResult` with `status: "completed"`. Result is delivered to the originating workflow.
3. **Heartbeat keeps long-running tasks alive.** Run an activity longer than the default visibility timeout, with heartbeats firing every 10 seconds. The server should not time out the task.
4. **Cancellation.** Server sends `cancel`, worker aborts the activity, replies with `status: "cancelled"`. Workflow observes the cancellation.
5. **Graceful shutdown.** Server sends `shutdown`, worker drains in-flight tasks, closes the WebSocket. Server reissues unprocessed tasks to other workers.
6. **Reconnect.** Worker disconnects mid-task, reconnects, verifies the in-flight task is eventually redispatched (to itself or another worker) after the visibility timeout expires.

The drift-prevention test that mirrors the discovery-parity test is tracked in the roadmap; until it lands, the TypeScript implementation in `src/worker/index.ts` is canonical.
