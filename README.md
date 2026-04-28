# Weft

A Bun-native durable execution engine.

> _Weft_---the cross-threads in weaving that bind the warp together.

## What Is Weft?

Weft runs async workflows to completion across crashes, retries, and arbitrary stretches of wall-clock time. You write what looks like a normal generator function; the engine persists a checkpoint at every `yield*` boundary and resumes from the last checkpoint on recovery. No replay, no determinism constraints, no special imports.

It's built specifically for two execution shapes that traditional workflow engines treat as second-class:

- **Long-running business processes**---checkouts, onboarding flows, fulfillment pipelines---where a process crash mid-flight must not lose money or leave the system in a partial state.
- **AI agent loops**---ReAct-style LLM execution where the next step is decided at runtime by a probabilistic model, tool calls have real side effects, and conversations need to survive crashes mid-turn.

## The Problem

Imagine you're building an e-commerce checkout: charge the customer's credit card, reserve inventory, send a confirmation email, schedule shipping. What happens if your server crashes between step one and step two? The customer has been charged, but the inventory was never reserved. You can't just re-run the whole flow---you'd double-charge them.

**Durable execution** solves this. You write a normal-looking function and the runtime guarantees it will complete---even if the process crashes and restarts a hundred times along the way. Each step is checkpointed so recovery picks up exactly where it stopped.

Temporal is the most prominent durable execution engine, built in 2019 with Go, gRPC, and Cassandra. It works. But we can do better with modern tools.

## Design Constraints

Weft is a ground-up rethink: what would durable execution look like if you designed it today, for today's workloads?

- **Web-native everywhere.** Every API comes from web standards: `fetch`, `WebSocket`, `Worker`, `BroadcastChannel`, `structuredClone`, `AbortController`, `crypto.randomUUID()`, `ReadableStream`. If the browser has it, we use it.
- **Bun-native on the server.** `Bun.serve()`, `Bun.SQL`, `Bun.build()`, `bun:test`. The full Bun platform, not just "Node.js but faster."
- **Single binary, every OS.** `bun build --compile` produces standalone executables for darwin-arm64, darwin-x64, linux-x64, linux-arm64, and windows-x64. One CI pipeline, six binaries, zero runtime dependencies.
- **Runs in the browser.** The core engine (minus the server shell) runs in Web Workers with a Service Worker as its persistence backbone. Same workflow code, different environment.
- **Agent-native.** Dynamic execution graphs, durable streaming, cost enforcement, human oversight, multi-agent coordination, context window management, and model routing are built into the core---not bolted on as wrappers around generic activities.

## Hello, World

```typescript
import { Engine } from 'weft';
import { BunSQLiteStorage } from 'weft/storage/bun-sqlite';

const engine = new Engine({ storage: new BunSQLiteStorage('./weft.db') });

async function greet(name: string) {
  return `Hello, ${name}!`;
}

engine.register('welcome', async function* (ctx, user: { name: string }) {
  const greeting = yield* ctx.run(greet, user.name);
  yield* ctx.sleep('1 hour');
  return { greeting, onboarded: true };
});

const handle = await engine.start('welcome', { name: 'Steve' });
const result = await handle.result();
// result === { greeting: "Hello, Steve!", onboarded: true }
```

That's a complete durable workflow. Checkpoints are written to `./weft.db` at every `yield*` boundary, so if the process crashes after `greet` finishes but before the sleep expires, restarting the engine resumes from exactly that point.

> [!NOTE]
> `MemoryStorage` (also exported from `weft`) is fine for tests and ephemeral scripts, but it lives in process memory---a crash takes the checkpoints with it. Use a persistent backend like `BunSQLiteStorage` whenever durability actually matters.

## How It Works

Weft uses a **checkpoint model**, not a replay model. This is the single most important design decision and it shapes everything else.

In a replay-based system (Temporal, Cadence), the workflow runtime re-executes your function from the beginning on every recovery, replaying recorded activity results to reconstruct state. That's why those systems demand strict determinism---no `Date.now()`, no `Math.random()`, no random control flow---and why they need separate sandboxes, bundlers, and version-pinning protocols.

Weft does the opposite. The generator function pauses at each `yield*`, the engine serializes its current local state via `structuredClone`, and the next time the workflow runs it resumes from that paused position. Your code can use `Date.now()`, `Math.random()`, dynamic imports, anything---because nothing replays. The checkpoint is the source of truth for "where am I and what do I know."

A few consequences fall out of this:

