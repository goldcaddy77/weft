/**
 * Thrown by {@link Engine.start} when a workflow with the requested ID already
 * exists in storage. Inspect the `workflowId` property to identify the
 * conflict. To allow deduplication semantics instead of an error, pass
 * `idempotencyKey` in {@link StartOptions}.
 *
 * @example
 * ```ts
 * import { Engine, WorkflowAlreadyExistsError } from 'weft';
 *
 * const engine = new Engine();
 * engine.register('ping', async function* () { return 'pong'; });
 *
 * await engine.start('ping', null, { id: 'my-ping' });
 * try {
 *   await engine.start('ping', null, { id: 'my-ping' });
 * } catch (err) {
 *   if (err instanceof WorkflowAlreadyExistsError) {
 *     console.error('already running:', err.workflowId);
 *   }
 * }
 * ```
 */
export class WorkflowAlreadyExistsError extends Error {
  readonly workflowId: string;

  constructor(workflowId: string) {
    super(`Workflow with id "${workflowId}" already exists`);
    this.name = 'WorkflowAlreadyExistsError';
    this.workflowId = workflowId;
  }
}

/**
 * Thrown by {@link Engine.deleteAll} when the supplied filter would match
 * non-terminal workflows. Narrow the filter to completed, failed, cancelled,
 * or timed-out workflows before deleting in bulk.
 *
 * @example
 * ```ts
 * import { BulkDeleteRequiresTerminalWorkflowsError } from 'weft';
 *
 * function shouldShowTerminalOnlyMessage(error: unknown): boolean {
 *   return error instanceof BulkDeleteRequiresTerminalWorkflowsError;
 * }
 * ```
 */
export class BulkDeleteRequiresTerminalWorkflowsError extends Error {
  constructor() {
    super('Bulk delete matches non-terminal workflows');
    this.name = 'BulkDeleteRequiresTerminalWorkflowsError';
  }
}

/**
 * Thrown by committed bulk operations when the supplied confirmation token no
 * longer matches the current dry-run scope. Run a fresh preview and commit
 * with the returned token.
 *
 * @example
 * ```ts
 * import { BulkOperationConfirmationError } from 'weft';
 *
 * function needsFreshBulkPreview(error: unknown): boolean {
 *   return error instanceof BulkOperationConfirmationError;
 * }
 * ```
 */
export class BulkOperationConfirmationError extends Error {
  constructor() {
    super('Bulk confirmation token does not match the current dry-run scope');
    this.name = 'BulkOperationConfirmationError';
  }
}

export type MissingWorkflowSample = {
  readonly type: string;
  readonly workflowId: string;
};

const MISSING_WORKFLOW_SAMPLE_LIMIT = 20;
const MISSING_TYPE_MESSAGE_LIMIT = 10;

function summarizeMissingWorkflowTypes(missingTypes: readonly string[]): string {
  const visibleTypes = missingTypes.slice(0, MISSING_TYPE_MESSAGE_LIMIT);
  const hiddenTypeCount = missingTypes.length - visibleTypes.length;
  return hiddenTypeCount > 0
    ? `${visibleTypes.join(', ')} (+${hiddenTypeCount} more)`
    : visibleTypes.join(', ');
}

/**
 * Thrown by {@link Engine.create} and {@link Engine.recoverAll} when storage
 * contains running workflows whose workflow type has not been registered on
 * the engine. The structured sample list is capped so logs remain bounded,
 * while `missingTypes` and `registeredTypes` carry the full sorted type lists.
 *
 * @example
 * ```ts
 * import { Engine, WorkflowTypeNotRegisteredForRecoveryError } from 'weft';
 *
 * const engine = new Engine();
 * try {
 *   await engine.recoverAll();
 * } catch (error) {
 *   if (error instanceof WorkflowTypeNotRegisteredForRecoveryError) {
 *     console.error('missing workflow types:', error.missingTypes);
 *   }
 * }
 * ```
 */
export class WorkflowTypeNotRegisteredForRecoveryError extends Error {
  readonly registeredTypes: readonly string[];
  readonly missingTypes: readonly string[];
  readonly missingWorkflowSamples: ReadonlyArray<MissingWorkflowSample>;
  readonly missingWorkflowCount: number;
  readonly samplesTruncated: boolean;

