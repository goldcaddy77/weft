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

import type { OperationOutcome, WorkerOutboundMessage } from './types.ts';

export interface ExecutionStrategy extends Disposable, AsyncDisposable {
  /**
   * Start a new workflow execution from the beginning.
   */
  startWorkflow(parameters: {
    workflowId: string;
    workflowType: string;
    input: unknown;
    checkpoint: ArrayBuffer;
  }): void;

  /**
   * Resume a suspended workflow by feeding an operation result back into it.
   */
  resumeWorkflow(parameters: {
    workflowId: string;
    checkpoint: ArrayBuffer;
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
  onMessage(handler: (message: WorkerOutboundMessage) => void): void;
}
