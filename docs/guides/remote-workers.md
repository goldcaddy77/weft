# Remote Workers

Your workflow engine runs on one machine, but your activities need to run on GPU nodes, region-specific servers, or isolated containers. Remote workers connect to the Weft server over WebSocket (or HTTP long-polling as a fallback) and execute activities wherever they're deployed.

## The RemoteWorker class

A `RemoteWorker` connects to the server, registers its available activities and concurrency capacity, then waits for task assignments.

```typescript
import { RemoteWorker } from 'weft/worker';

const worker = new RemoteWorker({
  serverUrl: 'ws://weft-server:7233/v1/tasks/default/stream',
  activities: {
    transcribe: async (input) => {
      /* ... */
    },
    generateThumbnail: async (input) => {
      /* ... */
    },
  },
  concurrency: 5,
  queue: 'gpu',
  workerId: 'gpu-worker-1', // optional, auto-generated if omitted
});

await worker.connect();
```

The `RemoteWorkerOptions` interface:

```typescript
interface RemoteWorkerOptions {
  serverUrl: string;
  workerId?: string; // default: crypto.randomUUID()
  activities: Record<string, (input: unknown) => Promise<unknown>>;
  concurrency?: number; // default: 10
  queue?: string; // default: 'default'
}
```

On connection, the worker sends a `register` message with its identity, available activity names, concurrency limit, and queue. The server tracks it in the `WorkerRegistry`.

## Task dispatch

When the engine needs to execute an activity, the server finds a worker that has capacity and knows how to run it. Tasks arrive as JSON messages over the WebSocket:

```json
{
  "type": "task",
  "operationId": "abc-123",
  "activityName": "transcribe",
  "input": { "audioUrl": "..." }
}
```

The worker looks up the activity function, executes it, and sends back a result:

```json
{
  "type": "taskResult",
  "operationId": "abc-123",
  "status": "completed",
  "value": { "transcript": "..." }
}
```

If the activity function throws, the result message carries `"status": "failed"` with an error string. If the activity name isn't registered on this worker, an error result is sent immediately.

## Heartbeats

The `HeartbeatManager` sends periodic keep-alive messages (every 10 seconds by default) to prevent the server from considering the worker dead. It starts automatically on connection and stops on disconnect.

```typescript
// Internally, the worker does:
this.#heartbeat = new HeartbeatManager(() => {
  this.#sendMessage({ type: 'heartbeat', workerId: this.#options.workerId });
}, 10_000);
```

The `HeartbeatManager` is a simple interval wrapper with `start()`, `stop()`, and a `beat(details?)` method for one-off heartbeats with optional payload. The server's `WorkerRegistry` updates the worker's `lastHeartbeat` timestamp on each heartbeat.

## Queue-based routing

Workers register with a queue name. The server's `WorkerRegistry.findWorker()` uses **least-loaded routing**---it picks the worker with the lowest in-flight count among those that handle the requested activity and have available capacity.

```typescript
interface RoutingOptions {
  sticky?: string; // preferred worker ID for cache locality
  queue?: string;
}
```

If a `sticky` preference is provided (useful for cache locality), the registry checks that worker first. If it has capacity, it gets the task. Otherwise, least-loaded routing kicks in.

## The WorkerRegistry

On the server side, `WorkerRegistry` tracks all connected workers and their state:

```typescript
interface WorkerInfo {
  id: string;
  activities: string[];
  concurrency: number;
  inFlight: number;
  connectedAt: number;
  lastHeartbeat: number;
}
```

Key operations:

- `register(info)` --- add a worker when it connects
- `unregister(workerId)` --- remove a worker, returns its info for task reassignment
- `heartbeat(workerId)` --- update last heartbeat timestamp
- `taskAssigned(workerId)` / `taskCompleted(workerId)` --- track in-flight counts
- `findWorker(activityName, options?)` --- least-loaded routing
- `assignTask(workerId, operationId, visibilityTimeout)` --- track task with deadline
- `checkExpiredTasks(now)` --- find tasks whose visibility timeout has expired
- `extendVisibility(operationId, extension)` --- extend a task's deadline (heartbeat-driven)

The `checkExpiredTasks()` method returns tasks that have exceeded their visibility timeout, enabling the server to reassign them to other workers.

## Long-poll fallback

Not every environment supports WebSockets. The `LongPollWorker` provides the same functionality over plain HTTP requests.

```typescript
import { LongPollWorker } from 'weft/worker';

const worker = new LongPollWorker({
  serverUrl: 'http://weft-server:7233',
  activities: {
    transcribe: async (input) => {
      /* ... */
    },
  },
  concurrency: 5,
  queue: 'gpu',
  pollTimeout: 30_000, // how long each poll request blocks
});

worker.start();
```

The long-poll worker runs a loop: it `POST`s to `/poll` with its activity list and queue, blocks for up to `pollTimeout` milliseconds waiting for a task, executes it, and `POST`s the result to `/complete`. It respects the concurrency limit by pausing the poll loop when all slots are in use.

Error handling is built in---network failures trigger a 1-second backoff, abort errors during shutdown are suppressed.

## Graceful shutdown

Both worker types support graceful shutdown. The `RemoteWorker` drains in-flight tasks before closing the WebSocket:

```typescript
await worker.disconnect();
```

The server can also initiate shutdown by sending a `{ type: 'shutdown' }` message. The worker stops accepting new tasks, waits for in-flight work to complete, then closes.

Both classes implement `Disposable` for use with `using`:

```typescript
{
  using worker = new RemoteWorker(options);
  await worker.connect();
  // Worker runs...
} // Automatically cleaned up
```

The `connected`, `inFlight`, and `shuttingDown` properties let you monitor worker status for health checks and dashboards.
