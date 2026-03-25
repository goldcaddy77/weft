---
paths:
  - src/dashboard/**/*.svelte
  - src/dashboard/**/*.svelte.ts
---

# Svelte 5 Patterns

Before editing paths in this rule, load `$component-standards` and apply its constraints.

## Reactivity

- `$derived` is read-only. Use `$state` + `$effect` when mutation is needed.
- Use `$derived(expression)` for simple expressions, `$derived.by(() => { ... })` for multi-statement logic. Never use `$derived(() => ...)` — this creates a derived that holds a function, not the computed result.
- No mutations in `$derived` blocks. Use non-mutating alternatives like `[...array].sort()` or `array.toSorted()`.
- `$effect` tracks reads. Avoid read+write loops; use `untrack()` or non-reactive `let` for bookkeeping.
- Getter functions for selective dependency tracking: pass a getter instead of a value to defer reads inside `untrack()`.
- Async safety: after `await`, check `element.isConnected` before touching DOM references.
- Cleanup: clear all timers/observers in `$effect` cleanup.
- Do not recompute absolute timestamps from stale data in `$derived`; use `$state` and update only when new data arrives.

## WebSocket and real-time updates

- Always close `WebSocket` connections in the `$effect` cleanup function.
- Handle reconnection state in the UI when the connection drops.
- Parse incoming messages defensively with try/catch.
- Track the connection URL as a dependency to reconnect when it changes.
- Cap in-memory buffers to avoid unbounded growth.

## Interval-based countdown

- Store interval ID in `$state` if external cancellation is needed.
- Clear interval both in cleanup and when countdown reaches zero.
- Check conditions before starting the interval; provide a cancel function.

## Async callback loading state

- Guard against double-submission with an early return check.
- Use `try/finally` to ensure loading state is cleared even on error.
- Pass `aria-busy={isLoading}` to buttons for accessibility.

## Collections

- Count alone cannot detect append versus prepend; track stable IDs.
- Pre-compute filtered lists so `data-count` matches rendered items.

## Input handling

- Debounced editors: read latest content from the editor API at submit time.
- IME composition: check `event.isComposing` before Enter-to-submit.
- Validate consistently across all input paths (paste, drop, file picker).
- Do not use `bind:value={getter, setter}`; Svelte expects a writable store or local variable. Use `$bindable()` or explicit `oninput` handlers instead.
- Do not combine `bind:value`/`$bindable()` with explicit `onchange` callbacks for the same field; choose one data flow to avoid double updates.

## Two-way binding with `$bindable()`

- Use `$bindable()` instead of bridging with internal state plus effects.
- Eliminates bridge code and allows state to flow naturally through the component tree.

## Anti-patterns

- `$derived(() => ...)` with a function argument (holds a function, not a result).
- Mutations inside `$derived` or `$derived.by()`.
- Read+write loops in `$effect` without `untrack()`.
- Missing `element.isConnected` check after `await` in effects.
- Missing cleanup for timers, observers, or WebSocket connections in `$effect`.
- Using `$derived` for absolute timestamps that should only update on specific events.
- Bridge pattern (`internal state` + dual `$effect` sync) instead of `$bindable()`.
- Using `$app/*` imports — this is not a SvelteKit project.
