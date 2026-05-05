# Configuration Reference

Most configuration flows through typed option objects rather than environment variables. Some integrations (OpenTelemetry, observability exporters) may read standard env vars from their own SDKs, but Weft itself does not require any env vars to be set.

---

## `EngineOptions`

Passed to the `Engine` constructor. All fields are optional with sensible defaults.

```ts partial
interface EngineOptions {
  storage?: Storage;
  development?: boolean;
  serializer?: Serializer;
  checkpointHistory?: number;
  checkpointSizeWarningThreshold?: number;
  maxNestingDepth?: number;
  broadcastEvents?: boolean;
  tenantResolver?: TenantResolver;
  quotas?: TenantQuotaOptions;
  retention?: RetentionPolicy;
  compression?: boolean;
  workerExecution?: WorkerExecutionOptions;
  activityExecution?: ActivityExecutionOptions;
  alerts?: AlertOptions[];
}
```

| Field                            | Type                       | Default               | Description                                                                                                                |
| -------------------------------- | -------------------------- | --------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `storage`                        | `Storage`                  | `new MemoryStorage()` | Storage backend. Use `BunSQLiteStorage` for persistence or `MemoryStorage` for ephemeral/testing use.                      |
| `development`                    | `boolean`                  | `false`               | Enable development mode. Validates checkpoint round-trips and emits `DevelopmentWarningEvent` for non-serializable fields. |
| `serializer`                     | `Serializer`               | Built-in codec        | Pluggable serialization. The default uses structured clone via the built-in `encode`/`decode` codec.                       |
| `checkpointHistory`              | `number`                   | `10`                  | Number of historical checkpoints to retain per workflow.                                                                   |
| `checkpointSizeWarningThreshold` | `number`                   | `65_536` (64 KB)      | Checkpoint size in bytes at which a `CheckpointSizeWarningEvent` is emitted.                                               |
| `maxNestingDepth`                | `number`                   | `10`                  | Maximum child workflow nesting depth.                                                                                      |
| `broadcastEvents`                | `boolean`                  | `false`               | Enable `BroadcastChannel` for cross-worker event coordination. Lazily creates the channel on first use.                    |
| `tenantResolver`                 | `TenantResolver`           | `undefined`           | Resolves tenant context from workflow start options for multi-tenant isolation                                             |
| `quotas`                         | `TenantQuotaOptions`       | `undefined`           | Per-tenant quota configuration for workflow creation rate limiting                                                         |
| `retention`                      | `RetentionPolicy`          | `undefined`           | Default retention policy for completed/failed/cancelled workflows                                                          |
| `compression`                    | `boolean`                  | `false`               | Enable checkpoint compression                                                                                              |
| `workerExecution`                | `WorkerExecutionOptions`   | `undefined`           | Configuration for offloading workflow execution to Web Workers                                                             |
| `activityExecution`              | `ActivityExecutionOptions` | `undefined`           | Configuration for activity execution behavior                                                                              |
| `alerts`                         | `AlertOptions[]`           | `undefined`           | Metric alert thresholds that fire `AlertFiredEvent` / `AlertResolvedEvent`                                                 |

**Example:**

```ts
import { Engine } from 'weft';
import { BunSQLiteStorage } from 'weft/storage/bun-sqlite';

const engine = new Engine({
  storage: new BunSQLiteStorage('data/weft.db'),
  development: true,
  checkpointHistory: 20,
  maxNestingDepth: 5,
});
```

---

## `ServeOptions`

Passed to the `serve()` function to start the Weft HTTP + WebSocket server.

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

The returned `WeftServer` exposes the resolved `port`, `hostname`, and `url`, along with a `stop()` method and `AsyncDisposable` support.

**Example:**

```ts partial
import { Engine, serve } from 'weft';

const engine = new Engine();
const server = serve({ engine, port: 8080 });
console.log(`Weft server running at ${server.url}`);
```

---

## `AgentOptions`

Passed to `executeAgentLoop()`. See the [Agent API reference](./api-agent.md) for the full table.

```ts partial
interface AgentOptions {
  model: string;
  provider: LLMProvider;
  systemPrompt?: string;
  tools?: AgentTool[];
  maxTurns?: number;
  signal?: AbortSignal;
  eventTarget?: EventTarget;
  workflowId?: string;
  agentId?: string;
  toolEffectLog?: ToolEffectLogLike;
  verificationRecorder?: VerificationRecorder;
  checkpointSizeWarningThreshold?: number;
}
```