- **Fixed-size checkpoints.** Long-running workflows don't accumulate ever-growing event histories. The checkpoint stores only what's currently in scope.
- **No `continueAsNew` ceremony.** Workflows can run for years without special handling.
- **Native agent loops.** Each tool call inside an agent loop is its own checkpoint boundary, so dynamic LLM-driven control flow is just generator code.

## Core Concepts

| Concept              | What it is                                                                                                                    |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| **Workflow**         | A generator function the engine drives to completion. Every `yield*` is a checkpoint.                                         |
| **Activity**         | A regular async function dispatched by a workflow with `ctx.run(fn, args)`. Activities are where side effects live.           |
| **Checkpoint**       | A serialized snapshot of a workflow's position and local variables, written at every yield.                                   |
| **Signal**           | A fire-and-forget message sent _into_ a running workflow. Workflows pause at `ctx.waitForSignal()` until one arrives.         |
| **Update**           | A request-response message sent into a running workflow. The caller blocks until the workflow returns a result.               |
| **Query**            | A read-only peek at a running workflow's state. Never mutates anything.                                                       |
| **Search attribute** | Indexed metadata on a workflow (customer ID, region, status) set via `ctx.setAttribute()` and queryable through the list API. |
| **Worker**           | A process or thread that executes activities. Inline by default; can run remote over WebSocket.                               |
| **Interceptor**      | A composable hook that wraps context operations for tracing, validation, encryption, or any cross-cutting concern.            |
| **Agent**            | A durable LLM execution loop registered via `defineAgent()` or invoked inline with `ctx.agent()`.                             |
| **Shared state**     | A CAS-backed durable mutable primitive for safe concurrent reads and writes across workflows.                                 |

## Features

### Durable Workflows

Generator functions with automatic checkpointing at every `yield*` boundary. Activities, sleeps, signals, queries, updates, parallel execution via `ctx.all()`, race semantics via `ctx.race()`, memoization via `ctx.memo()`, sagas via `ctx.saga()`, child workflows, and forks.

```typescript
engine.register('checkout', async function* (ctx, order) {
  const charge = yield* ctx.run(chargeCard, order.payment);
  yield* ctx.run(reserveInventory, order.items);

  const [confirmation, shipment] = yield* ctx.all([
    ctx.run(sendConfirmation, order.email, charge.receiptId),
    ctx.run(scheduleShipping, order.address),
  ]);

  return { status: 'completed', charge, confirmation, shipment };
});
```

### Durable Timers and Signals

Sleeps survive process restarts. Signals pause workflows for seconds, days, or weeks at no cost---the checkpoint just sits in storage.

```typescript
engine.register('approval', async function* (ctx, input: { orderId: string }) {
  const approval = yield* ctx.waitForSignal<{ approved: boolean }>('approval');
  if (!approval.approved) {
    return { orderId: input.orderId, status: 'rejected' };
  }

  yield* ctx.sleep('24 hours');
  yield* ctx.run(ship, input.orderId);
  return { orderId: input.orderId, status: 'shipped' };
});

// From an HTTP handler, another workflow, or anywhere with engine access:
await engine.signal(handle.id, 'approval', { approved: true });
```

### Search Attributes

Attach indexed metadata to a workflow at runtime, then list and filter on it.

```typescript
engine.register('order', async function* (ctx, input: { customerId: string }) {
  ctx.setAttribute('customerId', input.customerId);
  ctx.setAttribute('status', 'processing');
  // ... work ...
  ctx.setAttribute('status', 'shipped');
});

const orders = await engine.list({
  filter: { customerId: 'acme', status: 'shipped' },
});
```

### AI Agents

First-class ReAct loop with tool calling, budget enforcement, human-in-the-loop review, model routing, context window management, and multi-agent coordination (handoff, supervision, debate).

```typescript
import { defineAgent, costTierRouter, slidingWindowStrategy } from 'weft';

const researcher = defineAgent({
  name: 'research',
  model: 'claude-sonnet-4-20250514',
  systemPrompt: 'You are a research analyst.',
  tools: [webSearch, factCheck, dataQuery],
  maxTurns: 25,
  budget: { maxTokens: 100_000, maxCost: 5.0, warningThreshold: 0.8 },
  modelRouter: costTierRouter([
    { model: 'claude-sonnet-4-20250514', maxCostRemaining: 2.0 },
    { model: 'claude-haiku-4-5-20251001' },
  ]),
  contextStrategy: slidingWindowStrategy({
    preserveSystemMessage: true,
    preserveRecentCount: 10,
  }),
});

engine.registerAgent(researcher);

const handle = await engine.start('research', 'How did the 2026 Treasury auction go?');
const { messages, usage } = await handle.result();
```

