import type { TenantContext } from '../tenant.ts';
import type { WorkflowDefinition } from './workflow-function.ts';

// ---------------------------------------------------------------------------
// Recurring schedule state
// ---------------------------------------------------------------------------

/**
 * Lifecycle state of a recurring schedule managed by {@link Engine.schedule}.
 * `'active'` fires on cron cadence; `'paused'` skips upcoming runs without
 * deleting the schedule; `'cancelled'` is the terminal removed state.
 */
export type ScheduleStatus = 'active' | 'paused' | 'cancelled';

/**
 * Behaviour when a scheduled cron tick fires while a previous run is still
 * active. `'skip'` drops the new run; `'queue'` buffers it; `'cancel-running'`
 * cancels the active workflow and starts fresh; `'allow'` starts both
 * concurrently. Pass via {@link ScheduleOptions.overlap}.
 *
 * @example
 * ```ts
 * import { Engine, type ScheduleOverlapPolicy } from 'weft';
 *
 * const engine = new Engine();
 * engine.register('hourly', async function* () { return 'done'; });
 * const policy: ScheduleOverlapPolicy = 'skip';
 * await engine.schedule('hourly', null, '0 * * * *', { overlap: policy });
 * ```
 */
export type ScheduleOverlapPolicy = 'skip' | 'queue' | 'cancel-running' | 'allow';

/**
 * Options accepted by {@link Engine.schedule}. `id` assigns a deterministic
 * schedule identifier; `overlap` controls what happens when a cron tick fires
 * while a previous run is still active; `backfill` triggers immediate runs for
 * any cron ticks that were missed since the schedule was created.
 *
 * @example
 * ```ts
 * import { Engine, type ScheduleOptions } from 'weft';
 *
 * const engine = new Engine();
 * engine.register('report', async function* () { return 'ok'; });
 * const options: ScheduleOptions = { id: 'daily-report', overlap: 'skip', backfill: false };
 * const handle = await engine.schedule('report', null, '0 9 * * *', options);
 * void handle;
 * ```
 */
export interface ScheduleOptions {
  id?: string;
  overlap?: ScheduleOverlapPolicy;
  backfill?: boolean;
}

/**
 * Declarative recurring schedule definition returned by {@link schedule}.
 *
 * @example
 * ```ts
 * import { schedule, type ScheduleDefinition } from 'weft';
 *
 * const dailyReport: ScheduleDefinition<{ day: string }> = schedule({
 *   workflow: 'report',
 *   cron: '0 9 * * *',
 *   input: { day: 'today' },
 *   overlapPolicy: 'skip',
 * });
 * ```
 */
export interface ScheduleDefinition<TInput = unknown> {
  workflow: string | WorkflowDefinition<TInput>;
  cron: string;
  input: TInput;
  id?: string;
  overlapPolicy?: ScheduleOverlapPolicy;
  backfill?: boolean;
}

/**
 * Create a recurring schedule definition for `engine.schedule(definition)`.
 *
 * @example
 * ```ts
 * import { schedule } from 'weft';
 *
 * const definition = schedule({ workflow: 'report', cron: '0 9 * * *', input: null });
 * ```
 */
export function schedule<TInput>(
  definition: ScheduleDefinition<TInput>,
): ScheduleDefinition<TInput> {
  return definition;
}

/**
 * Full persisted state of a recurring schedule. Returned by `engine.getSchedule(id)`.
 * Use {@link ScheduleSummary} (returned by list operations and `engine.getSchedule()`)
 * for the lightweight variant — it omits `input` and `tenant` to keep payloads
 * small and avoid exposing tenant context to unrelated callers.
 */
export interface ScheduleState {
  id: string;
  workflowType: string;
  input: unknown;
  cronExpression: string;
  status: ScheduleStatus;
  overlap: ScheduleOverlapPolicy;
  backfill: boolean;
  createdAt: number;
  updatedAt: number;
  lastFireAt?: number;
  nextFireAt: number | null;
  currentWorkflowId?: string;
  queuedRuns: number;
  tenant?: TenantContext;
}

/**
 * Lightweight summary of a recurring schedule returned by list operations.
 * Contains cron expression, status, timing metadata, and the ID of the
 * currently running workflow (if any). For the full record including the
 * tenant field, use {@link ScheduleState}.
 */
export interface ScheduleSummary {
  id: string;
  workflowType: string;
  cronExpression: string;
  status: ScheduleStatus;
  overlap: ScheduleOverlapPolicy;
  backfill: boolean;
  createdAt: number;
  updatedAt: number;
  lastFireAt?: number;
  nextFireAt: number | null;
  currentWorkflowId?: string;
  queuedRuns: number;
}

/**
 * Optional tenant-scoping parameter accepted by schedule management methods
 * (`pauseSchedule`, `resumeSchedule`, `cancelSchedule`, etc.). Pass `tenantId`
 * to ensure the operation is only applied to schedules belonging to that tenant.
 */
export interface ScheduleAccessOptions {
  tenantId?: string;
}

/**
 * Filter criteria for `engine.listSchedules`. All fields are optional.
 * `status` accepts one or more values; `tenantId` scopes results to a specific
 * tenant; `limit` and `offset` control pagination.
 */
export interface ScheduleFilter {
  status?: ScheduleStatus | ScheduleStatus[];
  workflowType?: string;
  tenantId?: string;
  limit?: number;
  offset?: number;
}
