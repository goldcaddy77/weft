/**
 * Type-only foundation for the chained workflow builder API
 * (`workflow({ name }).activities({...}).signals({...}).execute(generator)`).
 *
 * The builder co-locates a workflow with its activity table, signal/update/query
 * maps, and search-attribute schema so that `ctx.run('activityName', input)`,
 * `ctx.waitForSignal('signalName')`, and `engine.start('workflowName', input)`
 * are all type-safe end-to-end without relying on global module augmentation.
 *
 * Helpers (`NormalizeActivities`, `ActivityArgsFor`, `SignalMap`, etc.) live
 * in `./workflow-builder-helpers.ts` so each file stays under the 500-line
 * lint guideline. The runtime constructor for `workflow()` lives in
 * `./workflow-function.ts`; the `WorkflowContext` generic in `./workflow-context.ts`
 * uses the helpers here to type `run`, `waitForSignal`, etc.
 */

import type { ActivityCallOptions, ActivityDefinition, ActivityFunction } from './activity.ts';
import type { QueryDefinition, SignalDefinition, UpdateDefinition } from './message-handles.ts';
import type { SearchAttributeSchema } from './search-attributes.ts';
import type {
  ActivityMap,
  ActivityMapInput,
  NormalizeActivities,
  QueryMap,
  SignalMap,
  UpdateMap,
} from './workflow-builder-helpers.ts';
import type { WorkflowContext } from './workflow-context.ts';
import type { WorkflowDefinition, WorkflowOperation } from './workflow-function.ts';

// ---------------------------------------------------------------------------
// Workflow generator function consumed by `.execute(...)`
// ---------------------------------------------------------------------------

/**
 * The generator function accepted by `.execute(fn)`. It receives a
 * `WorkflowContext` parameterised by the workflow's normalised activity,
 * signal, update, query, and search-attribute maps, plus the workflow's input,
 * and yields workflow operations until it returns the workflow's output.
 *
 * Both `TInput` and `TOutput` are re-inferred from the generator's signature
 * inside `.execute(fn)`; the workflow's final `WorkflowDefinition` carries the
 * generator-derived types, not whatever placeholders the initial
 * `workflow({ name })` call provided.
 */
export type WorkflowGenerator<
  TInput,
  TOutput,
  TActivities extends ActivityMap,
  TSignals extends SignalMap,
  TUpdates extends UpdateMap,
  TQueries extends QueryMap,
  TSearchAttributes extends SearchAttributeSchema,
> = (
  context: WorkflowContextOf<TActivities, TSignals, TUpdates, TQueries, TSearchAttributes>,
  input: TInput,
) => AsyncGenerator<unknown, TOutput, unknown>;

/**
 * Convenience alias for the workflow-scoped `WorkflowContext` projection. The
 * underlying `WorkflowContext` interface accepts the same five generic
 * parameters (`TActivities`, `TSignals`, `TUpdates`, `TQueries`,
 * `TSearchAttributes`), and the builder threads its normalised maps through
 * this alias so `.execute(fn)` sees the right `ctx` shape inside `fn`.
 *
 * Legacy bare-`WorkflowContext` callers continue to typecheck because the
 * interface's generics all default to empty/permissive shapes, so the typed
 * overloads de-prioritise to `never` and existing string-name/callable
 * overloads still match.
 */
export type WorkflowContextOf<
  TActivities extends ActivityMap = ActivityMap,
  TSignals extends SignalMap = SignalMap,
  TUpdates extends UpdateMap = UpdateMap,
  TQueries extends QueryMap = QueryMap,
  TSearchAttributes extends SearchAttributeSchema = SearchAttributeSchema,
> = WorkflowContext<TActivities, TSignals, TUpdates, TQueries, TSearchAttributes>;

// ---------------------------------------------------------------------------
// Builder state — phantom flag set tracking which chain methods have run
// ---------------------------------------------------------------------------

