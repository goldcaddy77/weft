# Agent API Reference

The agent module implements a durable ReAct loop that orchestrates multi-turn LLM conversations with tool use, budget enforcement, context window management, and multi-agent coordination. It is the largest surface in Weft's AI layer.

For a guided walkthrough, see the [Agent guide](../guides/agent-loop.md).

---

## Agent Loop

### `executeAgentLoop(options, input)`

The primary entry point. Drives a multi-turn conversation where the model can invoke tools, receive results, and continue reasoning until it produces a final answer or an exit condition is reached.

```ts
async function executeAgentLoop(options: AgentOptions, input: string): Promise<AgentResult>;
```

**Exit conditions** (checked each turn, in order):

1. `signal` is aborted
2. `budget` is exhausted (`BudgetExceededError`)
3. `maxTurns` reached
4. Model returns a response with zero tool calls (final answer)

#### `AgentOptions`

| Field             | Type                               | Default     | Description                                           |
| ----------------- | ---------------------------------- | ----------- | ----------------------------------------------------- |
| `model`           | `string`                           | --          | Model identifier passed to the provider               |
| `provider`        | `LLMProvider`                      | --          | LLM provider instance                                 |
| `systemPrompt`    | `string`                           | `undefined` | Optional system message prepended to the conversation |
| `tools`           | `(AgentTool \| MCPToolSource)[]`   | `[]`        | Tools available to the model                          |
| `maxTurns`        | `number`                           | `10`        | Maximum LLM turns before returning                    |
| `budget`          | `BudgetTracker`                    | `undefined` | Optional budget tracker for token/cost limits         |
| `modelRouter`     | `ModelRouter`                      | `undefined` | Optional per-turn model selection                     |
| `contextManager`  | `ContextWindowManager`             | `undefined` | Optional context compaction                           |
| `healthTracker`   | `ProviderHealthTracker`            | `undefined` | Optional circuit-breaker health tracking              |
| `toolCacheTTL`    | `number`                           | `300_000`   | Tool result cache TTL in milliseconds (5 minutes)     |
| `signal`          | `AbortSignal`                      | `undefined` | Cancellation signal                                   |
| `hooks`           | `AgentHooks`                       | `undefined` | Lifecycle hooks                                       |
| `eventTarget`     | `EventTarget`                      | `undefined` | Target for dispatching agent events                   |
| `workflowId`      | `string`                           | `undefined` | Workflow ID for event correlation                     |
| `agentId`         | `string`                           | `undefined` | Agent ID for event correlation                        |
| `onTurnStarted`   | `(turn: TurnInfo) => void`         | `undefined` | Callback before each LLM call                         |
| `onTurnCompleted` | `(turn: TurnResult) => void`       | `undefined` | Callback after each LLM call                          |
| `onToolCalled`    | `(call: ToolCallInfo) => void`     | `undefined` | Callback when a tool is invoked                       |
| `onToolReturned`  | `(result: ToolReturnInfo) => void` | `undefined` | Callback when a tool returns                          |

#### `AgentTool`

```ts
interface AgentTool {
  definition: ToolDefinition;
  execute: (input: unknown) => Promise<unknown>;
  verify?: (input: unknown, result: unknown) => boolean | Promise<boolean>;
  identity?: (input: unknown) => ToolIdentityResult;
}
```

`verify` is called after `execute` to validate the result. `identity` returns a cache key for deduplication.

#### `AgentResult`

```ts
interface AgentResult {
  content: string;
  conversation: Message[];
  totalTokens: TokenUsage;
  totalCost: number;
  turnCount: number;
  reasoningTraces: string[];
  turnCosts: TurnCostEntry[];
  confidence?: number;
}

interface TurnCostEntry {
  turnIndex: number;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cost: number;
}
```

#### Callback Types

