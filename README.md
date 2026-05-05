# Weft

A Bun-native durable execution engine.

> _Weft_---the cross-threads in weaving that bind the warp together.

## The Problem

Imagine you're building an e-commerce checkout: charge the customer's credit card, reserve inventory, send a confirmation email, schedule shipping. What happens if your server crashes between step one and step two? The customer has been charged, but the inventory was never reserved. You can't just re-run the whole flow---you'd double-charge them.

**Durable execution** solves this. You write a normal-looking function and the runtime guarantees it will complete---even if the process crashes and restarts a hundred times along the way. Each step is checkpointed so recovery picks up exactly where it stopped.

Temporal is the most prominent durable execution engine, built in 2019 with Go, gRPC, and Cassandra. It works. But we can do better with modern tools.

## What Is Weft?

Weft runs async workflows to completion across crashes, retries, and arbitrary stretches of wall-clock time. You write what looks like a normal generator function; the engine persists a checkpoint at every `yield*` boundary and resumes from the last checkpoint on recovery. No replay, no determinism constraints, no special imports.

It's built for two execution shapes that traditional workflow engines treat as second-class:

- **Long-running business processes**---checkouts, onboarding flows, fulfillment pipelines---where a process crash mid-flight must not lose money or leave the system in a partial state.
- **AI agent loops**---durable ReAct-style LLM execution where each tool call is a checkpoint boundary. Bring any provider; Weft drives the loop and survives crashes mid-conversation.

## Design Constraints

Weft is a ground-up rethink: what would durable execution look like if you designed it today, for today's workloads?

- **Web-native everywhere.** Every API comes from web standards: `fetch`, `WebSocket`, `Worker`, `BroadcastChannel`, `structuredClone`, `AbortController`, `crypto.randomUUID()`, `ReadableStream`. If the browser has it, we use it.
- **Bun-native on the server.** `Bun.serve()`, `Bun.SQL`, `Bun.build()`, `bun:test`. The full Bun platform, not just "Node.js but faster."
- **Single binary, every OS.** `bun build --compile` produces standalone executables for darwin-arm64, darwin-x64, linux-x64, linux-arm64, and windows-x64. One CI pipeline, six binaries, zero runtime dependencies.
- **Runs in the browser.** The core engine (minus the server shell) runs in Web Workers with a Service Worker as its persistence backbone. Same workflow code, different environment.
- **Agent-native.** Dynamic execution graphs, durable agent loops, human-in-the-loop oversight, and multi-agent coordination are built into the core---each tool call a checkpoint boundary, each conversation durable across crashes.

> [!IMPORTANT]
> Workflows run in TypeScript on the engine; activities can run in any language via the `RemoteWorker` protocol. This split is intentional — the checkpoint model requires single-process generator state, so workflow code is TypeScript-only by design. See [ADR 0001](documentation/contributing/architecture-decisions/0001-workflows-typescript-only.md) for the design rationale.

## Hello, World

```typescript
import {
  Engine,
  WorkflowAlreadyExistsError,
  activity,
  type WorkflowContext,
  type WorkflowHandle,
} from 'weft';
import { SQLiteStorage } from 'weft/storage/sqlite';

const engine = new Engine({ storage: new SQLiteStorage('./weft.db') });

interface ReadmeWelcomeInput {
  name: string;
}

interface ReadmeWelcomeOutput {
  greeting: string;
  onboarded: boolean;
}

declare module 'weft' {
  interface WorkflowRegistry {
    readmeWelcome: { input: ReadmeWelcomeInput; output: ReadmeWelcomeOutput };
  }

  interface ActivityTypes {
    readmeFormatGreeting: (input: ReadmeWelcomeInput) => Promise<string>;
  }
}

const readmeFormatGreeting = activity({
  name: 'readmeFormatGreeting',
  execute: async (input: ReadmeWelcomeInput) => `Hello, ${input.name}!`,
});

engine.registerActivity(readmeFormatGreeting.name, readmeFormatGreeting);

engine.register('readmeWelcome', async function* (ctx: WorkflowContext, user: ReadmeWelcomeInput) {
  const greeting = yield* ctx.run('readmeFormatGreeting', { name: user.name });
  yield* ctx.sleep('1s');
  return { greeting, onboarded: true };
});

await engine.recoverAll();

const workflowId = 'readmeWelcome:steve';
const workflowInput = { name: 'Steve' };
let handle: WorkflowHandle;

try {
  handle = await engine.start('readmeWelcome', workflowInput, { id: workflowId });
} catch (error) {
  if (!(error instanceof WorkflowAlreadyExistsError)) throw error;
  handle = await engine.resume(workflowId).catch(() => engine.getHandle(workflowId));
}

const result = await handle.result();
// result is { greeting: "Hello, Steve!", onboarded: true }
```

