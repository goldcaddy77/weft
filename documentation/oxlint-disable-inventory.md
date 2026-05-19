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

## `core-engine-bulk-operations-file-length`

- **File**: `src/core/engine/bulk-operations.ts`
- **Rule**: `max-lines`
- **Symbol**: `(whole file)`
- **Reason**: Bulk operations and terminal purge share the same workflow-state scan, confirmation, audit, and cleanup helpers. Splitting the file while this surface is still being actively expanded would make the destructive-action review path harder to audit; revisit when retry and recover bulk actions are added.

## `core-engine-decode-schedule-runtime-fields-complexity`

- **File**: `src/core/engine/index.ts`
- **Rule**: `complexity`
- **Symbol**: `decodeScheduleRuntimeFields`
- **Reason**: Pre-existing complexity violation; tracked by oxlint-strict initiative for refactor.

## `core-engine-callback-creators-file-length`

- **File**: `src/core/engine/callback-creators.ts`
- **Rule**: `max-lines`
- **Symbol**: `(whole file)`
- **Reason**: Callback-bundle factory hub created in PR 32b. Splitting further has diminishing returns; keeping all factories in one place keeps the Engine class shim definitions easy to follow.

## `core-engine-index-file-length`

- **File**: `src/core/engine/index.ts`
- **Rule**: `max-lines`
- **Symbol**: `(whole file)`
- **Current size**: ~1464 lines after this pass extracted construction helpers and local types to `src/core/engine/construction.ts` (~197 lines). The remaining bulk is the `Engine` class itself (~960 lines).
- **Rejected alternatives**:
  - Splitting the `Engine` class via `interface` declaration merging: loses generic preservation across `withWorkflow`/`withActivity` builders, breaks the chained-builder type inference that is the whole point of the typed registry.
  - Splitting the `Engine` class via prototype assignment in sibling modules: alters generated `.d.ts` output and JSDoc attachment for the public class, downgrades inference on static `Engine.create` overloads, and creates a runtime ordering hazard.
  - Lowering the `max-lines` threshold or raising it just for this file: lint policy is enforced globally; per-file overrides are not the project's pattern (see how `.oxlintrc.json` handles test files only via glob, not per-file allowlists).
- **Reason**: the class itself is ~960 lines of public method shims and type plumbing; everything separable from it has been extracted. No further extraction is possible without splitting the public class declaration, which the rejected alternatives above show is not viable.


## `core-engine-validation-file-length`

- **File**: `src/core/engine/validation.ts`
- **Rule**: `max-lines`
- **Symbol**: `(whole file)`
- **Reason**: Pre-existing oversized file; tracked by oxlint-strict initiative for split.

## `core-engine-get-timeline-basic-input-summary-complexity`

- **File**: `src/core/engine/index.ts`
- **Rule**: `complexity`
- **Symbol**: `getTimelineBasicInputSummary`
- **Reason**: Pre-existing complexity violation; tracked by oxlint-strict initiative for refactor.

## `core-engine-get-timeline-operation-label-complexity`

- **File**: `src/core/engine/index.ts`
- **Rule**: `complexity`
- **Symbol**: `getTimelineOperationLabel`
- **Reason**: Pre-existing complexity violation; tracked by oxlint-strict initiative for refactor.

## `core-engine-is-workflow-timeline-entry-complexity`

- **File**: `src/core/engine/index.ts`
- **Rule**: `complexity`
- **Symbol**: `isWorkflowTimelineEntry`
- **Reason**: Pre-existing complexity violation; tracked by oxlint-strict initiative for refactor.

## `core-engine-matches-list-filter-complexity`

- **File**: `src/core/engine/state-utilities.ts`
- **Rule**: `complexity`
- **Symbol**: `matchesListFilter`
- **Reason**: Single defensive post-filter for the workflow visibility surface — each branch maps to one indexed filter dimension (status, type, tenant, idPrefix, createdAt, updatedAt, executionDeadline, failureCategory). Splitting the function would scatter the per-dimension contract that the index helpers and tests assert against a single point of truth.

## `core-engine-matches-schedule-filter-complexity`

- **File**: `src/core/engine/index.ts`
- **Rule**: `complexity`
- **Symbol**: `matchesScheduleFilter`
- **Reason**: Pre-existing complexity violation; tracked by oxlint-strict initiative for refactor.

## `core-engine-normalize-schedule-filter-complexity`

- **File**: `src/core/engine/index.ts`
- **Rule**: `complexity`
- **Symbol**: `normalizeScheduleFilter`
- **Reason**: Pre-existing complexity violation; tracked by oxlint-strict initiative for refactor.

- **File**: `src/observability/index.ts`
- **Rule**: `complexity`
- **Symbol**: `createObservabilityInterceptors`
- **Reason**: Pre-existing complexity violation; tracked by oxlint-strict initiative for refactor.

- **File**: `src/observability/index.ts`
- **Rule**: `max-lines`
- **Symbol**: `(whole file)`
- **Reason**: Pre-existing oversized file; tracked by oxlint-strict initiative for split.

- **File**: `src/observability/index.ts`
- **Rule**: `complexity`
- **Symbol**: `handleEvent`
- **Reason**: Pre-existing complexity violation; tracked by oxlint-strict initiative for refactor.