  constructor(parameters: {
    registeredTypes: Iterable<string>;
    missingWorkflows: ReadonlyArray<MissingWorkflowSample>;
  }) {
    const missingWorkflowCount = parameters.missingWorkflows.length;
    const missingTypes = [
      ...new Set(parameters.missingWorkflows.map((workflow) => workflow.type)),
    ].toSorted();
    const registeredTypes = [...parameters.registeredTypes].toSorted();
    const summarizedTypes = summarizeMissingWorkflowTypes(missingTypes);
    super(
      `Cannot recover ${missingWorkflowCount} running workflow(s): workflow type(s) not registered: ${summarizedTypes}. ` +
        'Register the missing workflow types before calling `recoverAll()`, or pass ' +
        '`{ acknowledgeUnknownWorkflowTypes: true }` (dangerous — see migration docs).',
    );
    this.name = 'WorkflowTypeNotRegisteredForRecoveryError';
    this.registeredTypes = registeredTypes;
    this.missingTypes = missingTypes;
    this.missingWorkflowSamples = parameters.missingWorkflows
      .slice(0, MISSING_WORKFLOW_SAMPLE_LIMIT)
      .map((workflow) => ({ ...workflow }));
    this.missingWorkflowCount = missingWorkflowCount;
    this.samplesTruncated = missingWorkflowCount > MISSING_WORKFLOW_SAMPLE_LIMIT;
  }
}

/**
 * Thrown by {@link Engine.create} when a definition map key does not match the
 * definition's runtime `name`. The factory uses map keys for type inference,
 * so mismatches are rejected before registration to keep the inferred type and
 * runtime registry aligned.
 *
 * @example
 * ```ts
 * import { activity, Engine, EngineCreateNameMismatchError } from 'weft';
 *
 * const farewell = activity({ name: 'farewell', execute: async () => 'bye' });
 * try {
 *   await Engine.create({ activities: { greet: farewell } });
 * } catch (error) {
 *   if (error instanceof EngineCreateNameMismatchError) {
 *     console.error(error.expectedName, error.actualName);
 *   }
 * }
 * ```
 */
export class EngineCreateNameMismatchError extends Error {
  readonly definitionKind: 'workflow' | 'activity';
  readonly expectedName: string;
  readonly actualName: string;

  constructor(definitionKind: 'workflow' | 'activity', expectedName: string, actualName: string) {
    super(
      `Engine.create() ${definitionKind} definition key "${expectedName}" does not match definition name "${actualName}"`,
    );
    this.name = 'EngineCreateNameMismatchError';
    this.definitionKind = definitionKind;
    this.expectedName = expectedName;
    this.actualName = actualName;
  }
}

/**
 * Thrown by engine APIs that need a workflow to be present in storage but
 * cannot find one with the given ID. Inspect `workflowId` to identify the
 * missing record.
 *
 * @example
 * ```ts
 * import { Engine, WorkflowNotFoundError } from 'weft';
 *
 * const engine = new Engine();
 * try {
 *   await engine.cancel('does-not-exist');
 * } catch (err) {
 *   if (err instanceof WorkflowNotFoundError) {
 *     console.error('cannot cancel — no such workflow:', err.workflowId);
 *   }
 * }
 * ```
 */
export class WorkflowNotFoundError extends Error {
  readonly workflowId: string;

  constructor(workflowId: string) {
    super(`Workflow "${workflowId}" not found`);
    this.name = 'WorkflowNotFoundError';
    this.workflowId = workflowId;
  }
}

/**
 * Thrown by {@link Engine.start} and other registry-driven entry points when
 * the caller asks for a workflow type that was never registered. Distinct
 * from `WorkflowNotFoundError`, which signals an unknown workflow ID at
 * runtime.
 *
 * @example
 * ```ts
 * import { Engine, WorkflowNotRegisteredError } from 'weft';
 *
 * const engine = new Engine();
 * try {
 *   await engine.start('checkout', { orderId: 'order-1' });
 * } catch (err) {
 *   if (err instanceof WorkflowNotRegisteredError) {
 *     console.error('register the workflow first:', err.workflowType);
 *   }
 * }
 * ```
 */
export class WorkflowNotRegisteredError extends Error {
  readonly workflowType: string;

  constructor(workflowType: string) {
    super(`No workflow registered with name "${workflowType}"`);
    this.name = 'WorkflowNotRegisteredError';
    this.workflowType = workflowType;
  }
}