That's a complete durable workflow with a real recovery path. Checkpoints are written to `./weft.db` at every `yield*` boundary. `engine.recoverAll()` resumes workflows that were already running when this process started, and the stable `workflowId` prevents a rerun from silently creating a second workflow. If you call `engine.start()` without `options.id`, Weft generates a fresh `crypto.randomUUID()` and starts a new execution.

> [!NOTE]
> `MemoryStorage` (also exported from `weft`) is fine for tests and ephemeral scripts, but it lives in process memory---a crash takes the checkpoints with it. Use a persistent backend like `SQLiteStorage` whenever durability actually matters.

## How It Works

Weft uses a **checkpoint model**, not a replay model. This is the single most important design decision and it shapes everything else.

In a replay-based system (Temporal, Cadence), the workflow runtime re-executes your function from the beginning on every recovery, replaying recorded activity results to reconstruct state. That's why those systems demand strict determinism---no `Date.now()`, no `Math.random()`, no random control flow---and why they need separate sandboxes, bundlers, and version-pinning protocols.

Weft does the opposite. At each `yield*`, the engine snapshots the workflow's current state---the values of local variables in scope at that boundary, plus the position in the generator---using `structuredClone` semantics, and writes that snapshot to storage. On recovery the engine reads the snapshot and resumes from the same boundary. Your code can use `Date.now()`, `Math.random()`, dynamic imports, anything---because nothing replays. The checkpoint is the source of truth for "where am I and what do I know."

A few consequences fall out of this:

- **Checkpoint size is bounded by live state, not history length.** Long-running workflows don't accumulate ever-growing event logs. The snapshot reflects whatever's currently in scope at the yield boundary, so a workflow that processes 100 large API responses but only retains a summary checkpoints just that summary.
- **No `continueAsNew` ceremony.** Workflows can run for years without special handling.
- **Native agent loops.** Each tool call inside an agent loop is its own checkpoint boundary, so dynamic LLM-driven control flow is just generator code.

## Core Concepts

| Concept              | What it is                                                                                                                    |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| **Workflow**         | A generator function the engine drives to completion. Every `yield*` is a checkpoint.                                         |
| **Activity**         | A named unit of side-effecting work registered with the engine and dispatched by a workflow with `ctx.run(activity, input)`.  |
| **Checkpoint**       | A serialized snapshot of a workflow's position and local variables, written at every yield.                                   |
| **Signal**           | A fire-and-forget message sent _into_ a running workflow. Workflows pause at `ctx.waitForSignal()` until one arrives.         |
| **Update**           | A request-response message sent into a running workflow. The caller blocks until the workflow returns a result.               |
| **Query**            | A read-only peek at a running workflow's state. Never mutates anything.                                                       |
| **Search attribute** | Indexed metadata on a workflow (customer ID, region, status) set via `ctx.setAttribute()` and queryable through the list API. |
| **Worker**           | A process or thread that executes activities. Inline by default; can run remote over WebSocket.                               |
| **Interceptor**      | A composable hook that wraps context operations for tracing, validation, encryption, or any cross-cutting concern.            |
| **Agent**            | A durable LLM execution loop registered via `defineAgent()` or invoked inline with `ctx.agent()`.                             |
| **Shared state**     | A compare-and-swap (CAS) durable mutable primitive for safe concurrent reads and writes across workflows.                     |