| Field                            | Type                   | Default     | Description                                           |
| -------------------------------- | ---------------------- | ----------- | ----------------------------------------------------- |
| `model`                          | `string`               | --          | Model identifier passed to the provider. Required.    |
| `provider`                       | `LLMProvider`          | --          | Structural LLM provider. Required.                    |
| `systemPrompt`                   | `string`               | `undefined` | System message prepended to the conversation.         |
| `tools`                          | `AgentTool[]`          | `[]`        | Tools available to the model.                         |
| `maxTurns`                       | `number`               | `10`        | Maximum LLM turns before returning.                   |
| `signal`                         | `AbortSignal`          | `undefined` | Cancellation signal.                                  |
| `eventTarget`                    | `EventTarget`          | `undefined` | Target for dispatching agent events.                  |
| `workflowId`                     | `string`               | `''`        | Workflow ID for event correlation.                    |
| `agentId`                        | `string`               | `''`        | Agent ID for event correlation.                       |
| `toolEffectLog`                  | `ToolEffectLogLike`    | `undefined` | Durable effect log for tool-call deduplication.       |
| `verificationRecorder`           | `VerificationRecorder` | `undefined` | Internal verification sink for speculative execution. |
| `checkpointSizeWarningThreshold` | `number`               | `65_536`    | Conversation snapshot warning threshold in bytes.     |

---

## `RetryPolicy`

Controls retry behavior for activity execution.

```ts partial
interface RetryPolicy {
  maxAttempts: number;
  initialBackoff: Duration;
  backoffMultiplier: number;
  maxBackoff: Duration;
  nonRetryableErrors?: string[];
}
```

| Field                | Type       | Default               | Description                                          |
| -------------------- | ---------- | --------------------- | ---------------------------------------------------- |
| `maxAttempts`        | `number`   | `3`                   | Total attempts (including the first).                |
| `initialBackoff`     | `Duration` | `1000` (1 second)     | Delay before the first retry.                        |
| `backoffMultiplier`  | `number`   | `2`                   | Multiplier applied to the backoff after each retry.  |
| `maxBackoff`         | `Duration` | `30_000` (30 seconds) | Upper bound on backoff duration.                     |
| `nonRetryableErrors` | `string[]` | `undefined`           | Error message substrings that should not be retried. |

The backoff for attempt N is `min(initialBackoff * backoffMultiplier^(N-1), maxBackoff)`.

---

## Constants

### `DEFAULT_RETRY_POLICY`

```ts partial
const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 3,
  initialBackoff: 1000,
  backoffMultiplier: 2,
  maxBackoff: 30_000,
};
```

### `DEFAULT_CHECKPOINT_SIZE_WARNING_THRESHOLD`

```ts
const DEFAULT_CHECKPOINT_SIZE_WARNING_THRESHOLD = 65_536; // 64 KB
```

Checkpoint size in bytes at which the engine emits a `CheckpointSizeWarningEvent`. Override via `EngineOptions.checkpointSizeWarningThreshold`.

### `DEFAULT_MAX_NESTING_DEPTH`

```ts
const DEFAULT_MAX_NESTING_DEPTH = 10;
```

Maximum depth of child workflow nesting. Override via `EngineOptions.maxNestingDepth`.

### `DEFAULT_VISIBILITY_TIMEOUT_MS`

```ts
const DEFAULT_VISIBILITY_TIMEOUT_MS = 30_000; // 30 seconds
```

Default task visibility timeout. After this window, the task server considers a task unacknowledged and eligible for reassignment. Override via worker options.

---

## `ObservabilityOptions`

Passed to `createObservabilityInterceptors()`. See the [Observability API reference](./api-observability.md).

```ts
interface ObservabilityOptions {
  recordPayloads?: boolean;
  maxPayloadSize?: number;
  eventTarget?: EventTarget;
  onSpanStart?: (span: SpanInfo) => void;
  onSpanEnd?: (span: SpanInfo) => void;
}
```

| Field            | Type                       | Default     | Description                                                                                                         |
| ---------------- | -------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------- |
| `recordPayloads` | `boolean`                  | `false`     | Record activity/workflow inputs as span attributes.                                                                 |
| `maxPayloadSize` | `number`                   | `1024`      | Maximum serialized payload size before truncation.                                                                  |
| `eventTarget`    | `EventTarget`              | `undefined` | Engine or EventTarget for automatic root-span cleanup on terminal events. Required for per-turn and per-tool spans. |
| `onSpanStart`    | `(span: SpanInfo) => void` | `undefined` | Span start callback.                                                                                                |
| `onSpanEnd`      | `(span: SpanInfo) => void` | `undefined` | Span end callback.                                                                                                  |
