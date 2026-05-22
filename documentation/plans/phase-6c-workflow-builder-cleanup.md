# Phase 6C — Workflow-builder refactor cleanup

## Context

The tRPC-style workflow-builder refactor landed on branch
`refactor/workflow-builder-trpc` across 14 commits (Phases 1–5 + most of 6A/6B).
The new builder API ships as the canonical, documented, type-safe path; the
legacy `engine.register(name, handler)` / `engine.register(name, registration)`
/ `engine.register(activityDefinition)` overloads and the bare-function
`workflow(handler)` overload remain in place behind `@deprecated` JSDoc
markers as a temporary bridge.

This task closes out the refactor by:

1. Converting the last test file that still uses the deprecated overloads.
2. Deleting the deprecated overloads, the bridge types, and the global
   `ActivityTypes` augmentation interface.
3. Running the final declaration audit for `any`/`unknown` leaks in public
   exports.

Once shipped, the only path to register a workflow or activity is the new
chained builder; the global module-augmentation `ActivityTypes` interface no
longer exists.

## Scope

### What ships in this PR

- `src/core/engine.test.ts` converted from the deprecated overloads to the
  builder API (152 `engine.register('name', generator|{handler,…})` call sites,
  ~6,500 lines).
- The following legacy overloads deleted from `src/core/engine/index.ts` and
  `src/core/engine/registration.ts`:
  - `engine.register(name: string, handler: WorkflowFunction): void`
  - `engine.register(name: string, registration: WorkflowRegistration): void`
  - `engine.register(activityDefinition: AnyActivityDefinition): void`
- The bare-function `workflow(handler)` overload deleted from
  `src/core/types/workflow-function.ts`.
- `WorkflowRegistration`, `WorkflowDefinitionOptions` types deleted from
  `src/core/types/workflow-definition.ts`.
- Global `ActivityTypes` augmentation interface deleted from
  `src/core/types/workflow-registries.ts` along with
  `UnknownActivityNameWhenRegistryIsEmpty` and any helpers that referenced it.
- The `ctx.run<TName extends keyof ActivityTypes>` global-augmentation
  overload deleted from `src/core/types/workflow-context.ts`.
- Public declaration audit: enumerate the exported types
  `WorkflowBuilder`, `WorkflowContext`, `WorkflowDefinition`,
  `NormalizeActivities`, `ActivityArgsFor`, `ActivityResultFor`,
  `SignalPayload`, `Engine`, `Engine.register` return type, `Engine.start`
  return type, and helper exports. For each, build the emitted `.d.ts` and
  confirm no `any` / `unknown` leak in generic positions that should be
  inferred. Fix any leaks discovered.
- All eight verification gates pass: `bun run typecheck`,
  `bun run typecheck:tests`, `bun run lint`, `bun test`, `bun run build`,
  `bun ./dist/index.js examples/hello-world.ts`, `bun run verify:documentation`,
  `bun run verify:jsdoc:full`.

### What does NOT ship in this PR

- Any new builder methods (e.g. `.replace()` or `.upgrade()` for the
  re-registration case skipped in workflow-retention.test.ts) — separate
  design + RFC.
- Removing the `recovered.register(workflow)` two-engine pattern.
- Examples directory changes beyond what already shipped.

## The engine.test.ts conversion (the hard part)

Earlier auto-conversion of this file produced an output that deadlocked at
test load when run as a single batch (`bun test src/core/engine.test.ts`).
Individual tests selected via `bun test -t "<pattern>"` ran fine in ~100 ms;
the full 200-test run wedged at 0% CPU with no output past the bun banner.
Hypothesis: shared resource contention from too many fresh `Engine` instances
allocated inside test bodies that never reach disposal, compounded by
deep-freeze cost on every `.execute()` call during 200 sequential tests.

This PR converts the file by hand, in slices, validating with the full file
test run after every ~10 calls. Strategy:

1. **Module-scope shared workflows.** Many tests reuse the same workflow type
   string (e.g. `'greet'`, `'workflow1'`). Extract those to module-scope
   `const greetWorkflow = workflow({ name: 'greet' }).execute(...)` once;
   each test calls `engine.register(greetWorkflow)`. Phase 3's same-reference
   idempotency rule lets multiple tests share. This is **load-bearing** — it
   prevents 200 independent deep-freezes on file load.

2. **Per-test workflows stay inline.** Workflows whose handler closes over a
   per-test variable (counters, signal targets) keep their builder call inside
   the `it()` body.

3. **Object-form metadata (`{ handler, version, retention, ... }`) moves to
   builder options** (`workflow({ name, version, retention, ... }).execute(fn)`).
   The `WorkflowBuilderOptions` interface already accepts every legacy
   `WorkflowRegistration` field except `handler` (which moves to `.execute()`).

4. **Pattern D tests** — tests whose subject is the deprecated overload
   itself (e.g. `it('register(name, fn) shorthand registers a workflow')`) —
   get deleted with a comment explaining why. The builder equivalent is
   covered by the file's other `register(builderWorkflow)` tests.

