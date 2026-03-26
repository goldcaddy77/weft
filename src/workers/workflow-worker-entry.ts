/**
 * Web Worker entry point for workflow execution.
 *
 * Sets up `self.onmessage` to handle {@link WorkerInboundMessage} and posts
 * back {@link WorkerOutboundMessage} via `self.postMessage`. Uses the
 * existing runner helpers from `workflow-runner.ts`.
 *
 * @module workers/workflow-worker-entry
 */

import type { WorkerInboundMessage, WorkerOutboundMessage } from '../core/types.ts';
import {
  createWorkflowRunnerContext,
  handleCancelMessage,
  handleResumeMessage,
  handleRunMessage,
} from './workflow-runner.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type WorkflowHandlerFactory = (
  type: string,
) => ((...arguments_: unknown[]) => AsyncGenerator) | undefined;

// ---------------------------------------------------------------------------
// Worker bootstrap
// ---------------------------------------------------------------------------

/**
 * Initialize the worker message loop. Call this from within a Web Worker
 * to wire up the message protocol.
 *
 * @param getWorkflowHandler - Factory that resolves a workflow type name to
 *   its async generator function. Typically backed by a registration map.
 */
export function initializeWorkerMessageLoop(getWorkflowHandler: WorkflowHandlerFactory): void {
  const runnerContext = createWorkflowRunnerContext();

  self.addEventListener('message', async (event: MessageEvent<WorkerInboundMessage>) => {
    const message = event.data;

    switch (message.type) {
      case 'run': {
        const response = await handleRunMessage(runnerContext, message, getWorkflowHandler);
        postOutboundMessage(response);
        break;
      }

      case 'resume': {
        // Map the OperationOutcome to the result value expected by handleResumeMessage
        const resultValue =
          message.operationResult.status === 'completed'
            ? message.operationResult.value
            : undefined;

        const response = await handleResumeMessage(runnerContext, {
          workflowId: message.workflowId,
          result: resultValue,
        });
        postOutboundMessage(response);
        break;
      }

      case 'cancel': {
        handleCancelMessage(runnerContext, message);
        break;
      }
    }
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Post an outbound message back to the main thread, using the checkpoint
 * ArrayBuffer as a Transferable for zero-copy transfer.
 */
function postOutboundMessage(message: WorkerOutboundMessage): void {
  if (message.type === 'checkpoint') {
    self.postMessage(message, [message.checkpoint]);
  } else {
    self.postMessage(message);
  }
}

/**
 * Create a Blob URL that can be used to spawn a Web Worker with the given
 * workflow registrations.
 *
 * @param registrations - Map of workflow type names to handler functions.
 *   The handlers must be serializable (no closures over local state).
 * @returns A Blob URL suitable for `new Worker(url)`.
 */
export function createWorkerEntryUrl(
  registrations: Map<string, (...arguments_: unknown[]) => AsyncGenerator>,
): string {
  // Build a self-contained script that imports the entry point and wires
  // up registrations. This relies on the bundler/runtime supporting
  // dynamic imports from blob URLs.
  const registrationEntries = [...registrations.entries()]
    .map(
      ([name, handler]) => `  registrations.set(${JSON.stringify(name)}, ${handler.toString()});`,
    )
    .join('\n');

  const script = `
const registrations = new Map();
${registrationEntries}

import { initializeWorkerMessageLoop } from '${import.meta.url.replace(/workflow-worker-entry\.[^/]+$/, 'workflow-worker-entry.ts')}';
initializeWorkerMessageLoop((type) => registrations.get(type));
`;

  const blob = new Blob([script], { type: 'application/javascript' });
  return URL.createObjectURL(blob);
}
