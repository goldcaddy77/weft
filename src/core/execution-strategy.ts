/**
 * Execution strategy interface for workflow execution.
 *
 * Defines the contract for how workflows are driven (inline on the main thread
 * or in a Web Worker). The engine delegates generator lifecycle to a strategy
 * and reacts uniformly to {@link WorkerOutboundMessage} regardless of where
 * the workflow code actually runs.
 *
 * @module core/execution-strategy
 */

import type { TenantContext } from './tenant.ts';
import type { OperationOutcome, WorkerOutboundMessage } from './types.ts';

export interface ExecutionStrategy extends Disposable, AsyncDisposable {
  /**
   * Start a new workflow execution from the beginning.
   */
  startWorkflow(parameters: {
    workflowId: string;
    workflowType: string;
    input: unknown;
    checkpoint: ArrayBuffer | Uint8Array;
    nestingDepth?: number;
    deadline?: number;
    headers?: [string, string][];
    /**
     * The tenant context resolved by the engine's `tenantResolver` for this
     * workflow, if any.
     *
     * Inline strategies expose this to workflow code via `ctx.tenant` by
     * threading it through the `Context` constructor. Worker-based
     * strategies (`WorkerExecutionStrategy`) currently DROP this value:
     * the worker protocol does not yet carry tenant across the postMessage
     * boundary, and the worker-side runner does not construct a Context
     * with engine-side fields. Callers running in worker mode must not
     * assume `ctx.tenant` is populated until that support lands. Tracked
     * as a known limitation in `reference/IMPORTANT.md`.
     */
    tenant?: TenantContext;
  }): void;

  /**
   * Resume a suspended workflow by feeding an operation result back into it.
   */
  resumeWorkflow(parameters: {
    workflowId: string;
    checkpoint: ArrayBuffer | Uint8Array;
    operationResult: OperationOutcome;
  }): void;

  /**
   * Cancel an in-flight workflow, aborting its generator.
   */
  cancelWorkflow(workflowId: string): void;

  /**
   * Register a handler that receives all outbound messages from the strategy.
   * The engine calls this once during setup; the handler persists for the
   * lifetime of the strategy.
   */
  onMessage(handler: (message: WorkerOutboundMessage) => void | Promise<void>): void;
}
