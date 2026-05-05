# Migration Guide

This guide walks through the upgrade path for in-flight breaking changes. Pre-1.0 doesn't ship a permanent changelog—what you'll find here is the active migration work, structured around the surfaces that actually moved.

> [!NOTE]
> Once everyone on a given upgrade has migrated, the corresponding section of this guide can be archived. Treat it as a working document, not historical record.

## AI Surface Shrinkage

Weft's `src/ai/*` surface narrowed to the durability-essential primitives. The narrow agent pitch: _"Weft adds durability to your agent loop. Bring your provider; bring your tools. Weft drives the loop, checkpoints at every tool-call boundary, survives crashes mid-conversation."_

If you were using budget tracking, model routing, context window management, prompt caching, the MCP client, or the built-in providers—those moved upstream. Weft no longer ships them.

### Removed Public Exports

The following symbols are no longer exported from `weft`. Callers must supply their own implementations or use upstream libraries: [armorer](https://github.com/stevekinney/armorer), [conversationalist](https://github.com/stevekinney/conversationalist), the official [`@modelcontextprotocol/sdk`](https://www.npmjs.com/package/@modelcontextprotocol/sdk).

**Built-in providers**—now bring-your-own:

- `AnthropicProvider`, `OpenAIProvider`

**Budget tracking**—moves to upstream cost-control policy:

- `BudgetTracker`, `BudgetExceededError`, `BudgetOptions`, `BudgetState`, `ModelPricing`
- `BudgetPolicyEnforcer`, `OrganizationBudgetExceededError`, `BudgetPolicyOptions`
- `engine.setBudgetPolicy()` / `engine.getBudgetPolicy()`—removed from the engine and HTTP/JSON-RPC surfaces

**Context window management**—moves to upstream conversation library:

- `ContextWindowManager`, `ContextStrategy`, `composeStrategies`, `noopStrategy`
- `slidingWindowStrategy` and the `context-strategies/` directory

**Model routing**—moves to upstream orchestration layer:

- `ModelRouter`, `ModelSelection`, `RoutingContext`
- `costTierRouter`, `abTestRouter`, `customRouter`, `staticFallbackRouter`

**Provider health, prompt cache, streaming primitives:**

- `ProviderHealthTracker`
- `PromptCache`, `PROMPT_CACHE_HIT_METRIC`, `PROMPT_CACHE_MISS_METRIC`, `AnnotateResult`, `AnnotatedMessage`, `AnthropicCacheControl`, `PromptCacheProviderMetadata`
- `TokenBridge`, `StreamMultiplexer`, `ReconnectionBuffer`, `StreamChunk`

**MCP client**—moves to upstream `armorer` or third-party `@modelcontextprotocol/sdk`:

- All `MCPClient`, `MCPServerUnavailableError`, `MCPToolTimeoutError`, `MCPClientOptions`, `OAuth2TokenManager`, `ToolRegistry`, transport types, and related symbols
- `MCPToolSource`—the `tools` field on `AgentOptions` no longer accepts MCP source descriptors

**Agent-shape concerns**—moves to upstream observability or agent-bureau:

- `AgentHooks`
- `TurnCostEntry`
- Agent-shape events: `AgentBudgetExceededEvent`, `AgentBudgetWarningEvent`, `AgentContextCompactedEvent`, `AgentModelFallbackEvent`, `AgentProviderCircuitOpenEvent`

**Removed `package.json` subpath:**

- `"./mcp/stdio"`—the MCP transport module is gone.

### Shape Changes to Surviving Exports

#### `AgentDefinition` / `defineAgent`

Drops `budget`, `modelRouter`, `contextStrategy`, `hooks`, `toolsForTenant`, `validateInput`. New shape:

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

#### `AgentOptions`

Passed to `executeAgentLoop`. Drops `budget`, `modelRouter`, `contextManager`, `healthTracker`, `toolCacheTTL`, `toolCacheMaxSize`, `hooks`, and the inline-callback fields (`onTurnStarted`, `onTurnCompleted`, `onToolCalled`, `onToolReturned`). Also drops `MCPToolSource` from the `tools` array—now plain `AgentTool[]`.

The single subscription mechanism is `eventTarget`. Callers add listeners for `AgentTurnStartedEvent`, `AgentTurnCompletedEvent`, `AgentToolCalledEvent`, `AgentToolReturnedEvent`, and `AgentCheckpointResumedEvent`. This collapses two parallel APIs—inline callbacks and event subscription—into one.

#### `AgentResult`

`turnCosts: TurnCostEntry[]` becomes `turnUsage: TurnUsageEntry[]`. Drops `totalCost` and `confidence`. New entry shape:

```ts
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

Exactly one entry per completed turn. The built-in loop records `source: 'provider'` because `LLMProvider.chat()` returns a required `TokenUsage` block. The `source: 'unavailable'` variant exists for wrappers or downstream result aggregation that need to represent providers without usage data.

#### `LLMProvider`

The structural interface Weft owns. Now requires only `chat()`. `stream()` and `countTokens()` are removed. `createChatResumeHint()` and `warmup()` remain optional.

#### `PersistedAgentLoopState`

Adds `schemaVersion: 2` (required). Drops `toolCacheEntries`, `previousModels`, `budgetState`, `totalCost`, `turnCosts`, `budgetWarningFired`.

> [!WARNING]
> Old (v1-shape) blobs hard-fail with `VersionMismatchError` naming the offending field. **You cannot recover on-disk state from prior versions, and workflows in flight will not resume.** Pre-1.0 storage is not supported across this cut. Either let in-flight agent workflows drain before deploying, or accept that they'll fail on resume and need to be restarted.

#### `AgentRegistrationOptions`

Now `{ provider }` only. Drops `budget`, `budgetPolicy`, and other previously-accepted compute fields.

#### Tenant Isolation

Pre-shrinkage, `AgentDefinition.toolsForTenant` and `AgentDefinition.validateInput` let the engine enforce tool scoping centrally. Post-shrinkage, this responsibility moves to the workflow author—callers compose tools per tenant before invoking `ctx.agent({ tools: pickToolsForTenant(ctx.tenant) })`. The engine no longer enforces it.

If you want engine-level enforcement back, that's a separate roadmap item (a narrower `tenantToolsResolver` engine option). It's not part of this surgery.

#### Internal Re-Export Shim Removal

The thin internal shims `src/ai/agent.ts`, `src/ai/coordination.ts`, and `src/ai/events.ts` are deleted. Public consumers were never affected: `src/index.ts` imports from the directory paths directly. No external API impact.

### Migration Checklist

Most callers will:

1. Replace `new AnthropicProvider(...)` with their own provider object satisfying the structural `LLMProvider` interface—only `chat()` is required. See `documentation/agents/what-weft-owns.md` for a 15-line canonical example.
2. Drop any `BudgetTracker`, `ModelRouter`, `ContextStrategy`, or `AgentHooks` configuration. If budget tracking is needed, wrap your provider with cost accounting before passing it to `executeAgentLoop` or `engine.register(agentDefinition, { provider })`.
3. Replace MCP client usage with [`@modelcontextprotocol/sdk`](https://www.npmjs.com/package/@modelcontextprotocol/sdk) (or [armorer](https://github.com/stevekinney/armorer) once it ships) and adapt the resulting tool list to the structural `AgentTool` shape.
4. If you read `AgentResult.turnCosts`, switch to `AgentResult.turnUsage` and handle `null` token counts plus the `source` discriminator.
5. Replace any `event.cost` reads on agent events with `event.usage` (if usage is exposed) or remove cost-tracking from the consumer.
6. Move tenant-scoped tool selection out of `AgentDefinition.toolsForTenant` and into the workflow body, before the `ctx.agent(...)` call.
7. Drain in-flight agent workflows before deploying, or accept that they'll fail to resume and need to be restarted.

## Storage Resolver and Auto-Detection

Two new entry points landed alongside the storage adapter expansion:

- `resolveDefaultStorage()` from `weft/storage/auto`—the developer-convenience helper that picks a SQLite backend based on Bun vs. Node.
- `resolveStorage(configuration)` from `weft/storage` or `weft/storage/resolve`—the configuration-driven resolver covering every backend, including browser and remote.

If you've been constructing storage adapters by hand, neither helper is required. They're additive. But if you're shipping a quick example, `resolveDefaultStorage()` collapses three lines of imports into one. See [the storage guide](./storage.md) for when to use which.

## Service Worker Setup Helper

`setupServiceWorker()` from `weft/service-worker` wires up an engine with `IndexedDBStorage`, fetch handler, lifecycle handlers, and Periodic Background Sync in one call. The lower-level handlers (`createFetchHandler`, `createLifecycleHandlers`, `createPeriodicSyncHandler`, `ServiceWorkerScheduler`) remain available as the manual-setup escape hatch.

If you're already using the lower-level handlers, no change is required. If you want to simplify, see [the service worker guide](./service-worker.md).
