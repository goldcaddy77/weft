import type { TenantContext } from '../tenant.ts';
import type { WorkflowVersionTuple } from '../workflow-version-tuple.ts';
import type { CheckpointState } from './checkpoint.ts';
import type { FailureCategory, WorkflowId, WorkflowStatus } from './identity.ts';
import type { WorkflowOperation } from './workflow-function.ts';

// ---------------------------------------------------------------------------
// Workflow state persisted in storage
// ---------------------------------------------------------------------------

/**
 * Snapshot of a workflow's persisted state.
 *
 * Returned by `handle.state()` and `engine.get(workflowId)`. Users observe
 * this shape — they don't construct it. Includes the input, current status,
 * tenant, attributes, retention policy snapshot, and lineage information,
 * plus `failureCategory` (populated on failed workflows), `agentVersion` and
 * `toolVersions` (set when registered via an AgentDefinition), `forkedFrom`
 * lineage metadata, and the optional `executionDeadline`/`terminalCleanupToken`
 * housekeeping fields.
 */
export interface WorkflowState {
  id: WorkflowId;
  type: string;
  status: WorkflowStatus;
  tags?: string[];
  input: unknown;
  result?: unknown;
  error?: string;
  errorStack?: string;
  /**
   * Classifies why this workflow failed. Populated automatically on failure;
   * absent (`undefined`) on workflows that have not failed. `null` indicates
   * a failure occurred but the category could not be determined.
   *
   * Also indexed as a search attribute so callers can query via:
   * `engine.list({ attributes: [{ key: 'failureCategory', value: 'planning' }] })`
   */
  failureCategory?: FailureCategory | null;
  version: string;
  /**
   * Semantic version of the agent definition at the time this workflow was
   * started. Populated when the workflow was registered via an
   * {@link AgentDefinition}; absent for plain workflow functions.
   */
  agentVersion?: string;
  /**
   * Sorted `"${name}@${version}"` tool version strings captured from the
   * effective tool list at workflow start. Populated when the workflow was
   * registered via an {@link AgentDefinition} with tools; absent otherwise.
   */
  toolVersions?: string[];
  createdAt: number;
  startedAt?: number;
  updatedAt: number;
  terminalCleanupToken?: string;
  executionDeadline?: number;
  /**
   * Optional {@link TenantContext} resolved at start time by the engine's
   * `tenantResolver`. Persisted here so it survives workflow recovery — the
   * field is only present on workflows started while a resolver was
   * configured and the resolver returned a value.
   */
  tenant?: TenantContext;
  /**
   * Lineage metadata recorded when this workflow was created by a fork from
   * another workflow checkpoint. Absent for workflows started normally.
   */
  forkedFrom?: ForkLineage;
}

/**
 * Lineage metadata recorded when a workflow was created by forking another
 * workflow at a checkpoint boundary. Absent on workflows started normally via
 * {@link Engine.start}. Available on {@link WorkflowState.forkedFrom}.
 */
export interface ForkLineage {
  workflowId: WorkflowId;
  step: number;
}

/**
 * Status of an individual entry in the workflow execution timeline. Mirrors
 * {@link WorkflowStatus} but scoped to a single timeline step rather than the
 * whole workflow. Used in {@link WorkflowTimelineEntry}.
 */
export type WorkflowTimelineStatus = 'running' | 'completed' | 'failed' | 'cancelled' | 'timed-out';

/**
 * A single chronological entry in a workflow's execution timeline, summarising
 * one operation (activity call, sleep, signal wait, etc.). Returned by
 * `engine.getTimeline(workflowId)` for replay and debugging.
 * The optional `versionTuple` field is populated only for entries produced by
 * versioned workflows or agents and carries the
 * `(workflowVersion, agentVersion, toolVersions[])` tuple captured at the time
 * of the operation.
 */
export type WorkflowTimelineEntry = {
  step: number;
  operationType: string;
  operationLabel: string;
  inputSummary: string;
  outputSummary?: string;
  duration?: number;
  timestamp: number;
  status: WorkflowTimelineStatus;
  versionTuple?: WorkflowVersionTuple;
};

/**
 * Typed per-workflow session state slot returned by `ctx.sessionState(key)`.
 * Survives checkpoint recovery but is scoped to the current workflow instance.
 * Use `get` to read the current value, `set` or `update` to write, and `run`
 * to schedule a sticky durable activity that may need session-bound context.
 * `clear()` removes the stored value; subsequent `get()` returns the handle's
 * captured `initialValue` if one was provided, otherwise `undefined`.
 * `run` schedules the function as a regular activity routed through sticky
 * worker execution. The function receives only the arguments you pass to
 * `run(...)` — it cannot read the slot from inside. Read `session.get()`
 * before yielding the run if the function needs the current value.
 */
export interface WorkflowSessionState<T> {
  get(): T | undefined;
  set(value: T): T;
  update(updater: (current: T | undefined) => T): T;
  clear(): void;
  run<TResult>(
    fn: (...args: unknown[]) => Promise<TResult> | TResult,
    ...rest: unknown[]
  ): WorkflowOperation<TResult>;
}

// ---------------------------------------------------------------------------
// Workflow summary (returned by list)
// ---------------------------------------------------------------------------

/**
 * Lightweight summary of a workflow returned by list operations. Contains
 * identity and lifecycle fields but not the full input, result, or checkpoint.
 * Use {@link Engine.get} to retrieve the complete {@link WorkflowState}.
 * Notably absent from the summary: `input`, `result`, `error`, `tenant`,
 * `failureCategory`, and `forkedFrom` — fetch the full `WorkflowState` via
 * `engine.get(id)` to access those.
 */
export interface WorkflowSummary {
  id: WorkflowId;
  type: string;
  status: WorkflowStatus;
  tags?: string[];
  version: string;
  createdAt: number;
  updatedAt: number;
}

// ---------------------------------------------------------------------------
// Workflow event (returned by engine.getEvents)
// ---------------------------------------------------------------------------

/**
 * Event entries returned by `engine.getEvents()` are stored records — use
 * `engine.addEventListener(type, handler)` with the typed `Event` subclasses
 * (e.g. `WorkflowCompletedEvent`) for live observation; the stored `data` map
 * is provided for replay/audit.
 */
export interface WorkflowEvent {
  type: string;
  timestamp: number;
  data: Record<string, unknown>;
}

/**
 * Full replay package for a workflow step, combining the checkpoint state,
 * the accumulated operation results up to that step, and the event log.
 * Returned by `engine.replayTo(workflowId, step)` for time-travel debugging.
 */
export type WorkflowReplay = {
  checkpoint: CheckpointState;
  accumulatedResults: Array<[number, unknown]>;
  events: WorkflowEvent[];
};