```ts
interface TurnInfo {
  turnIndex: number;
  model: string;
  conversationLength: number;
}

interface TurnResult {
  turnIndex: number;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cost: number;
  duration: number;
  toolCallCount: number;
}

interface ToolCallInfo {
  turnIndex: number;
  toolName: string;
  toolInput: unknown;
}

interface ToolReturnInfo {
  turnIndex: number;
  toolName: string;
  duration: number;
  success: boolean;
}
```

**Example:**

```ts
import { executeAgentLoop } from 'weft';

const result = await executeAgentLoop(
  {
    model: 'claude-sonnet-4-5-20250929',
    provider: anthropicProvider,
    systemPrompt: 'You are a helpful assistant.',
    tools: [searchTool, calculatorTool],
    maxTurns: 5,
  },
  'What is the population of Tokyo?',
);

console.log(result.content);
console.log(`Used ${result.totalTokens.totalTokens} tokens over ${result.turnCount} turns`);
```

---

## Declaration

### `defineAgent(options)`

Declares a reusable agent definition. Returns an `AgentDefinition` object that can be passed to coordination functions or used as a template.

```ts
function defineAgent<TInput = unknown, TOutput = unknown>(
  options: AgentDefinitionOptions<TInput, TOutput>,
): AgentDefinition<TInput, TOutput>;
```

#### `AgentDefinition`

```ts
interface AgentDefinition<TInput = unknown, TOutput = unknown> {
  name: string;
  model: string;
  systemPrompt?: string;
  tools?: AgentToolDefinition[];
  maxTurns?: number;
  budget?: BudgetOptions;
  modelRouter?: ModelRouter;
  contextStrategy?: ContextStrategy;
  hooks?: AgentHooks;
  description?: string;
}
```

#### `AgentToolDefinition`

```ts
interface AgentToolDefinition {
  definition: ToolDefinition;
  execute: (input: unknown) => Promise<unknown>;
}
```

**Example:**

```ts
import { defineAgent } from 'weft';

const researcher = defineAgent({
  name: 'researcher',
  model: 'claude-sonnet-4-5-20250929',
  systemPrompt: 'You are a research assistant. Find and summarize information.',
  tools: [webSearchTool],
  maxTurns: 8,
});
```

---

## Hooks

### `AgentHooks`

Lifecycle hooks that run at specific points in the agent loop. All hooks may be synchronous or async.

```ts
interface AgentHooks {
  beforeTurn?: (context: BeforeTurnContext) => BeforeTurnResult | Promise<BeforeTurnResult>;
  afterToolCall?: (
    context: AfterToolCallContext,
  ) => AfterToolCallResult | Promise<AfterToolCallResult>;
  onBudgetWarning?: (context: BudgetWarningContext) => void | Promise<void>;
}
```

#### `BeforeTurnContext` / `BeforeTurnResult`

```ts
interface BeforeTurnContext {
  turnIndex: number;
  messages: Message[];
  model: string;
}

type BeforeTurnResult =
  | { action: 'continue'; messages?: Message[] }
  | { action: 'skip'; result?: string };
```

Returning `{ action: 'skip', result: 'cached answer' }` short-circuits the turn and uses the provided result as the final content.

#### `AfterToolCallContext` / `AfterToolCallResult`

```ts
interface AfterToolCallContext {
  turnIndex: number;
  toolCall: ToolCall;
  result: unknown;
}

type AfterToolCallResult =
  | { action: 'continue'; result?: unknown }
  | { action: 'reject'; reason: string };
```

Returning `{ action: 'reject', reason: '...' }` replaces the tool output with an error message.

#### `BudgetWarningContext`

```ts
interface BudgetWarningContext {
  tokensRemaining: number;
  costRemaining: number;
  budgetUsedPercent: number;
}
```

---

## Budget

### `BudgetTracker`

Tracks LLM token usage and cost against configurable budgets. Fires warning and exceeded callbacks, and optionally aborts an `AbortController` when the budget is exceeded.