Each tool call inside the loop is a separate checkpoint boundary. Crash after 7 of 30 tool calls and the agent picks up at tool call 8---no replay, no re-execution of side effects.

### Pluggable Storage

A five-method `Storage` interface (`get`, `put`, `delete`, `scan`, `batch`) over `Uint8Array` keys and values. Built-in adapters:

- **`MemoryStorage`** for development and tests
- **`BunSQLiteStorage`** (subpath `weft/storage/bun-sqlite`) for production via `Bun.SQL`
- **`NodeSQLiteStorage`** (subpath `weft/storage/sqlite/node`) for Node.js runtimes via `better-sqlite3`
- **`LMDBStorage`** (subpath `weft/storage/lmdb`) for embedded high-throughput workloads
- **`TursoStorage`** (subpath `weft/storage/turso`) for distributed libSQL deployments
- **`IndexedDBStorage`** (subpath `weft/storage/indexeddb`) for browser environments
- **`CompressedStorage`** wrapper for transparent zstd/gzip compression

Bring your own backend by implementing the interface---five methods is enough.

### Server Mode

`serve()` wraps `Bun.serve()` to expose your engine over HTTP and WebSocket with a versioned REST API.

```typescript
import { Engine } from 'weft';
import { serve } from 'weft/server';
import { BunSQLiteStorage } from 'weft/storage/bun-sqlite';

const engine = new Engine({ storage: new BunSQLiteStorage('./weft.db') });
engine.register('checkout', checkoutWorkflow);

using server = serve({ engine, port: 7233 });
// server.url is e.g. "http://0.0.0.0:7233"
```

Endpoints under `/v1/` cover the full lifecycle: start workflows, list, signal, update, query, cancel, fork, and stream events. Content negotiation supports JSON and MessagePack. The server also embeds a built-in dashboard for inspecting live workflows, checkpoints, and history.

### Remote Workers

Workers can connect to the server over WebSocket, pull tasks, execute activities, and report results back. The same activity code runs inline in development and remote in production---no API changes.

```typescript
import { RemoteWorker } from 'weft';

const worker = new RemoteWorker({
  serverUrl: 'wss://weft.internal:7233',
  activities: { chargeCard, reserveInventory, sendConfirmation },
});

await worker.start();
```

### Browser Support

The core engine runs inside a Web Worker, with a Service Worker acting as the durable persistence layer over `IndexedDB`. The same workflow code that runs on the server ships to the browser unmodified---useful for offline-first apps that need durable client-side workflows.

### Multi-Tenancy

Built-in tenant resolution and per-tenant quotas. Resolve tenants from any field on the workflow input, then attach quotas to control workflow creation rate, concurrency, or storage usage per tenant.

```typescript
import { Engine, tenantFromInputField } from 'weft';

const engine = new Engine({
  tenantResolver: tenantFromInputField('customerId'),
  tenantQuotas: {
    maxRunningWorkflows: 100,
    workflowCreationRateLimit: { perMinute: 60 },
  },
});
```

### Observability

Built-in event system (`EventTarget`-based, so it composes with everything), W3C `traceparent` propagation, and OpenTelemetry-compatible metrics. Composable interceptors layer cross-cutting concerns---tracing, validation, encryption---without any of them knowing about each other.

```typescript
import { createObservabilityInterceptors, createOtelMetrics } from 'weft';

const metrics = createOtelMetrics({
  /* your meter provider */
});
const interceptors = createObservabilityInterceptors({ metrics });

const engine = new Engine({
  storage,
  workflowInterceptors: [interceptors.workflow],
  activityInterceptors: [interceptors.activity],
});
```

### Testing

`TestEngine` swaps the production engine in tests and gives you a virtual clock. `engine.advanceTime('1 hour')` jumps timers forward without waiting; `engine.mock(activity, fake)` swaps in fake activity implementations with type-checked signatures, call recording, and per-call overrides.

```typescript
import { TestEngine } from 'weft/testing';
import { expect, test } from 'bun:test';

test('onboarding completes after a day', async () => {
  const engine = new TestEngine();
  engine.register('onboarding', onboardingWorkflow);

  const sendEmail = engine.mock(actualSendEmail, () => ({
    messageId: 'msg_test_1',
  }));

  const handle = await engine.start('onboarding', { name: 'Steve' });
  await engine.advanceTime('1 day');

  expect(await handle.result()).toEqual({ status: 'onboarded' });
  expect(sendEmail.callCount).toBe(2);
});
```

For chaos testing, `withChaos()` wraps activities with configurable transient failures, timeouts, and non-retryable errors so you can prove your retry policies actually work.

### Single-Binary Distribution

