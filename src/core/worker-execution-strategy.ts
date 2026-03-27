/**
 * Worker-based execution strategy: runs workflows in Web Workers.
 *
 * Uses {@link WorkerPool} to manage a pool of workers. Each workflow is
 * assigned a dedicated worker for its lifetime. Messages are forwarded
 * between the engine and workers via the {@link WorkerInboundMessage} /
 * {@link WorkerOutboundMessage} protocol.
 *
 * @module core/worker-execution-strategy
 */

import type { WorkerPool } from '../workers/pool.ts';
import type { ExecutionStrategy } from './execution-strategy.ts';
import type { OperationOutcome, WorkerInboundMessage, WorkerOutboundMessage } from './types.ts';

// ---------------------------------------------------------------------------
// WorkerExecutionStrategy
// ---------------------------------------------------------------------------

interface WorkerListeners {
  message: (event: MessageEvent<WorkerOutboundMessage>) => void;
  error: (event: ErrorEvent) => void;
}

export class WorkerExecutionStrategy implements ExecutionStrategy {
  readonly #pool: WorkerPool;
  readonly #workersByWorkflowId: Map<string, Worker>;
  readonly #workerListeners: Map<string, WorkerListeners>;
  readonly #broadcastChannel: BroadcastChannel | null;
  readonly #broadcastListener: ((event: MessageEvent) => void) | null;
  #messageHandler: ((message: WorkerOutboundMessage) => void) | null;

