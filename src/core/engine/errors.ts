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

export class BulkDeleteRequiresTerminalWorkflowsError extends Error {
  constructor() {
    super('Bulk delete matches non-terminal workflows');
    this.name = 'BulkDeleteRequiresTerminalWorkflowsError';
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
