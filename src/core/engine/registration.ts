import { compileStepWorkflow, isAsyncGeneratorFunction } from '../step-context.ts';
import type {
  StepWorkflowFunction,
  WorkflowDefinition,
  WorkflowFunction,
  WorkflowRegistration,
} from '../types.ts';
import { validateDefinitionSchemaMetadata } from '../types.ts';
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
  if (registration.searchAttributes) {
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

export function register(
  internals: EngineInternals,
  nameOrDefinition: unknown,
  handlerOrRegistrationOrOptions: unknown,
  callbacks: RegistrationCallbacks,
): void {
  if (isWorkflowDefinition(nameOrDefinition)) {
    register(internals, nameOrDefinition.name, nameOrDefinition, callbacks);
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
