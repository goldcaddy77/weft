# Tools and MCP

Your agent is only as useful as the tools it can call. A model that can't search the web, query a database, or read a file is just a chatbot. Weft gives you two ways to provide tools: local functions defined in your codebase, and remote tools discovered from MCP servers. Both are first-class, and the `ToolRegistry` merges them into a single unified tool set.

## Local function tools

The `AgentTool` interface pairs a tool definition with an execute function:

```typescript
import type { AgentTool } from 'weft';

const webSearch: AgentTool = {
  definition: {
    name: 'webSearch',
    description: 'Search the web for information on a topic',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' },
        maxResults: { type: 'number', description: 'Maximum results to return' },
      },
      required: ['query'],
    },
  },
  execute: async (input) => {
    const { query, maxResults = 5 } = input as { query: string; maxResults?: number };
    const results = await performSearch(query, maxResults);
    return results;
  },
};
```

The `definition` field is a `ToolDefinition`—name, description, and a JSON Schema for the input. The `execute` function receives whatever the model sends and returns a result that gets serialized back into the conversation. If it throws, the error message is sent to the model so it can try a different approach.

Pass tools directly to `defineAgent()` or `executeAgentLoop()`:

```typescript
const agent = defineAgent({
  name: 'researcher',
  model: 'claude-sonnet-4-20250514',
  tools: [webSearch, readDocument, analyzeData],
});
```

## Connecting to MCP servers

The **Model Context Protocol** is the standard for remote tool integration. `MCPClient` connects to an MCP server, discovers its tools, and invokes them over HTTP.

```typescript
import { MCPClient } from 'weft';

const client = new MCPClient({
  serverUrl: 'http://localhost:3000/mcp',
  timeout: 30_000,
});
```

Discover what tools the server offers:

```typescript
const tools = await client.discoverTools();
// Returns ToolDefinition[] — name, description, inputSchema for each
```

Invoke a specific tool:

```typescript
const result = await client.invokeTool('readFile', { path: '/etc/hosts' });
```

The `invokeTool` method accepts an optional `AbortSignal` for cancellation. If the call exceeds the configured timeout, it throws `MCPToolTimeoutError`.

You can also health-check the server before starting an agent loop:

```typescript
const healthy = await client.healthCheck();
if (!healthy) {
  throw new Error('MCP server is down');
}
```

## Authentication

MCP servers often require authentication. The `MCPAuthConfig` type supports three modes:

```typescript
// Bearer token
const client = new MCPClient({
  serverUrl: 'https://api.example.com/mcp',
  auth: { type: 'bearer', token: 'your-token-here' },
});

// Custom API key header
const client = new MCPClient({
  serverUrl: 'https://tools.example.com/mcp',
  auth: { type: 'api-key', headerName: 'X-API-Key', apiKey: 'your-key' },
});

// No authentication
const client = new MCPClient({
  serverUrl: 'http://localhost:3000/mcp',
  auth: { type: 'none' },
});
```

Under the hood, `buildAuthHeaders()` converts the config into HTTP headers. Bearer tokens become `Authorization: Bearer <token>`. API keys use whatever header name you specify.

## The tool registry

When your agent uses tools from multiple sources—local functions, one or more MCP servers—you need a way to merge them into a single set. `ToolRegistry` handles this.

```typescript
import { MCPClient, ToolRegistry } from 'weft';

const registry = new ToolRegistry();

// Register local tools
registry.registerLocal(webSearch.definition, webSearch.execute);
registry.registerLocal(analyzeData.definition, analyzeData.execute);

// Discover and register MCP tools
const mcpClient = new MCPClient({ serverUrl: 'http://localhost:3000/mcp' });
const mcpTools = await mcpClient.discoverTools();
registry.registerMCP(mcpTools, 'http://localhost:3000/mcp', (toolName, input) =>
  mcpClient.invokeTool(toolName, input),
);
```

Retrieve tools by name or get the full list:

```typescript
const tool = registry.get('readFile'); // RegistryTool | undefined
const all = registry.getAll(); // RegistryTool[]
const definitions = registry.getDefinitions(); // ToolDefinition[]
```

Each `RegistryTool` carries a `source` field (`'local'` or `'mcp'`) and an optional `serverUrl`, so you always know where a tool came from.

## Handling name conflicts

If two sources register a tool with the same name, the registry stores both but only returns the first one registered when you call `get()`. To catch this early, call `validate()` after registration:

```typescript
try {
  registry.validate();
} catch (error) {
  if (error instanceof ToolNameConflictError) {
    console.error(`Conflict on "${error.toolName}" from: ${error.sources.join(', ')}`);
  }
}
```

`ToolNameConflictError` fires only when the conflicting entries come from _different_ source types (for example, a local function and an MCP server both named `readFile`). Two MCP entries from the same server with the same name don't conflict—they're considered the same tool.

## Schema validation

Before dispatching a tool call to the LLM's chosen tool, you can validate the input against the tool's JSON Schema using `validateSchema()`:

```typescript
import { validateSchema, ToolSchemaValidationError } from 'weft';

const result = validateSchema(inputFromModel, tool.definition.inputSchema);

if (!result.valid) {
  throw new ToolSchemaValidationError(tool.definition.name, result.errors);
}
```

Each `ValidationError` in the result includes a `path` (dot-separated field path), a `message`, and optional `expected`/`actual` type strings. This catches malformed tool arguments before they reach your execute function or a remote MCP server.

## Error types

The MCP subsystem defines specific errors for common failure modes:

- **`MCPServerUnavailableError`**—thrown when the server doesn't respond or returns a non-OK status. Carries the `serverUrl`.
- **`MCPToolTimeoutError`**—thrown when a tool invocation exceeds the configured timeout. Carries `toolName` and `timeout` in milliseconds.
- **`ToolNameConflictError`**—thrown by `registry.validate()` when tools from different sources share a name. Carries `toolName` and `sources`.
- **`ToolSchemaValidationError`**—thrown when tool input fails JSON Schema validation. Carries `toolName` and an `errors` array.

Each tool invocation within the agent loop is a checkpoint boundary. If the process crashes after an MCP server processes a tool call but before the agent sees the result, recovery loads the result from the checkpoint. MCP and local tools get identical durability guarantees—no special handling required.