```ts
class BudgetTracker {
  constructor(options: BudgetOptions, callbacks?: BudgetCallbacks);

  recordUsage(model: string, inputTokens: number, outputTokens: number): boolean;
  budgetRemaining(): BudgetState;
  checkBudget(): void;
  budgetProjection(): { estimatedTurnsRemaining: number; estimatedCostAtCompletion: number };

  get signal(): AbortSignal | undefined;
  setAbortController(controller: AbortController): void;

  toJSON(): SerializedBudgetState;
  static fromJSON(
    data: SerializedBudgetState,
    options: BudgetOptions,
    callbacks?: BudgetCallbacks,
  ): BudgetTracker;
}
```

| Method                                          | Returns                                                  | Description                                                   |
| ----------------------------------------------- | -------------------------------------------------------- | ------------------------------------------------------------- |
| `recordUsage(model, inputTokens, outputTokens)` | `boolean`                                                | Record token usage. Returns `true` if budget still available. |
| `budgetRemaining()`                             | `BudgetState`                                            | Get remaining budget state with per-model breakdown.          |
| `checkBudget()`                                 | `void`                                                   | Throws `BudgetExceededError` if budget is exhausted.          |
| `budgetProjection()`                            | `{ estimatedTurnsRemaining, estimatedCostAtCompletion }` | Project remaining capacity based on average burn rate.        |
| `setAbortController(controller)`                | `void`                                                   | Attach an `AbortController` that aborts when budget exceeds.  |
| `toJSON()`                                      | `SerializedBudgetState`                                  | Serialize for checkpointing.                                  |
| `fromJSON(data, options, callbacks)`            | `BudgetTracker`                                          | Restore from checkpoint.                                      |

#### `BudgetOptions`

```ts
interface BudgetOptions {
  maxTokens?: number;
  maxCost?: number;
  warningThreshold?: number; // fraction 0-1, default 0.8
  models: Record<string, ModelPricing>;
}

interface ModelPricing {
  inputCostPer1K: number;
  outputCostPer1K: number;
}
```

#### `BudgetState`

```ts
interface BudgetState {
  tokensUsed: number;
  costUsed: number;
  tokensRemaining: number;
  costRemaining: number;
  breakdown: ModelUsageEntry[];
}

interface ModelUsageEntry {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cost: number;
}
```

### `BudgetExceededError`

```ts
class BudgetExceededError extends Error {
  readonly tokensUsed: number;
  readonly costUsed: number;
  readonly maxTokens: number | undefined;
  readonly maxCost: number | undefined;
}
```

---

## Context Window

### `ContextWindowManager`

Manages conversation context size by applying compaction strategies when token count exceeds a threshold.

```ts
class ContextWindowManager {
  constructor(options: ContextWindowOptions);

  shouldCompact(tokenCount: number): boolean;
  async compact(messages: Message[]): Promise<{
    messages: Message[];
    tokensBefore: number;
    tokensAfter: number;
    messagesDropped: number;
  }>;

  get inputBudget(): number;
}
```

#### `ContextWindowOptions`

| Field               | Type                                       | Default              | Description                                            |
| ------------------- | ------------------------------------------ | -------------------- | ------------------------------------------------------ |
| `maxTokens`         | `number`                                   | --                   | Maximum total token budget                             |
| `reservedForOutput` | `number`                                   | `maxTokens * 0.25`   | Tokens reserved for model output                       |
| `compactAt`         | `number`                                   | `0.85`               | Fraction of `inputBudget` at which compaction triggers |
| `strategy`          | `ContextStrategy`                          | `noopStrategy()`     | Compaction strategy                                    |
| `countTokens`       | `(messages: Message[]) => Promise<number>` | character/4 estimate | Token counting function                                |

### `ContextStrategy`

Interface for pluggable compaction strategies.

```ts
interface ContextStrategy {
  compact(
    messages: Message[],
    options: CompactOptions,
  ): AsyncGenerator<Message[], Message[], unknown>;
}

interface CompactOptions {
  maxTokens: number;
  reservedForOutput: number;
  currentTokenCount: number;
}
```

