# Breaking Changes — AI Surface Shrinkage

This document covers the breaking changes introduced by the AI Surface Shrinkage refactor (ROADMAP section 1). Pre-1.0 hard cut: no soft deprecation, no migration shims, no compatibility layer.

## What changed

Weft's `src/ai/*` surface has been narrowed to the durability-essential primitives. The narrow agent pitch is: _"Weft adds durability to your agent loop. Bring your provider; bring your tools. Weft drives the loop, checkpoints at every tool-call boundary, survives crashes mid-conversation."_

## 1. Removed public exports

The following symbols are no longer exported from `weft`. Callers must supply their own implementations or use upstream libraries (`armorer`, `conversationalist`, the official `@modelcontextprotocol/sdk`, etc.).

**Built-in providers (now bring-your-own):**

- `AnthropicProvider`, `OpenAIProvider`

**Budget tracking (moves to upstream cost-control policy):**

- `BudgetTracker`, `BudgetExceededError`, `BudgetOptions`, `BudgetState`, `ModelPricing`
- `BudgetPolicyEnforcer`, `OrganizationBudgetExceededError`, `BudgetPolicyOptions`
- `engine.setBudgetPolicy()` / `engine.getBudgetPolicy()` — removed from the engine and HTTP/JSON-RPC surfaces

**Context window management (moves to upstream conversation library):**

- `ContextWindowManager`, `ContextStrategy`, `composeStrategies`, `noopStrategy`
- `slidingWindowStrategy` and the `context-strategies/` directory

**Model routing (moves to upstream orchestration layer):**

- `ModelRouter`, `ModelSelection`, `RoutingContext`
- `costTierRouter`, `abTestRouter`, `customRouter`, `staticFallbackRouter`

**Provider health, prompt cache, streaming primitives:**

- `ProviderHealthTracker`
- `PromptCache`, `PROMPT_CACHE_HIT_METRIC`, `PROMPT_CACHE_MISS_METRIC`, `AnnotateResult`, `AnnotatedMessage`, `AnthropicCacheControl`, `PromptCacheProviderMetadata`
- `TokenBridge`, `StreamMultiplexer`, `ReconnectionBuffer`, `StreamChunk`

**MCP client (moves to upstream `armorer` or third-party `@modelcontextprotocol/sdk`):**

- All MCP exports: `MCPClient`, `MCPServerUnavailableError`, `MCPToolTimeoutError`, `MCPClientOptions`, `MCPClientTransportOptions`, `MCPClientUrlOptions`, `OAuth2TokenError`, `createOAuth2TokenManager`, `OAuth2Config`, `OAuth2TokenManager`, `ToolNameConflictError`, `ToolRegistry`, `RegistryTool`, `ToolSchemaValidationError`, `validateSchema`, `MCPTransportError`, `inferTransportKind`, `parseStdioUrl`, `MCPRequest`, `MCPResponse`, `MCPTransport`, `TransportKind`, `HttpTransport`, `HeaderSource`, `HttpTransportOptions`, `HttpSseTransport`, `HttpSseTransportOptions`, `MCPAuthConfig`, `SyncMCPAuthConfig`, `buildAuthHeaders`
- `MCPToolSource` (the `tools` field on `AgentOptions` no longer accepts MCP source descriptors)

**Dropped agent-shape concerns (moves to upstream observability / agent-bureau):**

- `AgentHooks`
- `TurnCostEntry`
- Agent-shape events: `AgentBudgetExceededEvent`, `AgentBudgetWarningEvent`, `AgentContextCompactedEvent`, `AgentModelFallbackEvent`, `AgentProviderCircuitOpenEvent`

## 2. Shape changes to surviving exports

### `AgentDefinition` / `defineAgent`

Drops `budget`, `modelRouter`, `contextStrategy`, `hooks`, `toolsForTenant`, `validateInput`. The new shape is:

```ts
type AgentDefinition<TInput = unknown, TOutput = unknown> = {
  readonly _brand: string;
  name: string;
  model: string;
  version?: string;
  systemPrompt?: string;
  tools?: AgentToolDefinition[];
  maxTurns?: number;
  description?: string;
};
```

