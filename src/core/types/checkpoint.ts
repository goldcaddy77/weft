import type { TenantContext } from '../tenant.ts';
import type { FailureCategory, OperationId, WorkflowId } from './identity.ts';
import type { Duration, RetryPolicy } from './retry-retention.ts';
import type { SearchAttributeValue } from './search-attributes.ts';

// ---------------------------------------------------------------------------
// Checkpoint: snapshot of workflow at a yield* boundary
// ---------------------------------------------------------------------------

/**
 * Durable snapshot of a workflow's execution state persisted at each
 * `yield` boundary. Contains the accumulated operation results, local
 * variables, pending signals, search attributes, and the step counter.
 * Users don't construct checkpoints directly; the engine manages them.
 * Available via time-travel APIs and {@link WorkflowReplay}.
 *
 * @example
 * ```ts
 * import { Engine, type Checkpoint } from 'weft';
 *
 * const engine = new Engine({ checkpointHistory: 5 });
 * engine.register('counter', async function* () { return 42; });
 * const handle = await engine.start('counter', null);
 * await handle.result();
 * // Checkpoints are persisted by the engine; retrieve via engine.getCheckpoint()
 * const _engine: typeof engine = engine;
 * void _engine;
 * ```
 */
export interface Checkpoint {
  workflowId: WorkflowId;
  step: number;
  locals: Record<string, unknown>;
  accumulatedResults: Array<[number, unknown]>;
  pendingSignals: string[];
  searchAttributes: Record<string, SearchAttributeValue>;
  version: string;
  createdAt: number;
}

// ---------------------------------------------------------------------------
// Checkpoint history: time-travel debugging
// ---------------------------------------------------------------------------

/** Summary metadata for a single checkpoint history entry. */
export type CheckpointSummary = {
  step: number;
  timestamp: number;
  sizeBytes: number;
};

/** Full deserialized state at a specific checkpoint step. */
export type CheckpointState = Pick<
  Checkpoint,
  'step' | 'locals' | 'searchAttributes' | 'version' | 'createdAt'
>;

// ---------------------------------------------------------------------------
// Operation types
// ---------------------------------------------------------------------------

export type OperationKind = 'activity' | 'timer' | 'signal-wait' | 'child-workflow';

export interface OperationRequest {
  id: OperationId;
  workflowId: WorkflowId;
  kind: OperationKind;
  queue: string;
  activityName?: string;
  input?: unknown;
  attempt: number;
  retryPolicy: RetryPolicy;
  scheduledAt: number;
  timeout?: Duration;
  idempotencyKey?: string;
  /** Visibility timeout in milliseconds. Defaults to 30 000. */
  visibilityTimeout?: number;
}

export type OperationOutcome =
  | { status: 'completed'; value: unknown }
  | { status: 'failed'; error: string };

// ---------------------------------------------------------------------------
// Timer entry for scheduler
// ---------------------------------------------------------------------------

export interface TimerEntry {
  id: string;
  workflowId: WorkflowId;
  fireAt: number;
  kind:
    | 'sleep'
    | 'visibility-timeout'
    | 'execution-deadline'
    | 'delayed-start'
    | 'schedule'
    | 'terminal-cleanup';
  executionTimeoutMs?: number;
}

// ---------------------------------------------------------------------------
// Worker message protocol (postMessage between main thread and Web Workers)
// ---------------------------------------------------------------------------

export type WorkerInboundMessage =
  | {
      type: 'run';
      workflowId: WorkflowId;
      workflowType: string;
      checkpoint: ArrayBuffer;
      input: unknown;
      deadline?: number;
      headers?: [string, string][];
      /**
       * Resolved tenant context for this workflow run, forwarded across the
       * `postMessage` boundary. The `attributes` values MUST be
       * structured-clone safe — functions, class instances, and DOM nodes
       * will crash the transfer with `DataCloneError`. Stick to plain
       * objects, arrays, strings, numbers, booleans, and null.
       */
      tenant?: TenantContext;
    }
  | {
      type: 'resume';
      workflowId: WorkflowId;
      checkpoint: ArrayBuffer;
      operationResult: OperationOutcome;
    }
  | { type: 'cancel'; workflowId: WorkflowId };

export type WorkerOutboundMessage =
  | {
      type: 'checkpoint';
      workflowId: WorkflowId;
      checkpoint: ArrayBuffer;
      operationRequest: OperationRequest;
    }
  | { type: 'completed'; workflowId: WorkflowId; result: unknown }
  | {
      type: 'failed';
      workflowId: WorkflowId;
      error: string;
      errorStack?: string;
      /** Populated when the inline strategy can classify the failure cause. */
      failureCategory?: FailureCategory;
    };
