import { ActivityRegistry } from '../activity-registry.ts';
import { compileStepWorkflow, isAsyncGeneratorFunction } from '../step-context.ts';
import {
  activity,
  validateDefinitionSchemaMetadata,
  type ActivityDefinition,
  type StepWorkflowFunction,
  type WorkflowDefinition,
  type WorkflowFunction,
  type WorkflowRegistration,
} from '../types.ts';
import type { EngineInternals } from './internals.ts';
import { normalizeRetentionPolicy } from './validation.ts';

type RegistrationEntry =
  EngineInternals['registrations'] extends Map<string, infer Entry> ? Entry : never;

export type RegistrationCallbacks = {
  ensureRetentionSweepInterval: () => void;
};

function copiedTags(tags: ReadonlyArray<string> | undefined): string[] | undefined {
  return tags === undefined ? undefined : [...tags];
}

function isWorkflowDefinition(value: unknown): value is WorkflowDefinition {
  return typeof value === 'object' && value !== null && 'name' in value && 'handler' in value;
}

function isWorkflowRegistration(value: unknown): value is WorkflowRegistration {
  return typeof value === 'object' && value !== null && 'handler' in value;
}

function assertConstraintsSupported(
  internals: EngineInternals,
  name: string,
  registration: WorkflowRegistration,
): void {
  if (!registration.constraints || registration.constraints.length === 0) {
    return;
  }
  // Constraints are only evaluated by the inline execution strategy —
  // `evaluateConstraints` reads per-workflow context via
  // `internals.inlineStrategy.getContext(...)`. In worker execution mode the
  // inline strategy is absent, so every constraint would be silently
  // skipped. Fail loud at registration time rather than swallowing the
  // invariant at runtime.
  if (internals.inlineStrategy === null) {
    throw new Error(
      `Cannot register workflow "${name}" with constraints: constraints are not supported in worker execution mode. ` +
        `The engine was constructed with \`workerExecution\`, which runs workflows in a Web Worker where the inline ` +
        `execution context required by constraint evaluation is unavailable. Remove the \`constraints\` option, or ` +
        `construct the engine without \`workerExecution\` to run workflows inline.`,
    );
  }
}

function buildBaseRegistrationEntry(
  name: string,
  registration: WorkflowRegistration,
): RegistrationEntry {
  const tags = copiedTags(registration.tags);
  const normalizedRetention = normalizeRetentionPolicy(
    registration.retention,
    `registration("${name}").retention`,
  );
  return {
    handler: registration.handler,
    version: registration.version ?? '1',
    ...(registration.description === undefined ? {} : { description: registration.description }),
    ...(tags === undefined ? {} : { tags }),
    ...(registration.inputSchema === undefined
      ? {}
      : {
          inputSchema: validateDefinitionSchemaMetadata(
            registration.inputSchema,
            `registration("${name}").inputSchema`,
          ),
        }),
    ...(registration.outputSchema === undefined
      ? {}
      : {
          outputSchema: validateDefinitionSchemaMetadata(
            registration.outputSchema,
            `registration("${name}").outputSchema`,
          ),
        }),
    ...(normalizedRetention !== null && { retention: normalizedRetention }),
  };
}

function applyOptionalRegistrationFields(
  entry: RegistrationEntry,
  registration: WorkflowRegistration,
): void {
  if (registration.migrate) {
    entry.migrate = registration.migrate;
  }
  if (registration.searchAttributes && Object.keys(registration.searchAttributes).length > 0) {
    entry.searchAttributes = registration.searchAttributes;
  }
  if (registration.constraints && registration.constraints.length > 0) {
    entry.constraints = registration.constraints;
  }
}

function buildRegistrationEntry(
  name: string,
  registration: WorkflowRegistration,
): RegistrationEntry {
  const entry = buildBaseRegistrationEntry(name, registration);
  applyOptionalRegistrationFields(entry, registration);
  return entry;
}

function registerWorkflowRegistration(
  internals: EngineInternals,
  name: string,
  registration: WorkflowRegistration,
  callbacks: RegistrationCallbacks,
): void {
  assertConstraintsSupported(internals, name, registration);
  const entry = buildRegistrationEntry(name, registration);
  internals.registrations.set(name, entry);
  callbacks.ensureRetentionSweepInterval();
  internals.workflowTypesByHandler.set(registration.handler, name);
}

function registerBareHandler(
  internals: EngineInternals,
  name: string,
  handler: WorkflowFunction | StepWorkflowFunction,
  callbacks: RegistrationCallbacks,
): void {
  // Auto-detect step-based (non-generator) workflow functions and compile them
  const originalHandler = handler;
  let resolvedHandler: WorkflowFunction | StepWorkflowFunction = handler;
  if (typeof resolvedHandler === 'function' && !isAsyncGeneratorFunction(resolvedHandler)) {
    resolvedHandler = compileStepWorkflow(resolvedHandler as StepWorkflowFunction);
  }

  internals.registrations.set(name, {
    handler: resolvedHandler as WorkflowFunction,
    version: '1',
  });
  callbacks.ensureRetentionSweepInterval();
  if (typeof originalHandler === 'function') {
    internals.workflowTypesByHandler.set(originalHandler, name);
  }
  if (typeof resolvedHandler === 'function') {
    internals.workflowTypesByHandler.set(resolvedHandler, name);
  }
}

/**
 * Heuristic detector for `BuiltWorkflowDefinition` — the runtime shape returned
 * by `workflow({ name }).execute(...)`. We test for the per-message-kind maps
 * the builder writes (`activities`, `signals`, `updates`, `queries`,
 * `searchAttributes`) directly on the definition. We do not import the
 * type from `workflow-builder.ts` to avoid a cycle with the engine package;
 * the runtime check is sufficient because the builder is the only producer of
 * objects with all five fields as plain `Readonly<Record<string, ...>>`.
 */
