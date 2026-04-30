# Key Concepts

Weft has a handful of core ideas that show up everywhere. This page defines each one so you have a shared vocabulary for the rest of the documentation.

## Workflow

A **workflow** is a multi-step durable process defined as a generator function. It's the orchestrator---it decides what to do and in what order. Workflows don't perform side effects directly. Instead, they dispatch activities and coordinate the results.

```typescript partial
engine.register('checkout', async function* (ctx, order) {
  const charge = yield* ctx.run(chargeCard, order.payment);
  yield* ctx.run(reserveInventory, order.items);
  yield* ctx.run(sendConfirmation, order.email, charge.receiptId);
  return { status: 'completed' };
});
```

Every `yield*` in a workflow is a checkpoint boundary. The engine saves the workflow's position after each one, so it can resume from that exact point if something goes wrong.

## Activity

An **activity** is a single unit of work dispatched by a workflow. This is where side effects happen---API calls, database writes, sending emails. An activity is just a regular async function. Nothing special about it.

```typescript
async function sendConfirmation(email: string, receiptId: string) {
  await fetch('https://api.email.com/send', {
    method: 'POST',
    body: JSON.stringify({ to: email, receiptId }),
  });
}
```

You run activities with `yield* ctx.run(fn, ...args)`. If an activity throws, the engine retries it according to the retry policy. Activities are the boundary between your deterministic workflow logic and the messy outside world.

## Checkpoint

A **checkpoint** is a snapshot of a workflow's current position and local variables. Every time a workflow yields, the engine serializes its state and writes it to storage. If the process crashes, the engine loads the most recent checkpoint and resumes from there.

This is fundamentally different from replay-based systems like Temporal. Weft doesn't re-execute your workflow from the beginning. It literally picks up where it left off. That's why checkpoints are fixed-size---long-running workflows don't accumulate ever-growing history.

## Signal

A **signal** is an external message sent _into_ a running workflow. Use signals when something outside the workflow needs to tell it something---a user clicking "approve," a webhook arriving, a timer in another system firing.

```typescript partial
// Inside the workflow:
const approval = yield * ctx.waitForSignal<{ approved: boolean }>('approval');

// From outside:
await engine.signal(workflowId, 'approval', { approved: true });
```

Signals are fire-and-forget from the sender's perspective. The workflow pauses at `waitForSignal()` until the signal arrives, which could be seconds or weeks.

## Update

An **update** is a synchronous message sent into a running workflow that blocks the caller until the workflow processes it and returns a result. Unlike signals (fire-and-forget), updates are request-response. Use them when the caller needs an answer back from the workflow.

## Query

A **query** is a read-only peek into a running workflow's state. Queries never mutate anything---they just let you inspect what a workflow is doing right now.

## Worker

A **worker** is a process or thread that executes activities. In library mode, activities run inline in the same process. In server mode, workers connect over WebSocket, pull tasks from the server, execute them, and report results back.

Weft also uses standard Web Workers internally to isolate workflow execution from the HTTP server's main thread.

## Search Attribute

A **search attribute** is user-defined indexed metadata on a workflow---things like customer ID, region, or priority. You set them inside a workflow with `ctx.setAttribute()`, and they become queryable through the list API. They're stored as secondary indexes in the storage layer.

```typescript partial
engine.register('order', async function* (ctx, input) {
  ctx.setAttribute('customerId', input.customerId);
  ctx.setAttribute('status', 'processing');
  // ... do work ...
  ctx.setAttribute('status', 'shipped');
  return 'done';
});
```

## Session State

**Session state** is per-workflow durable state addressable by key, returned as a typed `WorkflowSessionState<T>` slot from `ctx.sessionState(key, initialValue?)`. Unlike search attributes (which are queryable indexes), session state is private to the workflow and survives checkpoint recovery. Access it with `.get()`, `.set()`, `.update()`, `.clear()`, or `.run()` for memoized operations over the slot's value.

```typescript partial
engine.register('counter', async function* (ctx, input) {
  const counter = ctx.sessionState<number>('count', 0);
  counter.set((counter.get() ?? 0) + 1);
  return counter.get();
});
```

Because session state is checkpointed alongside the workflow, the counter persists across process restarts.

## Interceptor

An **interceptor** is a composable hook that wraps workflow context operations---activities, sleeps, signals---for cross-cutting concerns like tracing, validation, and encryption. Interceptors chain via `next()` delegation, so you can stack as many as you need without any of them knowing about each other.

## Agent

An **agent** is a durable LLM-powered execution loop that follows the ReAct pattern: one LLM call, then tool calls, then another LLM call, and so on. Agents are registered as workflows via `defineAgent()` or invoked as a step within a larger workflow via `ctx.agent()`. They manage context windows, respect token budgets, and support human-in-the-loop review.

## Turn

A **turn** is a single iteration of an agent loop: one LLM call and its resulting tool calls. Each turn is a checkpoint boundary, which means the agent survives crashes mid-conversation. If the process dies between turn 5 and turn 6, it picks up at turn 6 on restart.

## Model Router

A **model router** is a pluggable component that selects which LLM model to use for each turn. You might route based on conversation complexity, cost constraints, or quality requirements---starting with a cheap model and escalating to a more capable one when the task demands it.

## Context Strategy

A **context strategy** is a pluggable component that manages conversation history within the LLM's context window. As conversations grow, you need to decide what to keep and what to drop. Strategies like sliding window, summarization, or RAG let you control this without touching your agent logic.

## MCP (Model Context Protocol)

**MCP** is a standard protocol for discovering and invoking LLM tools from external servers. Weft's MCP client supports both stdio and HTTP+SSE transports, so your agents can call tools hosted anywhere without coupling to a specific provider.

## Shared State

**Shared state** is a CAS-backed (compare-and-swap) durable mutable state primitive. Multiple concurrent agents or workflows can read from and write to it without clobbering each other's writes. Think of it as a durable, conflict-safe scratchpad.

## Human Review

**Human review** is a structured interaction protocol for human-in-the-loop workflows. When an agent or workflow reaches a decision that needs human oversight, it can pause and request approval, rejection, conversation threading, escalation, or partial approval. The workflow stays checkpointed while waiting---it costs nothing to wait for a human.

## How They Fit Together

A workflow orchestrates activities, sleeping between them when needed. Signals and updates let the outside world communicate with running workflows. Checkpoints make the whole thing durable. For AI workloads, agents extend the workflow model with turns, model routing, context strategies, and human review. Storage, interceptors, and search attributes handle the operational concerns underneath.

That's the vocabulary. Now you can dig into the specific guides knowing what each term means.
