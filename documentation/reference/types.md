# Types Reference

Complete type reference for Weft, organized by category. All types are exported from the `weft` package entry point.

---

## Core Types

### `WorkflowId`

```ts partial
type WorkflowId = string;
```

### `WorkflowStatus`

```ts partial
type WorkflowStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled' | 'timed-out';
```

### `WorkflowState`

Persisted workflow state stored in the storage backend.

```ts partial
interface WorkflowState {
  id: WorkflowId;
  type: string;
  status: WorkflowStatus;
  input: unknown;
  result?: unknown;
  error?: string;
  version: string;
  createdAt: number;
  updatedAt: number;
  executionDeadline?: number;
}
```

### `WorkflowFunction`

The signature of a workflow generator function.

```ts partial
type WorkflowFunction<TInput = unknown, TOutput = unknown> = (
  context: WorkflowContext,
  input: TInput,
) => AsyncGenerator<unknown, TOutput, unknown>;
```

### `WorkflowContext`

The context object passed as the first argument to every workflow function.

```ts partial
interface WorkflowContext {
  readonly workflowId: WorkflowId;
  readonly signal: AbortSignal;
  readonly executionTimeRemaining: number;
  readonly startedAt: number;
  readonly tenant: TenantContext | undefined;
  sessionState<T>(key: string, initialValue?: T): WorkflowSessionState<T>;
  pipe<TInput, TOutput>(
    inputs: TInput[],
    stages: WorkflowPipeStage<TInput, TOutput>[],
    options?: WorkflowChildOptions,
  ): WorkflowOperation<TOutput[]>;
  map<TInput, TOutput>(
    inputs: TInput[],
    target: ChildWorkflowTarget<TInput, TOutput>,
    options?: WorkflowMapOptions,
  ): WorkflowOperation<TOutput[]>;
  reduce<TInput, TAcc>(
    inputs: TInput[],
    target: ChildWorkflowTarget<[TAcc, TInput], TAcc>,
    initial: TAcc,
    options?: WorkflowReduceOptions,
  ): WorkflowOperation<TAcc>;
}
```

The full `Context` class exposes additional concrete methods documented in the [Context API reference](./api-context.md).

### Composition Types

Types for `ctx.pipe()`, `ctx.map()`, and `ctx.reduce()` durable composition operators.

```ts partial
/** A pending durable composition result. Yield with `yield*` inside a workflow. */
interface WorkflowOperation<TResult> {
  readonly operationId: string;
}

/** Accepted forms for specifying a child workflow in composition operators. */
type ChildWorkflowTarget<TInput = unknown, TOutput = unknown> =
  | string
  | WorkflowFunction<TInput, TOutput>
  | StepWorkflowFunction<TInput, TOutput>;

interface WorkflowMapOptions {
  concurrency?: number;
  idPrefix?: string;
}

interface WorkflowReduceOptions {
  idPrefix?: string;
}

interface WorkflowPipeStageDefinition<TInput = unknown, TOutput = unknown> {
  target: ChildWorkflowTarget<TInput, TOutput>;
  options?: WorkflowChildOptions;
}

type WorkflowPipeStage<TInput = unknown, TOutput = unknown> =
  | ChildWorkflowTarget<TInput, TOutput>
  | WorkflowPipeStageDefinition<TInput, TOutput>;
```

### `WorkflowSessionState<T>`

Per-workflow durable state slot returned by `ctx.sessionState(key, initialValue?)`. Checkpointed with the workflow.

```ts partial
interface WorkflowSessionState<T> {
  get(): T | undefined;
  set(value: T): T;
  update(updater: (current: T | undefined) => T): T;
  clear(): void;
  run<TResult>(
    fn: (...args: unknown[]) => Promise<TResult> | TResult,
    ...rest: unknown[]
  ): WorkflowOperation<TResult>;
}
```

### `DefinitionSchema`

```ts partial
type DefinitionSchema<Input = unknown, Output = Input> =
  | StandardSchemaV1<Input, Output>
  | StandardJSONSchemaV1<Input, Output>;
```

