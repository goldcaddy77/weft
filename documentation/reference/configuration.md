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
  defaultModelRouter?: ModelRouter;
  alerts?: AlertOptions[];
}
```

| Field                            | Type                       | Default               | Description                                                                                                                |
| -------------------------------- | -------------------------- | --------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `storage`                        | `Storage`                  | `new MemoryStorage()` | Storage backend. Use `SQLiteStorage` for persistence or `MemoryStorage` for ephemeral/testing use.                         |
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
| `defaultModelRouter`             | `ModelRouter`              | `undefined`           | Default model router applied to all agent operations                                                                       |
| `alerts`                         | `AlertOptions[]`           | `undefined`           | Metric alert thresholds that fire `AlertFiredEvent` / `AlertResolvedEvent`                                                 |

**Example:**

```ts
import { Engine } from 'weft';
import { SQLiteStorage } from 'weft/storage/sqlite';

const engine = new Engine({
  storage: new SQLiteStorage('data/weft.db'),
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
  budget?: BudgetTracker;
  modelRouter?: ModelRouter;
  contextManager?: ContextWindowManager;
  healthTracker?: ProviderHealthTracker;
  toolCacheTTL?: number;
  signal?: AbortSignal;
  hooks?: AgentHooks;
  eventTarget?: EventTarget;
  workflowId?: string;
  agentId?: string;
  onTurnStarted?: (turn: TurnInfo) => void;
  onTurnCompleted?: (turn: TurnResult) => void;
  onToolCalled?: (call: ToolCallInfo) => void;
  onToolReturned?: (result: ToolReturnInfo) => void;
}
```

| Field            | Type                    | Default     | Description                                                         |
| ---------------- | ----------------------- | ----------- | ------------------------------------------------------------------- |
| `model`          | `string`                | --          | Model identifier (e.g., `'claude-sonnet-4-5-20250929'`). Required.  |
| `provider`       | `LLMProvider`           | --          | LLM provider instance. Required.                                    |
| `systemPrompt`   | `string`                | `undefined` | System message prepended to the conversation.                       |
| `tools`          | `AgentTool[]`           | `[]`        | Tools available to the model.                                       |
| `maxTurns`       | `number`                | `10`        | Maximum LLM turns before returning.                                 |
| `budget`         | `BudgetTracker`         | `undefined` | Token and cost budget tracker.                                      |
| `modelRouter`    | `ModelRouter`           | `undefined` | Per-turn model selection strategy.                                  |
| `contextManager` | `ContextWindowManager`  | `undefined` | Context window compaction manager.                                  |
| `healthTracker`  | `ProviderHealthTracker` | `undefined` | Provider circuit breaker.                                           |
| `toolCacheTTL`   | `number`                | `300_000`   | Tool result cache TTL in milliseconds.                              |
| `signal`         | `AbortSignal`           | `undefined` | Cancellation signal.                                                |
| `hooks`          | `AgentHooks`            | `undefined` | Lifecycle hooks (`beforeTurn`, `afterToolCall`, `onBudgetWarning`). |
| `eventTarget`    | `EventTarget`           | `undefined` | Target for dispatching agent lifecycle events.                      |
| `workflowId`     | `string`                | `''`        | Workflow ID for event correlation.                                  |
| `agentId`        | `string`                | `''`        | Agent ID for event correlation.                                     |

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

## `BudgetOptions`

Passed to `BudgetTracker` to configure token and cost limits.

```ts
interface BudgetOptions {
  maxTokens?: number;
  maxCost?: number;
  warningThreshold?: number;
  models: Record<string, ModelPricing>;
}
```

| Field              | Type                           | Default     | Description                                                   |
| ------------------ | ------------------------------ | ----------- | ------------------------------------------------------------- |
| `maxTokens`        | `number`                       | `undefined` | Maximum total tokens (input + output) before budget exceeded. |
| `maxCost`          | `number`                       | `undefined` | Maximum total cost in dollars before budget exceeded.         |
| `warningThreshold` | `number`                       | `0.8`       | Fraction (0-1) of budget at which the warning callback fires. |
| `models`           | `Record<string, ModelPricing>` | --          | Per-model pricing for cost calculation. Required.             |

### `ModelPricing`

```ts
interface ModelPricing {
  inputCostPer1K: number;
  outputCostPer1K: number;
}
```

---

## `ContextWindowOptions`

Passed to `ContextWindowManager` to configure context compaction.

```ts
interface ContextWindowOptions {
  maxTokens: number;
  reservedForOutput?: number;
  compactAt?: number;
  strategy?: ContextStrategy;
  countTokens?: (messages: Message[]) => Promise<number>;
}
```

| Field               | Type                            | Default              | Description                                             |
| ------------------- | ------------------------------- | -------------------- | ------------------------------------------------------- |
| `maxTokens`         | `number`                        | --                   | Maximum total token budget. Required.                   |
| `reservedForOutput` | `number`                        | `maxTokens * 0.25`   | Tokens reserved for model output.                       |
| `compactAt`         | `number`                        | `0.85`               | Fraction of `inputBudget` at which compaction triggers. |
| `strategy`          | `ContextStrategy`               | `noopStrategy()`     | Compaction strategy to apply.                           |
| `countTokens`       | `(messages) => Promise<number>` | `chars / 4` estimate | Token counting function.                                |

---

## `ProviderHealthOptions`

Passed to `ProviderHealthTracker` to configure circuit breaker behavior.

```ts
interface ProviderHealthOptions {
  windowDuration?: number;
  errorThreshold?: number;
  cooldownDuration?: number;
  minimumRequests?: number;
  getNow?: () => number;
}
```

| Field              | Type           | Default    | Description                                                 |
| ------------------ | -------------- | ---------- | ----------------------------------------------------------- |
| `windowDuration`   | `number`       | `60_000`   | Sliding window duration in ms.                              |
| `errorThreshold`   | `number`       | `0.5`      | Error rate (0-1) at which the circuit trips.                |
| `cooldownDuration` | `number`       | `30_000`   | Time in ms the circuit stays open before a probe request.   |
| `minimumRequests`  | `number`       | `5`        | Minimum requests in the window before the circuit can trip. |
| `getNow`           | `() => number` | `Date.now` | Clock function (useful for testing).                        |

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
