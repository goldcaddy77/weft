/**
 * Live registry of `RestBinding` instances for migrated REST operations.
 *
 * Each entry is a REST route whose dispatch flows through the shared
 * `executeOperation` pipeline. The router (handleRequest) matches
 * against `REST_BINDINGS` first; a miss falls through to the legacy
 * `ROUTES`/`ROUTE_EXECUTORS` table for operations not yet migrated.
 *
 * @module server/rest-bindings
 */

import type { MetricsCollector } from '../observability/metrics.ts';
import { createOperationRegistry, type OperationRegistry } from './operation-catalog.ts';
import {
  addWorkflowTagsOperation,
  addWorkflowTagsRestBinding,
} from './operations/add-workflow-tags.ts';
import {
  bulkCancelWorkflowsOperation,
  bulkCancelWorkflowsRestBinding,
} from './operations/bulk-cancel-workflows.ts';
import {
  bulkDeleteWorkflowsOperation,
  bulkDeleteWorkflowsRestBinding,
} from './operations/bulk-delete-workflows.ts';
import {
  bulkMutateWorkflowTagsOperation,
  bulkMutateWorkflowTagsRestBinding,
} from './operations/bulk-mutate-workflow-tags.ts';
import {
  bulkSignalWorkflowsOperation,
  bulkSignalWorkflowsRestBinding,
} from './operations/bulk-signal-workflows.ts';
import {
  cancelScheduleOperation,
  cancelScheduleRestBinding,
} from './operations/cancel-schedule.ts';
import {
  cancelWorkflowOperation,
  cancelWorkflowRestBinding,
} from './operations/cancel-workflow.ts';
import {
  createScheduleOperation,
  createScheduleRestBinding,
} from './operations/create-schedule.ts';
import { forkWorkflowOperation, forkWorkflowRestBinding } from './operations/fork-workflow.ts';
import {
  getCheckpointAtOperation,
  getCheckpointAtRestBinding,
} from './operations/get-checkpoint-at.ts';
import {
  getRetentionOverviewOperation,
  getRetentionOverviewRestBinding,
} from './operations/get-retention-overview.ts';
import { getReviewOperation, getReviewRestBinding } from './operations/get-review.ts';
import { getScheduleOperation, getScheduleRestBinding } from './operations/get-schedule.ts';
import {
  getStreamChunksOperation,
  getStreamChunksRestBinding,
} from './operations/get-stream-chunks.ts';
import {
  createGetSystemMetricsOperation,
  createGetSystemMetricsRestBinding,
  getSystemMetricsOperation,
} from './operations/get-system-metrics.ts';
import {
  getTenantQuotaOperation,
  getTenantQuotaRestBinding,
} from './operations/get-tenant-quota.ts';
import {
  getUpdateResultOperation,
  getUpdateResultRestBinding,
} from './operations/get-update-result.ts';
import {
  getWorkflowAttributesOperation,
  getWorkflowAttributesRestBinding,
} from './operations/get-workflow-attributes.ts';
import {
  getWorkflowEventsOperation,
  getWorkflowEventsRestBinding,
} from './operations/get-workflow-events.ts';
import {
  getWorkflowResultOperation,
  getWorkflowResultRestBinding,
} from './operations/get-workflow-result.ts';
import {
  getWorkflowTimelineOperation,
  getWorkflowTimelineRestBinding,
} from './operations/get-workflow-timeline.ts';
import { getWorkflowOperation, getWorkflowRestBinding } from './operations/get-workflow.ts';
import {
  listCheckpointsOperation,
  listCheckpointsRestBinding,
} from './operations/list-checkpoints.ts';
import { listReviewsOperation, listReviewsRestBinding } from './operations/list-reviews.ts';
import { listSchedulesOperation, listSchedulesRestBinding } from './operations/list-schedules.ts';
import { listWorkflowsOperation, listWorkflowsRestBinding } from './operations/list-workflows.ts';
import { pauseScheduleOperation, pauseScheduleRestBinding } from './operations/pause-schedule.ts';
import {
  purgeWorkflowsOperation,
  purgeWorkflowsRestBinding,
} from './operations/purge-workflows.ts';
import { queryWorkflowOperation, queryWorkflowRestBinding } from './operations/query-workflow.ts';
import { recoverAllOperation, recoverAllRestBinding } from './operations/recover-all.ts';
import {
  removeWorkflowTagsOperation,
  removeWorkflowTagsRestBinding,
} from './operations/remove-workflow-tags.ts';
import {
  replayWorkflowOperation,
  replayWorkflowRestBinding,
} from './operations/replay-workflow.ts';
import {
  resumeScheduleOperation,
  resumeScheduleRestBinding,
} from './operations/resume-schedule.ts';
import {
  resumeWorkflowOperation,
  resumeWorkflowRestBinding,
} from './operations/resume-workflow.ts';
import {
  setWorkflowAttributesOperation,
  setWorkflowAttributesRestBinding,
} from './operations/set-workflow-attributes.ts';
import {
  signalWorkflowOperation,
  signalWorkflowRestBinding,
} from './operations/signal-workflow.ts';
import { startWorkflowOperation, startWorkflowRestBinding } from './operations/start-workflow.ts';
import {
  storageBatchOperation,
  storageBatchRestBinding,
  storageConditionalBatchOperation,
  storageConditionalBatchRestBinding,
  storageDeleteOperation,
  storageDeleteRestBinding,
  storageGetOperation,
  storageGetRestBinding,
  storagePutOperation,
  storagePutRestBinding,
  storageScanOperation,
  storageScanRestBinding,
} from './operations/storage.ts';
import {
  streamWorkflowSseOperation,
  streamWorkflowSseRestBinding,
} from './operations/stream-workflow-sse.ts';
import {
  submitReviewDecisionOperation,
  submitReviewDecisionRestBinding,
} from './operations/submit-review-decision.ts';
import {
  timeoutWorkflowOperation,
  timeoutWorkflowRestBinding,
} from './operations/timeout-workflow.ts';
import {
  updateScheduleOperation,
  updateScheduleRestBinding,
} from './operations/update-schedule.ts';
import {
  updateWorkflowOperation,
  updateWorkflowRestBinding,
} from './operations/update-workflow.ts';
import { workflowEventsSubscriptionOperation } from './operations/workflow-events-subscription.ts';
import type { RestBinding } from './rest-binding.ts';

