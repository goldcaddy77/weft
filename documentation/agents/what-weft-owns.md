# What Weft Owns

Weft's agent surface is intentionally narrow after the AI Surface Shrinkage refactor.

**Core boundary:** Weft adds durability to your agent loop. It drives provider turns, checkpoints at every tool-call boundary, records committed tool effects, and resumes after crashes without re-executing completed side effects.

Everything else stays with your application or upstream libraries.

## The Minimal `LLMProvider`

Only `chat()` is required. If an SDK can produce a response with content, tool calls, usage, model, and stop reason, it can satisfy the structural interface.

```typescript partial
import type { ChatResponse, LLMProvider, Message } from 'weft';

const provider: LLMProvider = {
  name: 'local-test-provider',
  async chat(messages: Message[], options): Promise<ChatResponse> {
    return {
      content: `Received ${messages.length} message(s).`,
      toolCalls: [],
      usage: { inputTokens: 12, outputTokens: 8, totalTokens: 20 },
      model: options.model,
      stopReason: 'end_turn',
    };
  },
};
```

`createChatResumeHint()` and `warmup()` are optional. They are useful when a provider supports asynchronous resume-aware execution or an explicit startup path, but the loop only depends on `chat()`.

## Built-In Providers Are Gone

Weft no longer ships built-in providers. Supply your own from [`@anthropic-ai/sdk`](https://www.npmjs.com/package/@anthropic-ai/sdk), [`openai`](https://www.npmjs.com/package/openai), a hand-rolled HTTP client, [armorer](https://github.com/stevekinney/armorer), or a test mock.

That keeps provider policy where it belongs: near API keys, retry behavior, regional routing, logging, and vendor-specific response parsing.

## What About MCP?

Weft no longer ships a [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) client.

If you want tools from MCP servers, use any MCP client and adapt the discovered tools to `AgentTool[]`:

```typescript partial
import type { AgentTool } from 'weft';

async function loadMcpTools(client: ThirdPartyMcpClient): Promise<AgentTool[]> {
  const tools = await client.listTools();

  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description ?? '',
    input: tool.inputSchema,
    execute: (input) => client.callTool(tool.name, input),
  }));
}
```

Weft sees ordinary tools. Your application owns MCP authentication, transports, discovery, and server lifecycle.

## Tenant-Scoped Tools

Tenant-scoped tools are the workflow's responsibility, not Weft's.

That is deliberate. The workflow has the tenant context, request shape, authorization data, and product-specific boundary. A central agent definition does not.

```typescript partial
import type { AgentToolDefinition, LLMProvider, TenantContext, WorkflowContext } from 'weft';

declare const provider: LLMProvider;
declare const publicSearch: AgentToolDefinition;
declare const enterpriseSearch: AgentToolDefinition;
declare const billingLookup: AgentToolDefinition;

function pickToolsForTenant(tenant: TenantContext | undefined): AgentToolDefinition[] {
  if (tenant?.id === 'enterprise') {
    return [enterpriseSearch, billingLookup];
  }

  return [publicSearch];
}

async function* answerQuestion(ctx: WorkflowContext, question: string) {
  const tools = pickToolsForTenant(ctx.tenant);

  const result = yield* ctx.agent({
    model: 'claude-sonnet-4-20250514',
    provider,
    tools,
    prompt: question,
    maxTurns: 12,
  });

  return result.content;
}
```

If authorization changes, update the workflow helper. The agent loop still gets a plain tool list and can checkpoint each call normally.

## Ownership Table

| Weft owns                                               | Upstream owns                        |
| ------------------------------------------------------- | ------------------------------------ |
| `executeAgentLoop`, `agent`                             | Provider implementations             |
| Durable coordination (`handoff`, `debate`, `supervise`) | MCP clients                          |
| `ToolEffectLog`, `computeSemanticHash`                  | Budget tracking                      |
| `ReviewCoordinator`                                     | Model routing                        |
| Durability-shaped events                                | Context-window compaction            |
| `LLMProvider` interface (structural contract)           | Provider implementations             |
|                                                         | Prompt caching, streaming primitives |

## Why the boundary is narrow

**Durability is the product:** Weft is valuable when a process dies halfway through a conversation and the loop resumes without duplicate effects.

**Provider choice changes quickly:** SDKs, model names, rate-limit strategies, and vendor response formats evolve outside Weft's release cycle. Keeping them upstream avoids a stale compatibility layer.

**Tool policy is application policy:** Tool authorization, tenant filtering, schema validation, credentials, and audit requirements are product-specific. Weft should not pretend a generic central policy can decide them correctly.

**Coordination remains durable:** Handoffs, debates, supervision, and human review all build on the same checkpoint model. Weft owns the durable control flow, not the surrounding AI platform stack.