Schema metadata accepted by workflow and activity definitions. [Standard Schema](https://standardschema.dev/) validation and [Standard JSON Schema](https://standardschema.dev/json-schema) conversion are separate capabilities; a definition can provide either one or both.

Core workflow and activity execution stores these fields for introspection. Runtime validation happens only in adapters that explicitly consume the metadata.

### `WorkflowRegistration`

```ts partial
interface WorkflowRegistration<TInput = unknown, TOutput = unknown> {
  version?: string;
  description?: string;
  tags?: ReadonlyArray<string>;
  inputSchema?: DefinitionSchema<unknown, TInput>;
  outputSchema?: DefinitionSchema<unknown, TOutput>;
  handler: WorkflowFunction<TInput, TOutput>;
  migrate?: (checkpoint: unknown, fromVersion: string) => unknown;
  searchAttributes?: SearchAttributeSchema;
}
```

### `WorkflowDefinition`

Read-only metadata returned by engine workflow-definition introspection.

```ts partial
interface WorkflowDefinition<TInput = unknown, TOutput = unknown> {
  type: string;
  version: string;
  tags: ReadonlyArray<string>;
  description?: string;
  inputSchema?: DefinitionSchema<unknown, TInput>;
  outputSchema?: DefinitionSchema<unknown, TOutput>;
}
```

### `WorkflowRegistry`

Type-level registry shape for generated wrappers and module augmentation. The current `Engine` class itself is not generic.

```ts partial
type WorkflowRegistry = Record<string, { input: unknown; output: unknown }>;
```

### `Duration`

A number (milliseconds) or a human-readable string like `'5s'`, `'2m'`, `'1h'`.

```ts partial
type Duration = number | string;
```

### `Checkpoint`

Snapshot of workflow state at a `yield*` boundary.

```ts partial
interface Checkpoint {
  workflowId: WorkflowId;
  step: number;
  locals: Record<string, unknown>;
  pendingSignals: string[];
  searchAttributes: Record<string, SearchAttributeValue>;
  version: string;
  createdAt: number;
}
```

### `RetryPolicy`

```ts partial
interface RetryPolicy {
  maxAttempts: number;
  initialBackoff: Duration;
  backoffMultiplier: number;
  maxBackoff: Duration;
  nonRetryableErrors?: string[];
}
```

See [Configuration](./configuration.md) for default values.

### `ActivityFunction`

```ts partial
type ActivityFunction<TInput = unknown, TOutput = unknown> = (
  input: TInput,
  context?: ActivityContext,
) => Promise<TOutput> | TOutput;
```

### `ActivityContext`

```ts partial
interface ActivityContext {
  signal: AbortSignal;
  heartbeat(details?: unknown): void;
}
```

### `ActivityDefinition`

```ts partial
interface ActivityDefinition<TInput = unknown, TOutput = unknown> {
  name: string;
  description?: string;
  tags?: ReadonlyArray<string>;
  inputSchema?: DefinitionSchema<unknown, TInput>;
  outputSchema?: DefinitionSchema<unknown, TOutput>;
  execute: ActivityFunction<TInput, TOutput>;
  retry?: RetryPolicy;
  timeout?: Duration;
  queue?: string;
  idempotent?: boolean;
}
```

`inputSchema` and `outputSchema` are definition metadata, not automatic execution validators.

### `ActivityMetadata`

Name-based metadata stored by `ActivityRegistry` and returned from engine activity introspection.

```ts partial
interface ActivityMetadata {
  name: string;
  queue: string;
  description?: string;
  tags?: ReadonlyArray<string>;
  inputSchema?: DefinitionSchema;
  outputSchema?: DefinitionSchema;
  retry?: RetryPolicy;
  timeout?: Duration;
  idempotent?: boolean;
}
```

Returned activity metadata is name-based. Aliases are reported separately even when they point at the same function.

### `ActivityRegistrationOptions`

Explicit metadata overrides for `engine.registerActivity()` and `ActivityRegistry.register()`.

```ts partial
interface ActivityRegistrationOptions {
  queue?: string;
  description?: string;
  tags?: ReadonlyArray<string>;
  inputSchema?: DefinitionSchema;
  outputSchema?: DefinitionSchema;
  retry?: RetryPolicy;
  timeout?: Duration;
  idempotent?: boolean;
}
```

### `ActivityCallOptions`

Per-invocation options when calling an activity from a workflow.

```ts partial
interface ActivityCallOptions {
  timeout?: Duration;
  queue?: string;
  retry?: Partial<RetryPolicy>;
  idempotencyKey?: string;
  sticky?: boolean;
}
```

### `EngineOptions`

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

See [Configuration](./configuration.md) for detailed field descriptions and defaults.

### `StartOptions`

```ts partial
interface StartOptions {
  id?: string;
  idempotencyKey?: string;
  executionTimeout?: Duration;
  searchAttributes?: Record<string, SearchAttributeValue>;
}
```

### `Serializer`

Pluggable serialization interface.

```ts partial
interface Serializer {
  serialize(value: unknown): Uint8Array;
  deserialize(bytes: Uint8Array): unknown;
}
```

### `SearchAttributeValue`

```ts partial
type SearchAttributeValue = string | number | boolean | Date | string[];
```

### `SearchAttributeSchema`

```ts partial
type SearchAttributeSchema = Record<string, SearchAttributeDefinition>;

interface SearchAttributeDefinition {
  type: 'string' | 'number' | 'boolean' | 'datetime' | 'keyword_list';
}
```

### `ListFilter`

```ts partial
interface ListFilter {
  status?: WorkflowStatus | WorkflowStatus[];
  type?: string;
  attributes?: AttributeFilter[];
  limit?: number;
  offset?: number;
}

interface AttributeFilter {
  key: string;
  value?: SearchAttributeValue;
  gt?: SearchAttributeValue;
  lt?: SearchAttributeValue;
  gte?: SearchAttributeValue;
  lte?: SearchAttributeValue;
}
```

### `PaginatedResult`

```ts partial
interface PaginatedResult<T> {
  items: T[];
  total: number;
  offset: number;
  limit: number;
}
```

### `WorkflowSummary`

Returned by `engine.list()`.

```ts partial
interface WorkflowSummary {
  id: WorkflowId;
  type: string;
  status: WorkflowStatus;
  version: string;
  createdAt: number;
  updatedAt: number;
  tags?: string[];
}
```

---

## Event Types

### `WeftEventMap`

Maps event type strings to their corresponding event classes.

```ts partial
interface WeftEventMap {
  'workflow:started': WorkflowStartedEvent;
  'workflow:completed': WorkflowCompletedEvent;
  'workflow:failed': WorkflowFailedEvent;
  'workflow:cancelled': WorkflowCancelledEvent;
  'workflow:timed-out': WorkflowTimedOutEvent;
  'workflow:resumed': WorkflowResumedEvent;
  'activity:started': ActivityStartedEvent;
  'activity:completed': ActivityCompletedEvent;
  'activity:failed': ActivityFailedEvent;
  'agent:token': TokenEvent;
  'signal:received': SignalReceivedEvent;
  'signal:delivered': SignalDeliveredEvent;
  'attributes:changed': AttributesChangedEvent;
  'update:received': UpdateReceivedEvent;
  'update:completed': UpdateCompletedEvent;
  'checkpoint:size-warning': CheckpointSizeWarningEvent;
  'development:warning': DevelopmentWarningEvent;
  'storage:size-reported': StorageSizeReportedEvent;
  'alert:fired': AlertFiredEvent;
  'alert:resolved': AlertResolvedEvent;
  'constraint:violated': ConstraintViolatedEvent;
}
```

### `TypedEventTarget`

A type-safe overlay for `EventTarget` that narrows listener signatures based on event type.

```ts partial
interface TypedEventTarget<TEventMap extends Record<string, Event>> {
  addEventListener<K extends keyof TEventMap & string>(
    type: K,
    listener: (event: TEventMap[K]) => void,
    options?: boolean | AddEventListenerOptions,
  ): void;
  removeEventListener<K extends keyof TEventMap & string>(
    type: K,
    listener: (event: TEventMap[K]) => void,
    options?: boolean | EventListenerOptions,
  ): void;
}
```

---

## Context Types

### `ContextOperationRequest`

Discriminated union of all operation descriptors yielded by `Context` methods. The engine inspects the `type` field to decide what to execute.

```ts partial
type ContextOperationRequest =
  | {
      type: 'activity';
      operationId: string;
      activityName: string;
      fn: Function;
      args: unknown[];
      callerStack?: string;
      options?: Record<string, unknown>;
    }
  | { type: 'sleep'; operationId: string; duration: number; scheduledFireAt: number }
  | { type: 'wait-signal'; operationId: string; signalName: string }
  | { type: 'wait-update'; operationId: string; updateName: string }
  | { type: 'parallel'; operationId: string; operations: ContextOperationRequest[] }
  | { type: 'race'; operationId: string; operations: ContextOperationRequest[] }
  | { type: 'memo'; operationId: string; key: string; fn: () => unknown }
  | {
      type: 'child-workflow';
      operationId: string;
      workflowType: string;
      input: unknown;
      options?: Record<string, unknown>;
    }
  | { type: 'offload'; operationId: string; key: string; fn: () => Promise<unknown> }
  | { type: 'load'; operationId: string; reference: OffloadReference }
  | { type: 'archive'; operationId: string; key: string; data: unknown }
  | { type: 'run-all'; operationId: string; branches: Record<string, [Function, ...unknown[]]> }
  | { type: 'agent'; operationId: string; options: AgentContextOptions };
```

### `ContextOptions`

Options passed to construct a `Context` instance (internal).

```ts partial
interface ContextOptions {
  workflowId: string;
  workflowType: string;
  startedAt: number;
  abortController: AbortController;
  deadline?: number;
  initialStep?: number;
  accumulatedResults?: Map<number, unknown>;
  searchAttributes?: Record<string, SearchAttributeValue>;
  getNow?: () => number;
}
```

### `OffloadReference`

Returned by `ctx.offload()`, consumed by `ctx.load()`.

```ts partial
interface OffloadReference {
  key: string;
  workflowId: string;
  sizeBytes: number;
}
```

---

## Interceptor Types

### `WorkflowInterceptor`

```ts partial
interface WorkflowInterceptor {
  activity?(
    interception: ActivityInterception,
    next: (interception: ActivityInterception) => Generator<unknown, unknown, unknown>,
  ): Generator<unknown, unknown, unknown>;

  sleep?(
    interception: SleepInterception,
    next: (interception: SleepInterception) => Generator<unknown, void, unknown>,
  ): Generator<unknown, void, unknown>;

  waitForSignal?(
    interception: SignalInterception,
    next: (interception: SignalInterception) => Generator<unknown, unknown, unknown>,
  ): Generator<unknown, unknown, unknown>;

  workflowStart?(
    interception: WorkflowStartInterception,
    next: (interception: WorkflowStartInterception) => void,
  ): void;
}
```

### `ActivityInterceptor`

```ts partial
interface ActivityInterceptor {
  execute?(
    interception: ActivityExecutionInterception,
    next: (interception: ActivityExecutionInterception) => Promise<unknown>,
  ): Promise<unknown>;
}
```

### `WorkflowStartInterception`

```ts partial
interface WorkflowStartInterception {
  workflowId: string;
  workflowType: string;
  input: unknown;
  headers: Map<string, string>;
}
```

### `ActivityInterception`

```ts partial
interface ActivityInterception {
  activityName: string;
  input: unknown;
  attempt: number;
  headers: Map<string, string>;
}
```

### `SleepInterception`

```ts partial
interface SleepInterception {
  duration: number;
  headers: Map<string, string>;
}
```

### `SignalInterception`

```ts partial
interface SignalInterception {
  signalName: string;
  payload: unknown;
  headers: Map<string, string>;
}
```

### `ActivityExecutionInterception`

```ts partial
interface ActivityExecutionInterception {
  activityName: string;
  input: unknown;
  attempt: number;
  headers: Map<string, string>;
}
```

---

## Storage Types

### `Storage`

KV-oriented storage interface. All storage adapters (`MemoryStorage`, `BunSQLiteStorage`) implement this.

```ts partial
interface Storage extends Disposable {
  get(key: string): Promise<Uint8Array | null>;
  put(key: string, value: Uint8Array): Promise<void>;
  delete(key: string): Promise<void>;
  scan(prefix: string, options?: ScanOptions): AsyncIterable<[string, Uint8Array]>;
  batch(operations: BatchOperation[]): Promise<void>;
  query?<T>(sql: string, params?: unknown[]): Promise<T[]>;
}
```

### `BatchOperation`

```ts partial
type BatchOperation =
  | { type: 'put'; key: string; value: Uint8Array }
  | { type: 'delete'; key: string };
```

### `ScanOptions`

```ts partial
interface ScanOptions {
  limit?: number;
  reverse?: boolean;
  gt?: string;
  lt?: string;
  gte?: string;
  lte?: string;
}
```

---

## Server Types

### `ServeOptions`

```ts partial
interface ServeOptions {
  engine: Engine;
  port?: number;
  hostname?: string;
}
```

### `WeftServer`

```ts partial
interface WeftServer extends AsyncDisposable {
  readonly port: number;
  readonly hostname: string;
  readonly url: string;
  stop(): Promise<void>;
}
```

---

## Testing Types

### `MockHandle`

```ts partial
interface MockHandle<TArgs extends unknown[], TResult> {
  readonly calls: ReadonlyArray<MockCall<TArgs, TResult>>;
  readonly callCount: number;
  readonly lastCall: MockCall<TArgs, TResult> | undefined;
  mockImplementation(implementation: (...args: TArgs) => TResult | Promise<TResult>): void;
  mockReturnValueOnce(value: TResult): MockHandle<TArgs, TResult>;
  mockRejectionOnce(error: Error): MockHandle<TArgs, TResult>;
  resetCalls(): void;
  restore(): void;
}
```

### `MockCall`

```ts partial
interface MockCall<TArgs extends unknown[], TResult> {
  readonly args: TArgs;
  readonly result: TResult | undefined;
  readonly error: Error | undefined;
  readonly timestamp: number;
}
```

---

## AI Types

### `AgentOptions`

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

### `AgentResult`

```ts partial
interface AgentResult {
  content: string;
  conversation: Message[];
  totalTokens: TokenUsage;
  turnCount: number;
  reasoningTraces: string[];
  turnUsage: TurnUsageEntry[];
}

type TurnUsageEntry =
  | {
      turnNumber: number;
      source: 'provider';
      inputTokens: number;
      outputTokens: number;
    }
  | {
      turnNumber: number;
      source: 'unavailable';
      inputTokens: null;
      outputTokens: null;
    };
```

### `AgentTool`

```ts partial
interface AgentTool {
  definition: ToolDefinition;
  execute: (input: unknown) => Promise<unknown>;
  verify?: (result: unknown) => boolean | Promise<boolean>;
  identity?: (input: unknown) => ToolIdentityResult;
}
```

### `AgentDefinition`

```ts partial
interface AgentDefinition<TInput = unknown, TOutput = unknown> {
  name: string;
  model: string;
  version?: string;
  systemPrompt?: string;
  tools?: AgentToolDefinition[];
  maxTurns?: number;
  description?: string;
}
```

### `AgentToolDefinition`

```ts partial
interface AgentToolDefinition {
  definition: ToolDefinition;
  execute: (input: unknown) => Promise<unknown>;
  verify?: (result: unknown) => boolean | Promise<boolean>;
  version?: string;
  identity?: (input: unknown) => ToolIdentityResult;
}
```

### `ToolIdentityResult`

```ts partial
interface ToolIdentityResult {
  semanticHash: string;
  intentCriticalFields: string[];
}
```

### `LLMProvider`

```ts partial
interface LLMProvider {
  readonly name: string;
  chat(messages: Message[], options: ChatOptions): Promise<ChatResponse>;
  createChatResumeHint?(
    messages: Message[],
    options: ChatOptions,
  ): Promise<ChatResumeHint | undefined>;
  warmup?(): Promise<void>;
}
```

### `ChatOptions`

```ts partial
interface ChatOptions {
  model: string;
  tools?: ToolDefinition[];
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
  systemPrompt?: string;
  turnIndex?: number;
  resumeContext?: ChatResumeContext;
}
```

### `ChatResponse`

```ts partial
interface ChatResponse {
  content: string;
  toolCalls: ToolCall[];
  usage: TokenUsage;
  model: string;
  stopReason: 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence';
  reasoningTrace?: string;
}
```

### `Message`

```ts partial
interface Message {
  role: MessageRole;
  content: string;
  toolCalls?: ToolCall[];
  toolResults?: ToolResult[];
  name?: string;
}

type MessageRole = 'system' | 'user' | 'assistant' | 'tool';
```

### `ToolCall`

```ts partial
interface ToolCall {
  id: string;
  name: string;
  input: unknown;
}
```

### `ToolResult`

```ts partial
interface ToolResult {
  toolCallId: string;
  output: string;
  isError?: boolean;
}
```

### `ToolDefinition`

```ts partial
interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}
```

### `TokenUsage`

```ts partial
interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}
```