### `composeStrategies(...strategies)`

Compose multiple strategies in sequence.

```ts
function composeStrategies(...strategies: ContextStrategy[]): ContextStrategy;
```

### `noopStrategy()`

A pass-through strategy that returns messages unchanged. This is the default.

```ts
function noopStrategy(): ContextStrategy;
```

### `slidingWindowStrategy(options?)`

Keeps the system message and the most recent N messages, dropping older conversation history.

```ts
function slidingWindowStrategy(options?: SlidingWindowOptions): ContextStrategy;
```

#### `SlidingWindowOptions`

| Field                   | Type      | Default | Description                             |
| ----------------------- | --------- | ------- | --------------------------------------- |
| `preserveSystemMessage` | `boolean` | `true`  | Keep the system message when compacting |
| `preserveRecentCount`   | `number`  | `10`    | Number of recent messages to preserve   |

---

## Coordination

Multi-agent coordination primitives for sequential handoffs, adversarial debates, and supervised parallel work.

### `handoff(options)`

Hand off execution to another agent, optionally forwarding conversation context.

```ts
async function handoff(options: HandoffOptions): Promise<HandoffResult>;
```

#### `HandoffOptions`

| Field                | Type              | Default  | Description                           |
| -------------------- | ----------------- | -------- | ------------------------------------- |
| `agent`              | `AgentDefinition` | --       | Target agent definition               |
| `input`              | `string`          | --       | Task description for the target agent |
| `provider`           | `LLMProvider`     | --       | LLM provider instance                 |
| `forwardContext`     | `ForwardContext`  | `'none'` | How to forward parent conversation    |
| `parentConversation` | `Message[]`       | `[]`     | Parent conversation to forward        |

`ForwardContext` is `'full' | 'summary' | 'none'`.

#### `HandoffResult`

```ts
interface HandoffResult {
  result: AgentResult;
  contextForwarded: ForwardContext;
}
```

### `debate(options)`

Run an adversarial multi-agent debate with advocate, critic, and judge roles.

```ts
async function debate(options: DebateOptions): Promise<DebateResult>;
```

#### `DebateOptions`

| Field      | Type              | Description                           |
| ---------- | ----------------- | ------------------------------------- |
| `advocate` | `AgentDefinition` | Agent that argues in favor            |
| `critic`   | `AgentDefinition` | Agent that critiques                  |
| `judge`    | `AgentDefinition` | Agent that renders a verdict          |
| `topic`    | `string`          | Debate topic                          |
| `rounds`   | `number`          | Advocate-critic rounds before verdict |
| `provider` | `LLMProvider`     | LLM provider instance                 |

#### `DebateResult`

```ts
interface DebateResult {
  verdict: string;
  rounds: DebateRound[];
  judgeResult: AgentResult;
}

interface DebateRound {
  roundIndex: number;
  advocateResponse: string;
  criticResponse: string;
}
```

### `supervise(options)`

Run supervised multi-agent execution where multiple workers process the same input, then a supervisor synthesizes results.

```ts
async function supervise(options: SuperviseOptions): Promise<SuperviseResult>;
```

#### `SuperviseOptions`

| Field        | Type                                    | Description                                      |
| ------------ | --------------------------------------- | ------------------------------------------------ |
| `workers`    | `AgentDefinition[]`                     | Worker agents that process the input in parallel |
| `supervisor` | `AgentDefinition`                       | Supervisor agent that synthesizes results        |
| `input`      | `string`                                | Input to process                                 |
| `strategy`   | `'consensus' \| 'best-of-n' \| 'merge'` | Synthesis strategy                               |
| `provider`   | `LLMProvider`                           | LLM provider instance                            |

- **`consensus`** -- If all workers agree, use the shared response. Otherwise, ask the supervisor to resolve.
- **`best-of-n`** -- The supervisor picks the best worker response.
- **`merge`** -- The supervisor merges all worker responses into a comprehensive answer.

#### `SuperviseResult`

