# Agent API Reference

The agent module implements a durable ReAct loop. Weft drives provider turns, checkpoints at tool-call boundaries, and records committed tool effects so recovery does not duplicate side effects.

For guided documentation, start with the [agent overview](../agents/agent-overview.md).

## Agent Loop

### `executeAgentLoop(options, input)`

Drives a multi-turn conversation where the model can call tools, receive results, and continue until it returns a final answer or reaches `maxTurns`.

```ts partial
function executeAgentLoop(options: AgentOptions, input: string): Promise<AgentResult>;
```

Exit conditions:

- `signal` is aborted
- `maxTurns` is reached
- the provider returns a response with no tool calls

### `AgentLoopSuspendedError`

Thrown internally when the provider supplies a resume hint and the loop suspends until an external signal provides the matching resume payload.

## Agent Options

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

| Field                            | Description                                          |
| -------------------------------- | ---------------------------------------------------- |
| `model`                          | Model identifier passed to the provider              |
| `provider`                       | Structural provider with a required `chat()` method  |
| `systemPrompt`                   | Optional system message for the provider             |
| `tools`                          | Plain `AgentTool` array available to the model       |
| `maxTurns`                       | Maximum provider turns before returning              |
| `signal`                         | Cancellation signal                                  |
| `eventTarget`                    | Target for agent events                              |
| `workflowId`                     | Workflow identifier for event correlation            |
| `agentId`                        | Agent identifier for event correlation               |
| `toolEffectLog`                  | Durable effect log for tool-call deduplication       |
| `verificationRecorder`           | Internal verification sink for speculative execution |
| `checkpointSizeWarningThreshold` | Conversation snapshot warning threshold in bytes     |

## Agent Result

```ts partial
interface AgentResult {
  content: string;
  conversation: ConversationHistory;
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

`turnUsage` records provider-reported token usage. The built-in loop records `source: 'provider'`; the `source: 'unavailable'` variant exists for downstream wrappers or aggregators that need to represent turns without usage data.

## Declaration

### `agent(options)`

Declares a reusable agent definition.

```ts partial
function agent<TInput = unknown, TOutput = unknown>(
  options: AgentDefinitionOptions<TInput, TOutput>,
): AgentDefinition<TInput, TOutput>;
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

The runtime value also carries internal brand and phantom type fields.

### `AgentToolDefinition`

```ts partial
interface AgentToolDefinition {
  name: string;
  description?: string;
  input: unknown;
  execute: (input: unknown) => Promise<unknown>;
  verify?: (result: unknown) => Promise<boolean> | boolean;
  version?: string;
  identity?:
    | ((input: unknown) => ToolIdentityResult)
    | { namespace: string; name: string; version?: string };
}
```

## Tools

### `AgentTool`

```ts partial
interface AgentTool {
  name: string;
  description?: string;
  input: unknown;
  execute: (input: unknown) => Promise<unknown>;
  verify?: (result: unknown) => Promise<boolean> | boolean;
  identity?:
    | ((input: unknown) => ToolIdentityResult)
    | { namespace: string; name: string; version?: string };
}
```

### `ToolIdentityResult`

```ts partial
interface ToolIdentityResult {
  semanticHash: string;
  intentCriticalFields: string[];
}
```

### `computeSemanticHash(input)`

Computes a stable semantic hash for the input fields that determine a tool call's observable effect.

```ts partial
function computeSemanticHash(input: unknown): string;
```

### `ToolEffectLog`

Records committed tool results and replays them on recovery when a provider emits the same semantic tool call again.

```ts partial
class ToolEffectLog {
  constructor(storage: WeftStorage, workflowId: string);
}
```

## Provider Types

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

Only `chat()` is required.

### `ChatOptions`

```ts partial
interface ChatOptions {
  model: string;
  tools?: ToolDescriptor[];
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
  toolCalls: ToolCallInput[];
  usage: TokenUsage;
  model: string;
  stopReason: 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence';
  reasoningTrace?: string;
}
```

### `Message`

```ts partial
interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  toolCalls?: ToolCall[];
  toolResults?: ToolResult[];
  name?: string;
}
```

### `ToolCall`

```ts partial
interface ToolCall {
  id: string;
  name: string;
  arguments: JSONValue;
}
```

### `ToolResult`

```ts partial
interface ToolResult {
  callId: string;
  outcome: 'success' | 'error' | 'action_required';
  content: JSONValue;
  error?: ToolErrorShape;
  action?: ToolActionShape;
  inputDigest?: string;
  outputDigest?: string;
}
```

### `ToolDescriptor`

```ts partial
interface ToolDescriptor<InputSchema = unknown> {
  name: string;
  description?: string;
  input: InputSchema;
}
```

## Coordination

### `handoff(options)`

Runs one agent after another and optionally forwards conversation context.

```ts partial
function handoff(options: HandoffOptions): Promise<HandoffResult>;
```

### `debate(options)`

Runs advocate and critic agents for a fixed number of rounds, then asks a judge agent to decide.

```ts partial
function debate(options: DebateOptions): Promise<DebateResult>;
```

### `supervise(options)`

Runs worker agents in parallel and asks a supervisor agent to synthesize their outputs.

```ts partial
function supervise(options: SuperviseOptions): Promise<SuperviseResult>;
```

## Human Review

### `ReviewCoordinator`

Persists review requests and decisions so a workflow can pause for a human decision and resume durably.

```ts partial
class ReviewCoordinator {
  constructor(storage: WeftStorage, options?: ReviewCoordinatorOptions);
}
```

### `ReviewOptions`

```ts partial
interface ReviewOptions {
  type: string;
  reviewers: string[];
  timeout?: number;
  escalation?: EscalationStep[];
}
```

## Events

Agent events are documented in [Agent Observability](../agents/agent-observability.md) and the [Events API reference](./api-events.md).
