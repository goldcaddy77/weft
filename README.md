# Weft

A Bun-native durable execution engine.

> _Weft_---the cross-threads in weaving that bind the warp together.

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

## Hello World

```typescript
import { Engine, MemoryStorage } from 'weft';

const engine = new Engine({ storage: new MemoryStorage() });

async function greet(name: string) {
  return `Hello, ${name}!`;
}

engine.register('welcome', async function* (ctx, user: { name: string }) {
  const greeting = yield* ctx.run(greet, user.name);
  yield* ctx.sleep('1 hour');
  return { greeting, onboarded: true };
});

const handle = await engine.start('welcome', { name: 'Steve' });
console.log(await handle.result());
// { greeting: "Hello, Steve!", onboarded: true }
```

That's a complete durable workflow. If the process crashes after `greet` finishes but before the sleep expires, Weft restores the checkpoint and resumes from exactly that point. No replay, no determinism constraints, no special imports.

## Features

- **Durable Workflows** --- Generator functions with automatic checkpointing at every `yield*` boundary. Activities, sleeps, signals, updates, parallel execution via `ctx.all()`, and memoization via `ctx.memo()`.
- **AI Agents** --- First-class ReAct loop with tool calling, budget enforcement, human-in-the-loop review, model routing, context window management, and multi-agent coordination (handoff, supervision, debate).
- **Pluggable Storage** --- `MemoryStorage` for development, `BunSQLiteStorage` for production, or bring your own implementation of the `Storage` interface.
- **Single Binary Distribution** --- `bun build --compile` produces a standalone executable with the engine, server, and web dashboard embedded. Download, run, done.
- **Server Mode** --- HTTP + WebSocket server with a REST API and a built-in dashboard. Remote workers connect over WebSocket.
- **Browser Support** --- The core engine runs in Web Workers. Same workflow code ships to the browser.
- **Observability** --- Built-in event system, tracing propagation, and metrics. Composable interceptors for cross-cutting concerns.
- **Testing** --- `TestEngine` with `TimeControl` for deterministic time-travel tests. `ActivityMockRegistry` for isolated unit tests.

## Installation

```bash
bun add weft
```

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

- [Installation](docs/getting-started/installation.md)
- [Hello World](docs/getting-started/hello-world.md)
- [Key Concepts](docs/getting-started/key-concepts.md)

## License

MIT