/**
 * Tracks which `WorkflowBuilder` chain methods have already been called. Each
 * call flips its flag from `false` to `true`; the method's type becomes `never`
 * when its flag is already true, so duplicate calls fail to typecheck. The
 * runtime mirrors this with a state flag set that throws `WorkflowBuilderError`
 * on duplicate invocation.
 */
export interface BuilderState {
  readonly activities: boolean;
  readonly signals: boolean;
  readonly updates: boolean;
  readonly queries: boolean;
  readonly searchAttributes: boolean;
}

/** Initial builder state — every chain method is available. */
export interface InitialBuilderState {
  readonly activities: false;
  readonly signals: false;
  readonly updates: false;
  readonly queries: false;
  readonly searchAttributes: false;
}

/** Flip one builder-state flag from `false` to `true`. */
export type MarkBuilderState<S extends BuilderState, K extends keyof BuilderState> = {
  readonly [P in keyof S]: P extends K ? true : S[P];
};

// ---------------------------------------------------------------------------
// Engine name-conflict guard (used by Engine.register's type signature)
// ---------------------------------------------------------------------------

declare const workflowAlreadyRegisteredBrand: unique symbol;

/**
 * Branded diagnostic type intersected with the parameter of
 * `engine.register(workflow)` when the workflow's `name` is already present in
 * the engine's typed workflow registry. No real `WorkflowDefinition` satisfies
 * the brand, so the call fails to compile on the bare expression form — not
 * just when the return value is used.
 *
 * Runtime is more lenient: registering the same `WorkflowDefinition` object
 * reference is idempotent; same-name-different-object throws. TypeScript
 * cannot distinguish the two at the type level. Callers needing the runtime
 * idempotent path from TypeScript use a documented escape hatch.
 */
export interface WorkflowAlreadyRegistered<TName extends string> {
  readonly [workflowAlreadyRegisteredBrand]: TName;
}

// ---------------------------------------------------------------------------
// The builder itself
// ---------------------------------------------------------------------------

/**
 * Chained builder returned by `workflow({ name })`. Each chain method
 * (`activities`, `signals`, `updates`, `queries`, `searchAttributes`) is
 * callable at most once before the terminal `.execute()`. The phantom-flag
 * generic `S` makes a method's type `never` once its flag is true, so
 * duplicate calls fail to typecheck.
 *
 * `.execute(fn)` re-infers the workflow's input and output from the generator
 * signature and returns a frozen `WorkflowDefinition` that carries the
 * normalised activity/signal/update/query maps and search-attribute schema.
 *
 * @example
 * ```ts
 * import { workflow, signal } from 'weft';
 *
 * const welcome = workflow({ name: 'welcome' })
 *   .activities({
 *     formatGreeting: async ({ name }: { name: string }) => `Hello, ${name}!`,
 *   })
 *   .signals({ approve: signal<{ approverId: string }>('approve') })
 *   .execute(async function* (ctx, input: { name: string }) {
 *     const greeting = yield* ctx.run('formatGreeting', input);
 *     const { approverId } = yield* ctx.waitForSignal('approve');
 *     return { greeting, approverId };
 *   });
 * void welcome;
 * ```
 */
export interface WorkflowBuilder<
  TName extends string,
  TActivities extends ActivityMap,
  TSignals extends SignalMap,
  TUpdates extends UpdateMap,
  TQueries extends QueryMap,
  TSearchAttributes extends SearchAttributeSchema,
  TState extends BuilderState,
