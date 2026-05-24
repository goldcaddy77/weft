# Agent-Native Engine (removed in v0.1.0)

Weft's built-in agent surface — `ctx.agent()`, `ctx.handoff()`, `ctx.debate()`, `ctx.supervise()`, the `weft.agent()` declaration, the agent runtime, and all agent types and events — was removed in v0.1.0. Weft does not ship an agent primitive.

Build durable agent loops on `ctx.run()` and `ctx.review()`, or run them inside an external agent framework you call from an activity. Each LLM call and tool call becomes a `yield* ctx.run(...)` boundary that Weft checkpoints independently; `ctx.review()` provides the human-in-the-loop step. Cost tracking, budget enforcement, model routing, and context-window management live in that userland loop (or the framework you run inside it), not in the engine.

See the [`CHANGELOG`](../../CHANGELOG.md) for the full list of removed exports and the migration path.