`bun build --compile` produces standalone executables for darwin-arm64, darwin-x64, linux-x64, linux-arm64, and windows-x64. The engine, server, dashboard, and your workflow code embed into a single file with zero runtime dependencies---download, run, done.

## Installation

```bash
bun add weft
```

Storage backends with native dependencies are exported under subpaths so they only load when imported:

```typescript
import { BunSQLiteStorage } from 'weft/storage/bun-sqlite';
import { LMDBStorage } from 'weft/storage/lmdb';
import { TursoStorage } from 'weft/storage/turso';
import { IndexedDBStorage } from 'weft/storage/indexeddb';
```

The `bun` runtime version `1.3.0` or later is required.

## Step API for `async`/`await` Folks

If generator syntax is unfamiliar, the same workflow can be written with `ctx.step()` calls and plain `async`/`await`:

```typescript
engine.register('welcome', async (ctx, input) => {
  const { name } = input as { name: string };
  const greeting = await ctx.step('greet', () => greet(name));
  await ctx.step('notify', () => notify(greeting));
  return { greeting, notified: true };
});
```

Each `ctx.step()` is a checkpoint boundary. The engine compiles step-style workflows to generator form at registration time. When you need durable timers, signals, or parallel execution, switch to the generator API.

## Weft vs. Temporal

| Concept                | Temporal                          | Weft                                 |
| ---------------------- | --------------------------------- | ------------------------------------ |
| Core mental model      | Replay determinism                | Generators pause and resume          |
| Activity invocation    | `proxyActivities()` + type import | `yield* ctx.run(fn, args)`           |
| Timer                  | Deterministic `workflow.sleep()`  | `yield* ctx.sleep("1 hour")`         |
| Signal                 | `setHandler` + `condition`        | `yield* ctx.waitForSignal(name)`     |
| Versioning             | `patched()` / `deprecatePatch()`  | Deploy new code (migration optional) |
| Long-running workflows | `continueAsNew()`                 | Nothing (checkpoints are fixed-size) |
| Agent declaration      | N/A (build from primitives)       | `defineAgent()` or `ctx.agent()`     |
| Dev environment        | Docker Compose + Temporal server  | `bun add weft`                       |
| Bundling               | Webpack for workflow sandbox      | None                                 |

## Documentation

Getting started:

- [Installation](docs/getting-started/installation.md)
- [Hello World](docs/getting-started/hello-world.md)
- [Key Concepts](docs/getting-started/key-concepts.md)

Guides:

- [Workflows](docs/guides/workflows.md), [Activities](docs/guides/activities.md), [Storage](docs/guides/storage.md), [Server](docs/guides/server.md)
- [Signals and Queries](docs/guides/signals-and-queries.md), [Synchronous Updates](docs/guides/synchronous-updates.md)
- [Durable Timers](docs/guides/durable-timers.md), [Timeouts](docs/guides/timeouts.md), [Parallel Execution](docs/guides/parallel-execution.md)
- [Search Attributes](docs/guides/search-attributes.md), [Shared State](docs/guides/shared-state.md), [Events](docs/guides/events.md)
- [Interceptors](docs/guides/interceptors.md), [Observability](docs/guides/observability.md), [Testing](docs/guides/testing.md)
- [Workflow Versioning](docs/guides/workflow-versioning.md), [Remote Workers](docs/guides/remote-workers.md), [Resource Management](docs/guides/resource-management.md)

Agents:

- [Agent Overview](docs/agents/agent-overview.md), [Declaration](docs/agents/agent-declaration.md), [Tools and MCP](docs/agents/agent-tools-and-mcp.md)
- [Budget and Cost](docs/agents/agent-budget-and-cost.md), [Streaming](docs/agents/agent-streaming.md), [Context Window](docs/agents/agent-context-window.md)
- [Model Routing](docs/agents/agent-model-routing.md), [Human Review](docs/agents/agent-human-review.md), [Coordination](docs/agents/agent-coordination.md)
- [Provider Health](docs/agents/agent-provider-health.md), [Observability](docs/agents/agent-observability.md)

Architecture and reference:

- [Design Philosophy](docs/architecture/design-philosophy.md), [Checkpoint vs. Replay](docs/architecture/checkpoint-versus-replay.md), [Web Standards](docs/architecture/web-standards.md)
- [Browser Runtime](docs/architecture/browser-runtime.md), [Web Workers](docs/architecture/web-workers.md), [Single Binary](docs/architecture/single-binary.md)
- [API Reference](docs/reference/) (Engine, Context, Storage, Server, Workers, Agent, Testing, Events, Interceptors, Observability, CLI, Configuration, Types)

## License

MIT