  constructor(pool: WorkerPool, options?: { broadcastEvents?: boolean }) {
    this.#pool = pool;
    this.#workersByWorkflowId = new Map();
    this.#workerListeners = new Map();
    this.#messageHandler = null;
    this.#broadcastChannel = null;
    this.#broadcastListener = null;

    if (options?.broadcastEvents) {
      try {
        this.#broadcastChannel = new BroadcastChannel('weft:events');
        this.#broadcastListener = (event: MessageEvent) => {
          this.#handleBroadcastMessage(event.data as Record<string, unknown>);
        };
        this.#broadcastChannel.addEventListener('message', this.#broadcastListener);
      } catch {
        // BroadcastChannel may not be available in all environments
      }
    }
  }

  // -------------------------------------------------------------------------
  // ExecutionStrategy interface
  // -------------------------------------------------------------------------

  onMessage(handler: (message: WorkerOutboundMessage) => void): void {
    this.#messageHandler = handler;
  }

  startWorkflow(parameters: {
    workflowId: string;
    workflowType: string;
    input: unknown;
    checkpoint: ArrayBuffer;
    nestingDepth?: number;
  }): void {
    void this.#acquireAndSend(parameters.workflowId, {
      type: 'run',
      workflowId: parameters.workflowId,
      workflowType: parameters.workflowType,
      checkpoint: parameters.checkpoint,
      input: parameters.input,
    });
  }

  resumeWorkflow(parameters: {
    workflowId: string;
    checkpoint: ArrayBuffer;
    operationResult: OperationOutcome;
  }): void {
    const worker = this.#workersByWorkflowId.get(parameters.workflowId);
    if (!worker) {
      this.#emit({
        type: 'failed',
        workflowId: parameters.workflowId,
        error: `No worker assigned for workflow: ${parameters.workflowId}`,
      });
      return;
    }

    const message: WorkerInboundMessage = {
      type: 'resume',
      workflowId: parameters.workflowId,
      checkpoint: parameters.checkpoint,
      operationResult: parameters.operationResult,
    };

    const transferable =
      parameters.checkpoint instanceof ArrayBuffer
        ? parameters.checkpoint
        : (parameters.checkpoint as Uint8Array).buffer;
    worker.postMessage(message, [transferable]);
  }

  cancelWorkflow(workflowId: string): void {
    const worker = this.#workersByWorkflowId.get(workflowId);
    if (!worker) return;

    const message: WorkerInboundMessage = {
      type: 'cancel',
      workflowId,
    };

    worker.postMessage(message);
    this.#releaseWorker(workflowId);
  }

  // -------------------------------------------------------------------------
  // Disposal
  // -------------------------------------------------------------------------

  [Symbol.dispose](): void {
    if (this.#broadcastChannel) {
      if (this.#broadcastListener) {
        this.#broadcastChannel.removeEventListener('message', this.#broadcastListener);
      }
      this.#broadcastChannel.close();
    }
    // Release all active workers back to the pool before disposing
    const activeWorkflowIds = Array.from(this.#workersByWorkflowId.keys());
    for (const workflowId of activeWorkflowIds) {
      this.#releaseWorker(workflowId);
    }
    this.#messageHandler = null;
    this.#pool[Symbol.dispose]();
  }

  async [Symbol.asyncDispose](): Promise<void> {
    if (this.#broadcastChannel) {
      if (this.#broadcastListener) {
        this.#broadcastChannel.removeEventListener('message', this.#broadcastListener);
      }
      this.#broadcastChannel.close();
    }
    const activeWorkflowIds = Array.from(this.#workersByWorkflowId.keys());
    for (const workflowId of activeWorkflowIds) {
      this.#releaseWorker(workflowId);
    }
    this.#messageHandler = null;
    await this.#pool[Symbol.asyncDispose]();
  }

  // -------------------------------------------------------------------------
  // Private: worker acquisition and messaging
  // -------------------------------------------------------------------------

  async #acquireAndSend(
    workflowId: string,
    message: WorkerInboundMessage & { type: 'run' },
  ): Promise<void> {
    try {
      const worker = await this.#pool.acquire();
      this.#workersByWorkflowId.set(workflowId, worker);

      // Wire up message handling for this worker using addEventListener
      const listeners: WorkerListeners = {
        message: (event: MessageEvent<WorkerOutboundMessage>) => {
          this.#handleWorkerMessage(workflowId, event.data);
        },
        error: (errorEvent: ErrorEvent) => {
          this.#handleWorkerError(workflowId, errorEvent);
        },
      };

      this.#workerListeners.set(workflowId, listeners);
      worker.addEventListener('message', listeners.message as EventListener);
      worker.addEventListener('error', listeners.error as EventListener);

      // Send the run message with checkpoint as Transferable.
      // Extract the underlying ArrayBuffer since only ArrayBuffer objects
      // are valid Transferables (not Uint8Array or other typed arrays).
      const transferable =
        message.checkpoint instanceof ArrayBuffer
          ? message.checkpoint
          : (message.checkpoint as Uint8Array).buffer;
      worker.postMessage(message, [transferable]);
    } catch (error) {
      this.#emit({
        type: 'failed',
        workflowId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  #handleWorkerMessage(workflowId: string, message: WorkerOutboundMessage): void {
    // Forward the message to the engine
    this.#emit(message);

    // On terminal messages, release the worker back to the pool
    if (message.type === 'completed' || message.type === 'failed') {
      this.#releaseWorker(workflowId);
    }
  }

  #handleWorkerError(workflowId: string, errorEvent: ErrorEvent): void {
    const worker = this.#workersByWorkflowId.get(workflowId);
    if (!worker) return; // Already cleaned up by a racing completion

    this.#emit({
      type: 'failed',
      workflowId,
      error: `Worker crashed: ${errorEvent.message ?? 'unknown error'}`,
    });

    // Remove from maps first to prevent racing with #handleWorkerMessage
    this.#workersByWorkflowId.delete(workflowId);
    const listeners = this.#workerListeners.get(workflowId);
    if (listeners) {
      worker.removeEventListener('message', listeners.message as EventListener);
      worker.removeEventListener('error', listeners.error as EventListener);
      this.#workerListeners.delete(workflowId);
    }

    // Terminate the crashed worker (do not return to pool)
    worker.terminate();
  }

  #releaseWorker(workflowId: string): void {
    const worker = this.#workersByWorkflowId.get(workflowId);
    if (worker) {
      this.#workersByWorkflowId.delete(workflowId);

      // Remove event listeners before returning to pool
      const listeners = this.#workerListeners.get(workflowId);
      if (listeners) {
        worker.removeEventListener('message', listeners.message as EventListener);
        worker.removeEventListener('error', listeners.error as EventListener);
        this.#workerListeners.delete(workflowId);
      }

      this.#pool.release(worker);
    }
  }

  // -------------------------------------------------------------------------
  // Private: BroadcastChannel forwarding (2G)
  // -------------------------------------------------------------------------

  #handleBroadcastMessage(data: Record<string, unknown>): void {
    // Forward signal-related messages to the appropriate worker
    if (data['type'] === 'signal:received' && typeof data['workflowId'] === 'string') {
      const worker = this.#workersByWorkflowId.get(data['workflowId']);
      if (worker) {
        worker.postMessage(data);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Private: helpers
  // -------------------------------------------------------------------------

  #emit(message: WorkerOutboundMessage): void {
    this.#messageHandler?.(message);
  }
}