### `AgentOptions` (passed to `executeAgentLoop`)

Drops `budget`, `modelRouter`, `contextManager`, `healthTracker`, `toolCacheTTL`, `toolCacheMaxSize`, `hooks`, `onTurnStarted`, `onTurnCompleted`, `onToolCalled`, `onToolReturned`. Also drops `MCPToolSource` from the `tools` array (now plain `AgentTool[]`). The single subscription mechanism is `eventTarget` — callers add listeners for `AgentTurnStartedEvent`, `AgentTurnCompletedEvent`, `AgentToolCalledEvent`, `AgentToolReturnedEvent`, `AgentCheckpointResumedEvent`. This collapses two parallel APIs (inline callbacks and event subscription) into one.

### `AgentResult`

`turnCosts: TurnCostEntry[]` → `turnUsage: TurnUsageEntry[]`. Drops `totalCost` and `confidence`. The new entry shape is:

```ts
type TurnUsageEntry = {
  turnNumber: number;
  inputTokens: number | null;
  outputTokens: number | null;
  source: 'provider' | 'unavailable';
};
```

Exactly one entry per completed turn. `null` token counts when the provider does not report usage; the `source` field discriminates.

### `LLMProvider` (the structural interface Weft owns)

Now requires only `chat()`. `stream()` and `countTokens()` are removed. `createChatResumeHint()` and `warmup()` remain optional.

### `PersistedAgentLoopState`

Adds `schemaVersion: 2` (required). Drops `toolCacheEntries`, `previousModels`, `budgetState`, `totalCost`, `turnCosts`, `budgetWarningFired`. Old (v1-shape) blobs hard-fail with `VersionMismatchError` naming the offending field — **on-disk state from prior versions is unrecoverable and workflows in flight will not resume.** Pre-1.0 storage is not supported across this cut.

### `AgentRegistrationOptions`

Now `{ provider }` only. Drops `budget`, `budgetPolicy`, and other previously-accepted compute fields.

## 3. Removed `package.json` subpath export

- `"./mcp/stdio"` removed (the MCP transport module is gone)

## 4. Internal re-export shim removal

The thin internal shims `src/ai/agent.ts`, `src/ai/coordination.ts`, `src/ai/events.ts` are deleted. Public consumers were never affected — `src/index.ts` imports from the directory paths directly. No external API impact.

## 5. Tenant isolation — explicit responsibility shift

Pre-shrinkage, `AgentDefinition.toolsForTenant` and `AgentDefinition.validateInput` let the engine enforce tool scoping centrally. **Post-shrinkage, this responsibility moves to the workflow author**: callers compose tools per tenant before invoking `ctx.agent({ tools: pickToolsForTenant(ctx.tenant) })`. The engine no longer enforces it. See `documentation/agents/what-weft-owns.md` for the worked example.

If a future user wants engine-level enforcement back, that is a separate roadmap item (a narrower `tenantToolsResolver` engine option) — it is not part of this surgery.

## Migration

Most callers will:

1. Replace `new AnthropicProvider(...)` with their own provider object satisfying the structural `LLMProvider` interface (only `chat()` is required). See `documentation/agents/what-weft-owns.md` for a 15-line canonical example.
2. Drop any `BudgetTracker`, `ModelRouter`, `ContextStrategy`, or `AgentHooks` configuration. If budget tracking is needed, wrap your provider with cost accounting before passing it to `executeAgentLoop` or `engine.register(agentDefinition, { provider })`.
3. Replace MCP client usage with `@modelcontextprotocol/sdk` (or `armorer` once it ships) and adapt the resulting tool list to the structural `AgentTool` shape.
4. If reading `AgentResult.turnCosts`, switch to `AgentResult.turnUsage` and handle `null` token counts and the `source` discriminator.
5. Replace any `event.cost` reads on agent events with `event.usage` (if usage is exposed) or remove cost-tracking from the consumer.
6. Move tenant-scoped tool selection out of `AgentDefinition.toolsForTenant` and into the workflow body, before the `ctx.agent(...)` call.