function hasNonNullObjectField(value: object, key: string): boolean {
  if (!(key in value)) return false;
  const fieldValue = (value as { [k: string]: unknown })[key];
  return typeof fieldValue === 'object' && fieldValue !== null;
}

function isBuilderWorkflowDefinition(value: unknown): value is WorkflowDefinition & {
  readonly activities: Readonly<Record<string, Readonly<ActivityDefinition>>>;
  readonly signals: Readonly<Record<string, unknown>>;
  readonly updates: Readonly<Record<string, unknown>>;
  readonly queries: Readonly<Record<string, unknown>>;
  readonly searchAttributes: Readonly<Record<string, unknown>>;
} {
  if (!isWorkflowDefinition(value)) return false;
  return (
    hasNonNullObjectField(value, 'activities') &&
    hasNonNullObjectField(value, 'signals') &&
    hasNonNullObjectField(value, 'updates') &&
    hasNonNullObjectField(value, 'queries') &&
    hasNonNullObjectField(value, 'searchAttributes')
  );
}

/**
 * Defensive recursive POJO clone — `structuredClone` rejects function values
 * we carry on activity option subtrees (`execute`, `compensate`, `verify`).
 * Class instances pass through by reference; the outer container is frozen by
 * the {@link activity} factory call so reassignment cannot reach the engine's
 * stored copy.
 */
function clonePlainOption<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    return value.map((item) => clonePlainOption(item)) as unknown as T;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    return value;
  }
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>)) {
    out[key] = clonePlainOption((value as Record<string, unknown>)[key]);
  }
  return out as T;
}

/**
 * Build a fresh per-workflow {@link ActivityRegistry} from a builder workflow's
 * activities map. Each entry is defensively deep-cloned and then turned into a
 * fresh `ActivityCallable` via {@link activity}, so the engine's registry holds
 * its own callable references and the user's `BuiltWorkflowDefinition` cannot
 * influence dispatch by post-registration mutation.
 */
function buildPerWorkflowActivityRegistry(
  activities: Readonly<Record<string, Readonly<ActivityDefinition>>>,
): ActivityRegistry {
  const registry = new ActivityRegistry();
  for (const definition of Object.values(activities)) {
    const clonedDefinition = clonePlainOption(definition);
    // Re-running `activity(...)` rebuilds the callable, validates the name
    // against the wire-safe grammar, and freezes the colocated metadata
    // independently from the user's frozen input. The resulting object is the
    // canonical entry stored in the per-workflow registry.
    const callable = activity(clonedDefinition);
    registry.register(callable.name, callable);
  }
  return registry;
}

/**
 * Apply the runtime collision rule for `engine.register(workflow)`. Same
 * `WorkflowDefinition` object reference re-registered is a no-op (idempotent
 * return value `true`). Same-name-but-different-object throws. Same-reference
 * detection uses identity equality (`===`); deep equality is intentionally not
 * considered because the builder freezes the returned definition, so two
 * builder outputs are only equal by reference.
 */
function applyWorkflowCollisionRule(
  internals: EngineInternals,
  name: string,
  definition: object,
): { idempotent: boolean } {
  const existing = internals.workflowDefinitionsByName.get(name);
  if (existing === undefined) {
    internals.workflowDefinitionsByName.set(name, definition);
    return { idempotent: false };
  }
  if (existing === definition) {
    return { idempotent: true };
  }
  throw new Error(`Workflow "${name}" is already registered with a different definition`);
}

export function register(
  internals: EngineInternals,
  nameOrDefinition: unknown,
  handlerOrRegistrationOrOptions: unknown,
  callbacks: RegistrationCallbacks,
): void {
  if (isWorkflowDefinition(nameOrDefinition)) {
    const definition = nameOrDefinition;
    if (isBuilderWorkflowDefinition(definition)) {
      const { idempotent } = applyWorkflowCollisionRule(internals, definition.name, definition);
      if (idempotent) return;
      // Build the per-workflow ActivityRegistry first so a registration-time
      // failure (e.g. invalid activity metadata) leaves no partial state.
      const perWorkflowRegistry = buildPerWorkflowActivityRegistry(definition.activities);
      internals.activityRegistriesByWorkflow.set(definition.name, perWorkflowRegistry);
      register(internals, definition.name, definition, callbacks);
      return;
    }
    // Legacy object-literal `WorkflowDefinition` — Phase 5 removes this path.
    // No collision guard: legacy callers historically re-register names freely.
    register(internals, definition.name, definition, callbacks);
    return;
  }

  const name = nameOrDefinition as string;
  const handlerOrRegistration = handlerOrRegistrationOrOptions as
    | WorkflowFunction
    | StepWorkflowFunction
    | WorkflowRegistration;

  if (isWorkflowRegistration(handlerOrRegistration)) {
    registerWorkflowRegistration(internals, name, handlerOrRegistration, callbacks);
    return;
  }

  registerBareHandler(internals, name, handlerOrRegistration, callbacks);
}

export function resolveWorkflowTypeTarget(
  internals: EngineInternals,
  target: string | Function,
  _callbacks: RegistrationCallbacks,
): string {
  if (typeof target === 'string') {
    return target;
  }

  const registeredType = internals.workflowTypesByHandler.get(target);
  if (registeredType) {
    return registeredType;
  }

  throw new Error(
    'Workflow functions used in composition operators must be registered before use. ' +
      'Pass the registered workflow type string or register the function on the engine first.',
  );
}
