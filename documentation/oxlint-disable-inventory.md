# oxlint Disable Inventory

This file is the registry of every `// oxlint-disable*` directive in `src/`.
Every directive in source carries an inline `-- ID:<name>` token; the ID must
have a matching section in this file. The check is enforced by
`bun run scripts/check-lint-disables.ts`, which runs as part of `bun run lint`.

Sections are sorted alphabetically by ID to minimise merge conflicts when
parallel PRs add or remove entries.

## Done criteria

The oxlint-strict initiative is complete when this file lists **at most 5
permanent suppressions**, each with a one-paragraph rationale and a comment
naming the alternative that was rejected.

## `core-engine-index-file-length`

- **File**: `src/core/engine/index.ts`
- **Rule**: `max-lines`
- **Symbol**: `(whole file)`
- **Current size**: ~1281 lines after extracting `EngineCreateOptions` and the internal type helpers to `src/core/engine/engine-create-types.ts`, the test-only leak-warning state to `src/core/engine/engine-leak-warnings.ts`, and the per-engine runtime callback factories (`createQueuedInlineWorkflowStartHandler`, `createCleanupIntervalTick`, `disposeEngineCleanupInterval`, `isActivityDefinition`) to `src/core/engine/engine-runtime-helpers.ts`. The remaining bulk is the `Engine` class itself (~960 lines of method shims, constructor wiring, and disposable lifecycle plumbing).
- **Generic-chain protection**: see `src/core/engine/builder-chain.test-d.ts` for compile-time assertions that `Engine.create({ workflows, activities })`, `engine.register(definition)`, and `engine.start(name, input)` continue to thread `TWorkflows`/`TActivities` generics through their overloads. Any future extraction that breaks the chained-builder inference will fail `bun run typecheck:tests` on that file.
- **Rejected alternatives**:
  - Splitting the `Engine` class via `interface` declaration merging plus `Object.assign(Engine.prototype, mixin)` in sibling modules: alters generated `.d.ts` output and JSDoc attachment for the public class, downgrades inference on static `Engine.create` overloads, and creates a runtime ordering hazard (callers can construct an engine before the mixin module has executed).
  - Splitting the `Engine` class by relocating only the non-generic methods to a sibling: same downsides as above; the runtime-ordering risk is the load-bearing objection because integrators can import `Engine` directly without transitively importing every sibling that owns a method.
  - Lowering the `max-lines` threshold or adding a per-file override in `.oxlintrc.json`: the project enforces lint policy globally; per-file overrides are not the convention (see how `.oxlintrc.json` only relaxes test files via glob, not per-file allowlists).
- **Reason**: the class itself is ~960 lines of public method shims, constructor wiring, and type plumbing for the chained-builder inference; everything separable from it has been extracted. No further extraction is possible without splitting the public class declaration, which the rejected alternatives above show is not viable.