```ts
interface SuperviseResult {
  finalResult: string;
  workerResults: AgentResult[];
  strategy: string;
}
```

---

## Human Review

### `ReviewCoordinator`

Coordinates human-in-the-loop review requests, decisions, and escalation chains.

```ts
class ReviewCoordinator {
  constructor(storage: Storage, options?: ReviewCoordinatorOptions);

  async createReview(workflowId: string, options: ReviewOptions): Promise<ReviewRequest>;
  async submitDecision(
    reviewId: string,
    decision: Omit<ReviewDecision, 'reviewId' | 'timestamp'>,
  ): Promise<ReviewDecision>;
  async getReview(workflowId: string, reviewId: string): Promise<ReviewRequest | null>;
  async listPendingReviews(): Promise<ReviewRequest[]>;
  cleanupOperations(workflowId: string, reviewId: string): BatchOperation[];
  checkEscalations(
    review: ReviewRequest,
    escalation: EscalationStep[],
    now: number,
  ): EscalationAction | null;
}
```

See source for `ReviewCoordinatorOptions` fields (escalation defaults, webhook configuration).

#### `ReviewOptions`

| Field          | Type               | Default     | Description                            |
| -------------- | ------------------ | ----------- | -------------------------------------- |
| `artifact`     | `unknown`          | --          | The artifact to review                 |
| `reviewType`   | `string`           | `'general'` | Review type label                      |
| `reviewers`    | `string[]`         | `[]`        | Designated reviewers                   |
| `allowPartial` | `boolean`          | `false`     | Allow partial (section-level) approval |
| `timeout`      | `number`           | `undefined` | Review timeout in ms                   |
| `escalation`   | `EscalationStep[]` | `undefined` | Escalation chain                       |
| `webhookUrl`   | `string`           | `undefined` | Webhook for notifications              |

#### `ReviewRequest`

```ts
interface ReviewRequest {
  reviewId: string;
  workflowId: string;
  artifact: unknown;
  reviewType: string;
  reviewers: string[];
  allowPartial: boolean;
  timeout?: number;
  webhookUrl?: string;
  createdAt: number;
}
```

#### `ReviewDecision`

```ts
interface ReviewDecision {
  reviewId: string;
  decision: 'approved' | 'rejected' | 'needs-changes';
  reviewer: string;
  feedback?: string;
  sectionDecisions?: Record<string, 'approved' | 'rejected'>;
  timestamp: number;
}
```

#### `EscalationStep`

```ts
interface EscalationStep {
  after: number; // ms elapsed before this step triggers
  to?: string; // escalate to this reviewer
  action?: 'auto-approve' | 'auto-reject';
  auditReason?: string;
}
```

#### `EscalationAction`

```ts
type EscalationAction =
  | { type: 'escalate'; to: string }
  | { type: 'auto-decide'; decision: 'approved' | 'rejected'; auditReason: string };
```

### `ReviewTimeoutError`

```ts
class ReviewTimeoutError extends Error {
  readonly reviewId: string;
  readonly elapsed: number;
}
```

---

## Streaming

### `StreamMultiplexer`

Multiplexes a single source `ReadableStream<StreamChunk>` to multiple consumers without duplicating the source. Late consumers receive buffered chunks first.

```ts
class StreamMultiplexer {
  constructor(source: ReadableStream<StreamChunk>, options?: MultiplexerOptions);

  createConsumer(): ReadableStream<StreamChunk>;
  cancel(): void;

  get consumerCount(): number;
}
```

#### `MultiplexerOptions`

| Field           | Type     | Default | Description                                |
| --------------- | -------- | ------- | ------------------------------------------ |
| `maxBufferSize` | `number` | `1000`  | Maximum buffered chunks for late consumers |

### `TokenBridge`

Bridges a `ReadableStream<StreamChunk>` to an `EventTarget`, dispatching `TokenEvent` for each token chunk.

```ts
class TokenBridge {
  constructor(target: EventTarget, workflowId: string, model: string);

  async pipe(stream: ReadableStream<StreamChunk>): Promise<string>;
}
```

