# Agent Bureau Integration

[Agent Bureau](https://github.com/stevekinney/agent-bureau) owns the agent framework. Weft owns durable execution.

That boundary is intentional: Agent Bureau can compose richer tool policy, conversation management, and framework behavior on top of Weft without making Weft import [`armorer`](https://github.com/stevekinney/agent-bureau/tree/main/packages/armorer), [`conversationalist`](https://github.com/stevekinney/agent-bureau/tree/main/packages/conversationalist), or [`interoperability`](https://github.com/stevekinney/agent-bureau/tree/main/packages/interoperability) at runtime.

## Runtime dependency direction

Weft runtime source must not import Agent Bureau packages. Compatibility is structural:

- Weft exports `JSONValue`, `ToolCall`, `ToolResult`, `ToolDescriptor`, `ToolDefinition`, and `ConversationHistory` shapes that match the local Agent Bureau checkout.
- Agent Bureau can satisfy those contracts by shape.
- Development-only type fixtures verify compatibility against a local Agent Bureau checkout.

The compatibility gate is:

```bash
WEFT_AGENT_BUREAU_PATH=/path/to/agent-bureau bun run verify:agent-bureau
```

If `WEFT_AGENT_BUREAU_PATH` is omitted, the verifier looks for a sibling `../agent-bureau` checkout.

## Tool calls

Providers can return tool calls in the Agent Bureau-compatible input shape:

```ts partial
interface ToolCallInput {
  id?: string;
  name: string;
  arguments?: unknown;
}
```

Weft materializes each call before execution:

```ts partial
interface ToolCall {
  id: string;
  name: string;
  arguments: JSONValue;
}
```

If the provider omits `id`, Weft generates one. If `arguments` contains non-JSON values, Weft normalizes them to `JSONValue` before the value reaches local tool execution, events, conversation snapshots, or the effect log.

## Tool results

Tool execution results use Agent Bureau's field names:

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

`callId` matches `ToolCall.id`. `content` preserves structured JSON results, so a tool returning `{ value: 42 }` stays an object through effect-log commit and replay.

Error results are also normalized into that same shape:

```ts partial
interface ToolErrorShape {
  code: string;
  category:
    | 'validation'
    | 'permission'
    | 'not_found'
    | 'conflict'
    | 'transient'
    | 'timeout'
    | 'cancelled'
    | 'internal';
  retryable: boolean;
  message: string;
  details?: JSONValue;
}
```

## Executable tools

The documented Weft tool shape is flat:

```ts partial
interface ToolDefinition<InputSchema = unknown> {
  name: string;
  description?: string;
  input: InputSchema;
  execute: (input: unknown, context?: unknown) => Promise<unknown>;
  verify?: (result: unknown) => boolean | Promise<boolean>;
  identity?:
    | ((input: unknown) => ToolIdentityResult)
    | { namespace: string; name: string; version?: string };
  version?: string;
}
```

That shape is compatible with Armorer executable tool configurations by structure. The agent runtime still accepts the older nested Weft-local shape internally so existing local tools keep running, but new documentation and examples should use the flat `name`, `description`, `input`, and `execute` form.

## Conversation history

Weft's built-in agent loop persists provider transcripts as `Message[]`. That persisted state stays narrow because it is the durable replay surface.

The built-in `AgentResult` keeps that transcript type by default:

```ts partial
interface AgentResult<TConversation extends ConversationHistory = Message[]> {
  conversation: TConversation;
}
```

Wrappers can widen the generic when returning an Agent Bureau history:

```ts partial
type ConversationHistory = Message[] | AgentBureauConversationHistory;
```

This lets an Agent Bureau wrapper return a `conversationalist` history object without translating it into Weft's provider transcript shape. Weft does not interpret Agent Bureau conversation histories internally.

## Storage compatibility

Storage compatibility is a separate roadmap item. This integration point does not change Weft's storage value type and does not add Agent Bureau storage wrappers.