## Features

### Durable Workflows

Generator functions with automatic checkpointing at every `yield*` boundary. Activities, sleeps, signals, queries, updates, parallel execution via `ctx.all()`, race semantics via `ctx.race()`, memoization via `ctx.memo()`, sagas via `ctx.saga()`, child workflows, and forks.

```typescript
engine.register('checkout', async function* (ctx, order) {
  const charge = yield* ctx.run(chargeCard, { payment: order.payment });
  yield* ctx.run(reserveInventory, { items: order.items });

  const [confirmation, shipment] = yield* ctx.all([
    ctx.run(sendConfirmation, { email: order.email, receiptId: charge.receiptId }),
    ctx.run(scheduleShipping, { address: order.address }),
  ]);

  return { status: 'completed', charge, confirmation, shipment };
});
```

If `scheduleShipping` fails, `sendConfirmation`'s result is recorded in the parent operation's cache entry before the error is thrown into the workflow. If the workflow catches and yields again (e.g., to retry shipping or compensate), the next checkpoint persists that entry---a resumed run reuses the confirmation result instead of sending a duplicate email. See the [parallel execution guide](documentation/guides/parallel-execution.md) for the precise failure-semantics contract, including the catch-and-yield requirement.

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
const handle = await engine.start('approval', { orderId: 'order-123' });
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
  attributes: [
    { key: 'customerId', value: 'acme' },
    { key: 'status', value: 'shipped' },
  ],
});
```

### AI Agents

Weft adds durability to your agent loop. Bring your provider; bring your tools. Weft drives the loop, checkpoints at every tool-call boundary, and survives crashes mid-conversation.

```typescript
import { Engine, defineAgent, type AgentTool, type LLMProvider } from 'weft';
import { BunSQLiteStorage } from 'weft/storage/sqlite/bun';
import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic();

// Satisfy the structural LLMProvider interface with any SDK.
const provider: LLMProvider = {
  name: 'anthropic',
  async chat(messages, options) {
    const response = await client.messages.create({
      model: options.model,
      max_tokens: options.maxTokens ?? 8096,
      system: options.systemPrompt,
      messages: messages.map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content })),
    });
    const firstBlock = response.content[0];
    return {
      content: firstBlock?.type === 'text' ? firstBlock.text : '',
      toolCalls: [],
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
        totalTokens: response.usage.input_tokens + response.usage.output_tokens,
      },
      model: response.model,
      stopReason: response.stop_reason === 'end_turn' ? 'end_turn' : 'tool_use',
    };
  },
};

declare const webSearch: AgentTool;
declare const factCheck: AgentTool;
declare const dataQuery: AgentTool;

const researcher = defineAgent({
  name: 'research',
  model: 'claude-sonnet-4-20250514',
  systemPrompt: 'You are a research analyst.',
  tools: [webSearch, factCheck, dataQuery],
  maxTurns: 25,
});

const engine = new Engine({ storage: new BunSQLiteStorage('./weft.db') });
engine.register(researcher, { provider });

const handle = await engine.start('research', 'How did the 2026 Treasury auction go?');
const { messages, turnUsage } = await handle.result();
```

Crash after 7 of 30 tool calls and the agent picks up at tool call 8---no replay, no re-execution of side effects.

### Pluggable Storage

A small `Storage` interface over string keys and `Uint8Array` values: five required methods (`get`, `put`, `delete`, `scan`, `batch`) plus optional capabilities (`conditionalBatch`, `has`, `deletePrefix`) that adapters can implement when their backend supports them. Built-in adapters:

- **`MemoryStorage`** for development and tests
- **`SQLiteStorage`** (subpath `weft/storage/sqlite`) for SQLite persistence; Bun resolves to `BunSQLiteStorage`, Node resolves to `NodeSQLiteStorage`
- **`BunSQLiteStorage`** (subpath `weft/storage/sqlite/bun`) for an explicit Bun SQLite override
- **`NodeSQLiteStorage`** (subpath `weft/storage/sqlite/node`) for an explicit Node.js SQLite override via `better-sqlite3`
- **`LMDBStorage`** (subpath `weft/storage/lmdb`) for embedded high-throughput workloads
- **`TursoStorage`** (subpath `weft/storage/turso`) for distributed libSQL deployments
- **`IndexedDBStorage`** (subpath `weft/storage/indexeddb`) for browser environments
- **`WebExtensionStorage`** (subpath `weft/storage/web-extension`) for extension contexts using `browser.storage` or `chrome.storage`
- **`HTTPStorage`** (subpath `weft/storage/http`) for remote storage over Weft's HTTP storage routes
- **`CompressedStorage`** wrapper for transparent `gzip` or `brotli` compression

Bring your own backend by implementing the interface---five methods is enough.

### Server Mode

`serve()` wraps `Bun.serve()` to expose your engine over HTTP and WebSocket with a versioned REST API.

```typescript
import { Engine } from 'weft';
import { serve } from 'weft/server';
import { SQLiteStorage } from 'weft/storage/sqlite';