`pipe()` consumes the stream and returns the accumulated text.

### `ReconnectionBuffer`

Accumulates completed turn text for replaying to reconnecting clients.

```ts
class ReconnectionBuffer {
  constructor(options?: ReconnectionBufferOptions);

  addTurn(text: string): void;
  getTurns(): string[];
  clear(): void;

  get turnCount(): number;
}
```

#### `ReconnectionBufferOptions`

| Field      | Type     | Default | Description            |
| ---------- | -------- | ------- | ---------------------- |
| `maxTurns` | `number` | `10`    | Maximum buffered turns |

---

## MCP (Model Context Protocol)

### `MCPClient`

HTTP client for discovering and invoking tools on an MCP server.

```ts
class MCPClient {
  constructor(options: MCPClientOptions);

  async discoverTools(): Promise<ToolDefinition[]>;
  async invokeTool(toolName: string, input: unknown, signal?: AbortSignal): Promise<unknown>;
  async healthCheck(): Promise<boolean>;
}
```

#### `MCPClientOptions`

`MCPClientOptions` is a union of two forms:

**URL form:**

```ts
interface MCPClientUrlOptions {
  serverUrl: string;
  auth?: MCPAuthConfig;
  timeout?: number;
}
```

**Transport form:**

```ts
interface MCPClientTransportOptions {
  transport: MCPTransport;
  timeout?: number;
}
```

| Field       | Type            | Default     | Description                                     |
| ----------- | --------------- | ----------- | ----------------------------------------------- |
| `serverUrl` | `string`        | --          | Base URL of the MCP server (URL form only)      |
| `transport` | `MCPTransport`  | --          | Custom transport instance (transport form only) |
| `auth`      | `MCPAuthConfig` | `undefined` | Authentication configuration (URL form only)    |
| `timeout`   | `number`        | `30_000`    | Tool invocation timeout in milliseconds         |

### `MCPServerUnavailableError`

```ts
class MCPServerUnavailableError extends Error {
  readonly serverUrl: string;
}
```

### `MCPToolTimeoutError`

```ts
class MCPToolTimeoutError extends Error {
  readonly toolName: string;
  readonly timeout: number;
}
```

### `ToolRegistry`

Unified registry for local and MCP-sourced tools with conflict detection.

```ts
class ToolRegistry {
  registerLocal(definition: ToolDefinition, execute: (input: unknown) => Promise<unknown>): void;
  registerMCP(
    tools: ToolDefinition[],
    serverUrl: string,
    execute: (toolName: string, input: unknown) => Promise<unknown>,
  ): void;

  get(name: string): RegistryTool | undefined;
  getDefinitions(): ToolDefinition[];
  getAll(): RegistryTool[];
  validate(): void;

  get size(): number;
}
```

`validate()` throws `ToolNameConflictError` if the same tool name is registered from multiple sources (e.g., both local and MCP).

#### `RegistryTool`

```ts
interface RegistryTool {
  definition: ToolDefinition;
  execute: (input: unknown) => Promise<unknown>;
  source: 'local' | 'mcp';
  serverUrl?: string;
}
```

### `ToolNameConflictError`

```ts
class ToolNameConflictError extends Error {
  readonly toolName: string;
  readonly sources: string[];
}
```

### `buildAuthHeaders(auth)`

Build HTTP authentication headers from an `MCPAuthConfig`.

```ts
function buildAuthHeaders(auth: MCPAuthConfig): Record<string, string>;
```

#### `MCPAuthConfig`

```ts
type MCPAuthConfig =
  | { type: 'bearer'; token: string }
  | { type: 'api-key'; headerName: string; apiKey: string }
  | { type: 'none' };
```

### `validateSchema(value, schema)`

Minimal JSON Schema validator for tool input validation.

```ts
function validateSchema(value: unknown, schema: Record<string, unknown>): ValidationResult;
```