> {
  activities: TState['activities'] extends true
    ? never
    : <TInput extends ActivityMapInput>(
        map: TInput,
      ) => WorkflowBuilder<
        TName,
        NormalizeActivities<TInput>,
        TSignals,
        TUpdates,
        TQueries,
        TSearchAttributes,
        MarkBuilderState<TState, 'activities'>
      >;

  signals: TState['signals'] extends true
    ? never
    : <TInput extends SignalMap>(
        map: TInput,
      ) => WorkflowBuilder<
        TName,
        TActivities,
        TInput,
        TUpdates,
        TQueries,
        TSearchAttributes,
        MarkBuilderState<TState, 'signals'>
      >;

  updates: TState['updates'] extends true
    ? never
    : <TInput extends UpdateMap>(
        map: TInput,
      ) => WorkflowBuilder<
        TName,
        TActivities,
        TSignals,
        TInput,
        TQueries,
        TSearchAttributes,
        MarkBuilderState<TState, 'updates'>
      >;

  queries: TState['queries'] extends true
    ? never
    : <TInput extends QueryMap>(
        map: TInput,
      ) => WorkflowBuilder<
        TName,
        TActivities,
        TSignals,
        TUpdates,
        TInput,
        TSearchAttributes,
        MarkBuilderState<TState, 'queries'>
      >;

  searchAttributes: TState['searchAttributes'] extends true
    ? never
    : <TInput extends SearchAttributeSchema>(
        schema: TInput,
      ) => WorkflowBuilder<
        TName,
        TActivities,
        TSignals,
        TUpdates,
        TQueries,
        TInput,
        MarkBuilderState<TState, 'searchAttributes'>
      >;

  execute<TInput, TOutput>(
    fn: WorkflowGenerator<
      TInput,
      TOutput,
      TActivities,
      TSignals,
      TUpdates,
      TQueries,
      TSearchAttributes
    >,
  ): BuiltWorkflowDefinition<
    TInput,
    Awaited<TOutput>,
    TName,
    TActivities,
    TSignals,
    TUpdates,
    TQueries,
    TSearchAttributes
  >;
}

/**
 * The `WorkflowDefinition` returned by `.execute(fn)`. Carries the normalised
 * activity/signal/update/query maps and search-attribute schema alongside the
 * usual `WorkflowDefinition` fields. The runtime objects on these fields are
 * deep-frozen so post-definition mutation cannot affect registered runtime
 * behaviour.
 *
 * The five trailing generic parameters are phantom — they exist so the
 * `Engine.register` type signature can read the workflow's per-message-kind
 * maps off the definition and propagate them to the engine's typed registries
 * without a separate side channel.
 */
export interface BuiltWorkflowDefinition<
  TInput,
  TOutput,
  TName extends string,
  TActivities extends ActivityMap,
  TSignals extends SignalMap,
  TUpdates extends UpdateMap,
  TQueries extends QueryMap,
  TSearchAttributes extends SearchAttributeSchema,
> extends WorkflowDefinition<TInput, TOutput, TName> {
  readonly activities: Readonly<Record<string, Readonly<ActivityDefinition>>>;
  readonly signals: Readonly<Record<string, Readonly<SignalDefinition<unknown>>>>;
  readonly updates: Readonly<Record<string, Readonly<UpdateDefinition>>>;
  readonly queries: Readonly<Record<string, Readonly<QueryDefinition>>>;
  readonly searchAttributes: Readonly<SearchAttributeSchema>;
  /** Phantom marker for the normalised activity map. Not present at runtime. */
  readonly _activities?: TActivities;
  /** Phantom marker for the signal map. Not present at runtime. */
  readonly _signals?: TSignals;
  /** Phantom marker for the update map. Not present at runtime. */
  readonly _updates?: TUpdates;
  /** Phantom marker for the query map. Not present at runtime. */
  readonly _queries?: TQueries;
  /** Phantom marker for the search-attribute schema. Not present at runtime. */
  readonly _searchAttributes?: TSearchAttributes;
}

// ---------------------------------------------------------------------------
// Re-exports for downstream phases
// ---------------------------------------------------------------------------

/**
 * Re-exported so Phase 2 (`workflow()` runtime rewrite) and Phase 3 (engine
 * plumbing) can import everything from a single barrel without picking apart
 * the cross-references.
 */
export type { ActivityCallOptions, ActivityFunction, WorkflowOperation };