const engine = new Engine({ storage: new SQLiteStorage('./weft.db') });
engine.register('checkout', checkoutWorkflow);

await using server = serve({ engine, port: 7233 });
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

The core engine runs inside a Web Worker, with a Service Worker acting as the durable persistence layer over `IndexedDB`. Browser-compatible workflow logic ships across server and browser without modification---useful for offline-first apps that need durable client-side workflows. Activities, storage adapters, and other environment-bound pieces still need browser-safe implementations: use `IndexedDBStorage` or `WebExtensionStorage` instead of SQLite storage, swap server-only activities for `fetch`-based equivalents, and so on. See the [Service Worker guide](documentation/guides/service-worker.md) for the browser runtime wiring.

### Multi-Tenancy

Built-in tenant resolution and per-tenant quotas. Resolve tenants from any field on the workflow input, then attach quotas to control workflow creation rate, concurrency, or storage usage per tenant.

```typescript
import { Engine, tenantFromInputField } from 'weft';

const engine = new Engine({
  tenantResolver: tenantFromInputField('customerId'),
  quotas: {
    maxConcurrentWorkflows: 100,
    maxWorkflowCreationRate: { count: 60, window: '1m' },
    maxStorageBytes: 50_000_000,
  },
});
```

The [Multi-Tenancy guide](documentation/guides/multi-tenancy.md) covers tenant resolution, quota enforcement, storage isolation, remote workers, and security boundaries.

### Observability

Built-in event system (`EventTarget`-based, so it composes with everything), W3C `traceparent` propagation, and OpenTelemetry-compatible metrics. Composable interceptors layer cross-cutting concerns---tracing, validation, encryption---without any of them knowing about each other.