5. **Subprocess template literals** (`String.raw\`…engine.register('wf', …)…\``)
need an inline `import { workflow } from './src/core/types.ts'` added to
   their script body, and the registration converted inside the template
   literal. Three sites — already shaped correctly in earlier Phase 6 work.

### Slice plan (10 commits, ~15 calls each)

| Commit | Range             | Expected calls        | Why this slice                                      |
| ------ | ----------------- | --------------------- | --------------------------------------------------- |
| 1      | lines 1–1000      | ~24                   | initial register + first describe block             |
| 2      | lines 1000–1800   | ~30                   | metadata-bearing tests, schemas                     |
| 3      | lines 1800–2400   | ~22                   | engine-state and replay tests                       |
| 4      | lines 2400–3000   | ~18                   | search-attribute and visibility tests               |
| 5      | lines 3000–3600   | ~16                   | interceptor + child-workflow tests                  |
| 6      | lines 3600–4200   | ~12                   | review and signal tests                             |
| 7      | lines 4200–4800   | ~10                   | termination + cleanup tests                         |
| 8      | lines 4800–5400   | ~12                   | terminal-state subprocess tests (template literals) |
| 9      | lines 5400–6000   | ~8                    | activity-worker tests                               |
| 10     | overload deletion | (no test conversions) | delete the bridge                                   |

After each conversion commit, run `bun test src/core/engine.test.ts` foreground
**with `--timeout 5000`** and confirm a full pass before moving to the next
slice. If a slice hangs, bisect that slice; the cause is structural (resource
contention from shared state across the file's converted tests). Likely
remedies: tighten `engine[Symbol.dispose]()` calls, move more workflows to
module scope, or split the file into `engine.basic.test.ts` + `engine.advanced.test.ts`.

## Audit gates

After all 10 slice commits land and tests are green, run:

- `bun run typecheck` — clean.
- `bun run typecheck:tests` — clean.
- `bun run lint` — clean (no new oxlint-disable directives).
- `bun test` — full suite green, modulo the pre-existing
  `src/benchmarks/load-growth-memory.test.ts` flake on `main`.
- `bun run build` — clean.
- `bun ./dist/index.js examples/hello-world.ts` — completes successfully.
- `bun run verify:documentation`, `verify:markdown-doctests`,
  `verify:jsdoc:doctests`, `verify:jsdoc:full` — all clean.
- **Public declaration audit** — for each of the following exported types,
  open the emitted `dist/index.d.ts` and grep for `: any` or `: unknown` in
  generic positions: `WorkflowBuilder`, `WorkflowContext`,
  `WorkflowDefinition`, `BuiltWorkflowDefinition`, `NormalizeActivities`,
  `ActivityArgsFor`, `ActivityResultFor`, `SignalPayload`, `UpdatePayload`,
  `Engine`, `Engine.register` return type, `Engine.start` return type,
  `Engine.create` return type, `WorkflowAlreadyRegistered`. Any leaks in
  positions that should be inferred fail the audit; fix the underlying type
  before merging.
- **Manual export-surface diff review** against the branch's start point
  (`main` at `7ef08f82`). Confirm public exports include the intended
  helpers and exclude every deleted type/overload.

## Verification

End-to-end checks all required before merge:

1. **Type-level**: type tests under `src/core/types/__tests__/workflow-builder.test-d.ts`
   pass under `bun run typecheck:tests`. Declaration audit passes.
2. **Runtime**: `bun test` green. `examples/hello-world.ts` runs from `dist/`.
   Hot-add scenario from the docs works end-to-end. Per-workflow activity
   isolation pinned (workflow A's `formatGreeting` is not callable from
   workflow B).
3. **Remote worker**: worker advertises qualified `welcome.formatGreeting`
   names, server dispatches, completes. Old-`protocolVersion` worker rejected
   at handshake.
4. **Documentation**: README quickstart, JSDoc examples, and tutorials all
   compile under `verify:jsdoc:full`.

## Out of scope reminders (do not let these creep in)

- New builder methods (`.replace()`, `.upgrade()`, etc.).
- Re-introducing same-name-different-reference re-registration support.
- Renaming `WorkflowDefinition` to `BuiltWorkflowDefinition` everywhere.
- Splitting `engine.test.ts` into multiple files unless required to land
  Phase 6C cleanly.
- Worker SDK migration helpers beyond what Phase 4 already shipped.

## Risks and stop signals

- **If `bun test src/core/engine.test.ts` hangs after a slice lands**:
  bisect within the slice. Probable cause: too many active `Engine`
  instances. Add `engine[Symbol.dispose]()` to test bodies that omit it.
- **If declaration audit surfaces `any` / `unknown` leaks**: stop, do not
  paper over with type assertions. Fix the underlying generic. The plan's
  Phase 1 type tests catch this on the way in; the audit is the final
  exit gate.
- **If deleting an overload breaks ≥10 unrelated callers** that grep didn't
  surface: re-check the conversion sweep coverage and complete those before
  the deletion lands.
