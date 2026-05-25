# Agent-Native Engine (removed in v0.1.0)

Weft's built-in agent surface — `ctx.agent()`, `ctx.handoff()`, `ctx.debate()`, `ctx.supervise()`, the `weft.agent()` declaration, the agent runtime, and all agent types and events — was removed in v0.1.0. Weft does not ship an agent primitive.

Build durable agent loops on `ctx.run()` and `ctx.review()`, or run an external agent framework from inside an activity. The two approaches recover at different granularities: model each LLM call and each tool call as its own `yield* ctx.run(...)` step and Weft checkpoints every one independently, so a crash resumes mid-loop. Run a whole framework loop inside a single activity and that activity is opaque to the engine — it checkpoints only at its boundary, so a crash re-runs the entire loop. Expose the internal turns as separate `ctx.run()` steps if you want yield-level recovery. Either way, `ctx.review()` provides the human-in-the-loop step, and cost tracking, budget enforcement, model routing, and context-window management live in that userland loop (or the framework), not in the engine.

See the [`CHANGELOG`](../../CHANGELOG.md) for the full list of removed exports and the migration path.