/**
 * The router stores heterogeneous bindings whose `Input`/`Output` pairs
 * all differ. `RestBinding<Input, Output>` is strictly-typed at the
 * author boundary (so `defineOperation` + binding factories catch
 * mistakes), but at the router level those generics are irrelevant —
 * every binding produces a `Response` regardless of its output type.
 *
 * `RestBinding<any, any>` is the idiomatic way to express "a binding
 * with SOME Input/Output pair the router doesn't care about." A stricter
 * `unknown, unknown` form fails under `exactOptionalPropertyTypes`
 * because `shapeSuccess: (Output) => Response` cannot be safely widened
 * to `(unknown) => Response` (function parameters are contravariant).
 */
export type UnknownRestBinding = RestBinding<any, any>;

/**
 * Static REST bindings for all operations that do not need per-server
 * configuration. The `weft.system.metrics` binding is excluded here
 * because it is constructed per-server via `createGetSystemMetricsRestBinding`
 * (to receive the metrics collector without module-level singletons).
 * Use `createLiveRestBindings()` to get the full set for a given server.
 */
export const REST_BINDINGS: ReadonlyArray<UnknownRestBinding> = [
  startWorkflowRestBinding,
  recoverAllRestBinding,
  listWorkflowsRestBinding,
  purgeWorkflowsRestBinding,
  bulkCancelWorkflowsRestBinding,
  bulkSignalWorkflowsRestBinding,
  bulkDeleteWorkflowsRestBinding,
  bulkMutateWorkflowTagsRestBinding,
  getWorkflowRestBinding,
  cancelWorkflowRestBinding,
  getWorkflowResultRestBinding,
  getWorkflowAttributesRestBinding,
  getWorkflowEventsRestBinding,
  setWorkflowAttributesRestBinding,
  signalWorkflowRestBinding,
  queryWorkflowRestBinding,
  resumeWorkflowRestBinding,
  forkWorkflowRestBinding,
  timeoutWorkflowRestBinding,
  updateWorkflowRestBinding,
  createScheduleRestBinding,
  updateScheduleRestBinding,
  getRetentionOverviewRestBinding,
  getUpdateResultRestBinding,
  listReviewsRestBinding,
  getReviewRestBinding,
  listCheckpointsRestBinding,
  getCheckpointAtRestBinding,
  getWorkflowTimelineRestBinding,
  addWorkflowTagsRestBinding,
  removeWorkflowTagsRestBinding,
  submitReviewDecisionRestBinding,
  cancelScheduleRestBinding,
  pauseScheduleRestBinding,
  resumeScheduleRestBinding,
  getStreamChunksRestBinding,
  streamWorkflowSseRestBinding,
  // Wave 1 — previously legacy direct handlers
  listSchedulesRestBinding,
  getScheduleRestBinding,
  getTenantQuotaRestBinding,
  replayWorkflowRestBinding,
  storageGetRestBinding,
  storagePutRestBinding,
  storageDeleteRestBinding,
  storageScanRestBinding,
  storageBatchRestBinding,
  storageConditionalBatchRestBinding,
];

