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

export class WorkflowNotFoundError extends Error {
  readonly workflowId: string;

  constructor(workflowId: string) {
    super(`Workflow "${workflowId}" not found`);
    this.name = 'WorkflowNotFoundError';
    this.workflowId = workflowId;
  }
}