```typescript
import { createObservabilityInterceptors, createOpenTelemetryMetrics } from 'weft';

const metrics = createOpenTelemetryMetrics({
  /* your meter provider */
});
const interceptors = createObservabilityInterceptors({ metrics });

const engine = new Engine({
  storage,
  interceptors: [interceptors.interceptor],
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

Storage backends and adapters are exported under subpaths so they only load when imported:

```typescript
import { SQLiteStorage } from 'weft/storage/sqlite';
import { LMDBStorage } from 'weft/storage/lmdb';
import { TursoStorage } from 'weft/storage/turso';
import { IndexedDBStorage } from 'weft/storage/indexeddb';
import { WebExtensionStorage } from 'weft/storage/web-extension';
import { HTTPStorage } from 'weft/storage/http';
```

The `bun` runtime version `1.3.0` or later is required.

## Step API for `async`/`await` Users

If generator syntax is unfamiliar, the same workflow can be written with `ctx.step()` calls and plain `async`/`await`:

```typescript
engine.register('welcome', async (ctx, input: { name: string }) => {
  const greeting = await ctx.step('greet', () => greet(input.name));
  await ctx.step('notify', () => notify(greeting));
  return { greeting, notified: true };
});
```

Each `ctx.step()` is a checkpoint boundary. The engine compiles step-style workflows to generator form at registration time. When you need durable timers, signals, or parallel execution, switch to the generator API.

## Weft vs. Temporal

| Concept                | Temporal                                      | Weft                                                                       |
| ---------------------- | --------------------------------------------- | -------------------------------------------------------------------------- |
| Core mental model      | Replay determinism                            | Generators pause and resume                                                |
| Workflow language      | Go, Java, TypeScript, Python, .NET, Ruby, PHP | TypeScript only (activities can be any language via `RemoteWorker`)        |
| Activity invocation    | `proxyActivities()` + type import             | `yield* ctx.run(namedActivity, input)`                                     |
| Timer                  | Deterministic `workflow.sleep()`              | `yield* ctx.sleep("1 hour")`                                               |
| Signal                 | `setHandler` + `condition`                    | `yield* ctx.waitForSignal(name)`                                           |
| Versioning             | `patched()` / `deprecatePatch()`              | Deploy new code (migration optional)                                       |
| Long-running workflows | `continueAsNew()`                             | None needed (checkpoint size is bounded by live state, not history length) |
| Agent declaration      | N/A (build from primitives)                   | `defineAgent()` or `ctx.agent()`—bring your own provider and tools         |
| Durable agent loop     | Activity boundary only                        | Every tool call is a checkpoint boundary                                   |
| Dev environment        | Docker Compose + Temporal server              | `bun add weft`                                                             |
| Bundling               | Webpack for workflow sandbox                  | None                                                                       |

> Weft is for teams whose primary backend language is TypeScript. If you need workflows in multiple languages, [Temporal](https://temporal.io) is the right answer. For the design rationale, see [ADR 0001 — Workflows Are TypeScript-Only by Design](documentation/contributing/architecture-decisions/0001-workflows-typescript-only.md).

## Documentation

Getting started:

- [Installation](documentation/getting-started/installation.md)
- [Hello World](documentation/getting-started/hello-world.md)
- [Key Concepts](documentation/getting-started/key-concepts.md)

Guides:

- [Workflows](documentation/guides/workflows.md), [Activities](documentation/guides/activities.md), [Storage](documentation/guides/storage.md), [Server](documentation/guides/server.md)
- [Signals and Queries](documentation/guides/signals-and-queries.md), [Synchronous Updates](documentation/guides/synchronous-updates.md)
- [Durable Timers](documentation/guides/durable-timers.md), [Timeouts](documentation/guides/timeouts.md), [Parallel Execution](documentation/guides/parallel-execution.md)
- [Search Attributes](documentation/guides/search-attributes.md), [Multi-Tenancy](documentation/guides/multi-tenancy.md), [Shared State](documentation/guides/shared-state.md), [Session State](documentation/guides/session-state.md), [Events](documentation/guides/events.md)
- [Interceptors](documentation/guides/interceptors.md), [Observability](documentation/guides/observability.md), [Testing](documentation/guides/testing.md)
- [Workflow Versioning](documentation/guides/workflow-versioning.md), [Remote Workers](documentation/guides/remote-workers.md), [Service Worker](documentation/guides/service-worker.md), [Resource Management](documentation/guides/resource-management.md)

Agents:

- [Agent Overview](documentation/agents/agent-overview.md), [Declaration](documentation/agents/agent-declaration.md), [Tools](documentation/agents/agent-tools.md)
- [Human Review](documentation/agents/agent-human-review.md), [Coordination](documentation/agents/agent-coordination.md)
- [Observability](documentation/agents/agent-observability.md), [What Weft Owns](documentation/agents/what-weft-owns.md)

Architecture and reference:

- [Design Philosophy](documentation/architecture/design-philosophy.md), [Checkpoint vs. Replay](documentation/architecture/checkpoint-versus-replay.md), [Web Standards](documentation/architecture/web-standards.md)
- [Browser Runtime](documentation/architecture/browser-runtime.md), [Web Workers](documentation/architecture/web-workers.md), [Single Binary](documentation/architecture/single-binary.md)
- [API Reference](documentation/reference/) (Engine, Context, Storage, Server, Workers, Agent, Testing, Events, Interceptors, Observability, CLI, Configuration, Types)

## License

MIT
