# Agent Tools

Your agent is only as useful as the tools it can call.

**Agent tool:** A structural object with a tool definition, an `execute()` function, and optional verification and identity hooks. Weft does not care where the tool came from. It only needs a stable shape it can pass to the agent loop and protect with the effect log.

## `AgentTool`

```typescript
import type { AgentTool } from 'weft';

type SearchInput = {
  query: string;
  limit?: number;
};

function isSearchInput(input: unknown): input is SearchInput {
  return (
    typeof input === 'object' &&
    input !== null &&
    'query' in input &&
    typeof input.query === 'string'
  );
}

export const webSearch: AgentTool = {
  definition: {
    name: 'web_search',
    description: 'Searches the web and returns matching documents.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        limit: { type: 'number' },
      },
      required: ['query'],
    },
  },
  async execute(input) {
    if (!isSearchInput(input)) throw new Error('Expected a search query.');

    const limit = input.limit ?? 5;
    return searchDocuments(input.query, { limit });
  },
  async verify(result) {
    return Array.isArray(result);
  },
};
```

`execute()` receives model-produced input as `unknown`. Validate it before using it. The example uses a hand-written guard, but Zod, Valibot, TypeBox, or your existing request schemas are all reasonable.

## `AgentToolDefinition`

`AgentToolDefinition` is structurally the same shape used by `defineAgent()`:

```typescript
interface AgentToolDefinition {
  definition: ToolDefinition;
  execute: (input: unknown) => Promise<unknown>;
  verify?: (result: unknown) => Promise<boolean> | boolean;
  version?: string;
  identity?: (input: unknown) => ToolIdentityResult;
}
```

Use `version` when a tool's behavior changes in a way that matters for workflow resume compatibility.

## Stable identity

**Semantic hash:** `computeSemanticHash()` creates a stable identity for the fields that determine a tool call's observable effect. This matters because provider-generated input often includes incidental fields: formatting hints, request IDs, or timestamps that should not force a second side effect.

```typescript
import { computeSemanticHash, type AgentToolDefinition } from 'weft';

const createTicket: AgentToolDefinition = {
  definition: {
    name: 'create_ticket',
    description: 'Creates a support ticket.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        customerId: { type: 'string' },
        requestId: { type: 'string' },
      },
      required: ['title', 'customerId'],
    },
  },
  async execute(input) {
    return createSupportTicket(input);
  },
  identity(input) {
    return computeSemanticHash(input, ['title', 'customerId']);
  },
};
```

Here, `title` and `customerId` determine the side effect. `requestId` may be useful for logs, but it is not part of the semantic identity.

## `ToolEffectLog`

**Tool effect log:** A durable record of committed tool results. At each tool-call checkpoint boundary, Weft checks the effect log before executing a tool. If the same semantic identity has already committed, Weft returns the recorded result instead of running the tool again.

That is the protection you need after a crash. The process may disappear after the ticket was created but before the conversation advanced. On recovery, the model can ask for the same tool call again, and the effect log turns that duplicate request into a replayed result.

## Passing tools

Attach default tools to an agent definition:

```typescript
import { defineAgent } from 'weft';

const researcher = defineAgent({
  name: 'research',
  model: 'claude-sonnet-4-20250514',
  tools: [webSearch, createTicket],
});
```

Or pass tools at invocation time:

```typescript
async function* workflow(ctx: WorkflowContext, topic: string) {
  const tools = [webSearch, factCheck];

  return yield* ctx.agent({
    model: 'claude-sonnet-4-20250514',
    provider,
    tools,
    prompt: topic,
  });
}
```

Invocation-time tools are the right place for request-specific authorization, tenant scoping, and credentials.

## MCP tools

**MCP integration:** Weft no longer ships an MCP client. To use MCP servers as agent tools, instantiate any third-party MCP client, such as `@modelcontextprotocol/sdk`, and adapt its tool list to the structural `AgentTool` shape.

```typescript
import type { AgentTool } from 'weft';

async function toolsFromMcp(client: ThirdPartyMcpClient): Promise<AgentTool[]> {
  const remoteTools = await client.listTools();

  return remoteTools.map((tool) => ({
    definition: {
      name: tool.name,
      description: tool.description ?? '',
      inputSchema: tool.inputSchema,
    },
    execute: (input) => client.callTool(tool.name, input),
  }));
}
```

The adapter is intentionally small. Your application owns authentication, transport selection, server discovery, and schema validation before the value reaches the Weft tool surface.