#### `ValidationResult`

```ts
interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
}

interface ValidationError {
  path: string;
  message: string;
  expected?: string;
  actual?: string;
}
```

### `ToolSchemaValidationError`

```ts
class ToolSchemaValidationError extends Error {
  readonly toolName: string;
  readonly errors: ValidationError[];
}
```

---

## Providers

### `LLMProvider` Interface

All LLM providers implement this interface.

```ts
interface LLMProvider {
  readonly name: string;

  chat(messages: Message[], options: ChatOptions): Promise<ChatResponse>;
  stream(messages: Message[], options: ChatOptions): Promise<ReadableStream<StreamChunk>>;
  countTokens(messages: Message[]): Promise<number>;
}
```

### `ChatOptions`

```ts
interface ChatOptions {
  model: string;
  tools?: ToolDefinition[];
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
  systemPrompt?: string;
}
```

Built-in providers: `AnthropicProvider`, `OpenAIProvider`.

---

## Model Router

### `ModelRouter` Interface

```ts
interface ModelRouter {
  select(context: RoutingContext): ModelSelection;
}
```

### `RoutingContext`

```ts
interface RoutingContext {
  workflowId: string;
  turnIndex: number;
  conversationLength: number;
  budgetRemaining?: { tokensRemaining: number; costRemaining: number };
  previousModels: string[];
  metadata?: Record<string, unknown>;
}
```

### `ModelSelection`

```ts
interface ModelSelection {
  model: string;
  fallback?: string[];
  reason?: string;
}
```

### Router Factories

#### `staticFallbackRouter(primary, fallbacks)`

Always returns the primary model with a static fallback list.

```ts
function staticFallbackRouter(primary: string, fallbacks: string[]): ModelRouter;
```

#### `costTierRouter(tiers)`

Switches models based on remaining budget. Tiers are sorted by `maxCostRemaining` descending; the first eligible tier is selected.

```ts
function costTierRouter(tiers: CostTier[]): ModelRouter;
```

```ts
interface CostTier {
  model: string;
  maxCostRemaining?: number;
  maxTokensRemaining?: number;
  fallback?: string[];
}
```

#### `abTestRouter(variants)`

Deterministic A/B routing based on workflow ID hash (FNV-1a). The same workflow ID always yields the same variant.

```ts
function abTestRouter(variants: WeightedVariant[]): ModelRouter;
```

```ts
interface WeightedVariant {
  model: string;
  weight: number; // 0-1, all weights should sum to 1
  fallback?: string[];
}
```

#### `customRouter(fn)`

Creates a router from a custom selection function.

```ts
function customRouter(fn: (context: RoutingContext) => ModelSelection): ModelRouter;
```

---

## Provider Health

### `ProviderHealthTracker`

Tracks success/failure rates per provider using a sliding time window and implements a circuit breaker that trips when the error rate exceeds a configurable threshold.

```ts
class ProviderHealthTracker {
  constructor(options?: ProviderHealthOptions);

  recordSuccess(provider: string): void;
  recordFailure(provider: string): void;
  isHealthy(provider: string): boolean;
  getState(provider: string): CircuitState;
  getErrorRate(provider: string): number;

  onStateChange?: (provider: string, from: CircuitState, to: CircuitState) => void;
}
```

#### `ProviderHealthOptions`

| Field              | Type           | Default    | Description                                      |
| ------------------ | -------------- | ---------- | ------------------------------------------------ |
| `windowDuration`   | `number`       | `60_000`   | Sliding window duration in ms                    |
| `errorThreshold`   | `number`       | `0.5`      | Error rate (0-1) at which the circuit trips      |
| `cooldownDuration` | `number`       | `30_000`   | Time in ms the circuit stays open before probing |
| `minimumRequests`  | `number`       | `5`        | Minimum requests before the circuit can trip     |
| `getNow`           | `() => number` | `Date.now` | Clock function for testing                       |

`CircuitState` is `'closed' | 'open' | 'half-open'`.