/**
 * Build the full REST binding set for a server instance. Appends the
 * `weft.system.metrics` binding. The metrics collector is wired into
 * the operation (not the binding) via `createLiveOperationRegistry`.
 */
export function createLiveRestBindings(): ReadonlyArray<UnknownRestBinding> {
  return [...REST_BINDINGS, createGetSystemMetricsRestBinding()];
}

/**
 * Live operation registry — populated with every operation that has a
 * `RestBinding`, a JSON-RPC mount, or an stdio mount. Exposed via a
 * factory so tests can spin up a fresh registry without inheriting
 * the live one's state.
 *
 * Concrete `OperationDefinition<Input, Output>` values are directly
 * assignable to `RegistrableOperation` by the variance design in
 * `operation-catalog.ts` — no `as ErasedOperation` cast is needed.
 */
/**
 * Create the live operation registry for a server instance.
 */
export function createLiveOperationRegistry(options?: {
  metricsCollector?: MetricsCollector;
}): OperationRegistry {
  return createOperationRegistry([
    startWorkflowOperation,
    recoverAllOperation,
    listWorkflowsOperation,
    purgeWorkflowsOperation,
    bulkCancelWorkflowsOperation,
    bulkSignalWorkflowsOperation,
    bulkDeleteWorkflowsOperation,
    bulkMutateWorkflowTagsOperation,
    getWorkflowOperation,
    cancelWorkflowOperation,
    getWorkflowResultOperation,
    getWorkflowAttributesOperation,
    getWorkflowEventsOperation,
    setWorkflowAttributesOperation,
    signalWorkflowOperation,
    queryWorkflowOperation,
    resumeWorkflowOperation,
    forkWorkflowOperation,
    timeoutWorkflowOperation,
    updateWorkflowOperation,
    createScheduleOperation,
    updateScheduleOperation,
    getRetentionOverviewOperation,
    getUpdateResultOperation,
    listReviewsOperation,
    getReviewOperation,
    listCheckpointsOperation,
    getCheckpointAtOperation,
    getWorkflowTimelineOperation,
    addWorkflowTagsOperation,
    removeWorkflowTagsOperation,
    submitReviewDecisionOperation,
    cancelScheduleOperation,
    pauseScheduleOperation,
    resumeScheduleOperation,
    getStreamChunksOperation,
    streamWorkflowSseOperation,
    workflowEventsSubscriptionOperation,
    // Wave 1 — previously legacy direct handlers
    listSchedulesOperation,
    getScheduleOperation,
    getTenantQuotaOperation,
    replayWorkflowOperation,
    storageGetOperation,
    storagePutOperation,
    storageDeleteOperation,
    storageScanOperation,
    storageBatchOperation,
    storageConditionalBatchOperation,
    options?.metricsCollector === undefined
      ? getSystemMetricsOperation
      : createGetSystemMetricsOperation({ metricsCollector: options.metricsCollector }),
  ]);
}
