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

import { createOperationRegistry, type OperationRegistry } from './operation-catalog.ts';
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
  getBudgetPolicyOperation,
  getBudgetPolicyRestBinding,
} from './operations/get-budget-policy.ts';
import {
  getCheckpointAtOperation,
  getCheckpointAtRestBinding,
} from './operations/get-checkpoint-at.ts';
import {
  getRetentionOverviewOperation,
  getRetentionOverviewRestBinding,
} from './operations/get-retention-overview.ts';
import { getReviewOperation, getReviewRestBinding } from './operations/get-review.ts';
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
import { listWorkflowsOperation, listWorkflowsRestBinding } from './operations/list-workflows.ts';
import {
  purgeWorkflowsOperation,
  purgeWorkflowsRestBinding,
} from './operations/purge-workflows.ts';
import { queryWorkflowOperation, queryWorkflowRestBinding } from './operations/query-workflow.ts';
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
// oxlint-disable-next-line typescript/no-explicit-any -- heterogeneous registry requires `any` at the storage boundary; individual bindings stay strictly typed at their definition site.
export type UnknownRestBinding = RestBinding<any, any>;

/**
 * Live REST binding set. Each migrated operation contributes exactly
 * one entry. Exported `readonly` so the router cannot mutate it at
 * runtime.
 */
export const REST_BINDINGS: ReadonlyArray<UnknownRestBinding> = [
  listWorkflowsRestBinding,
  purgeWorkflowsRestBinding,
  bulkCancelWorkflowsRestBinding,
  bulkSignalWorkflowsRestBinding,
  bulkDeleteWorkflowsRestBinding,
  bulkMutateWorkflowTagsRestBinding,
  getWorkflowRestBinding,
  getWorkflowResultRestBinding,
  getWorkflowAttributesRestBinding,
  getWorkflowEventsRestBinding,
  queryWorkflowRestBinding,
  getRetentionOverviewRestBinding,
  getBudgetPolicyRestBinding,
  getUpdateResultRestBinding,
  listReviewsRestBinding,
  getReviewRestBinding,
  listCheckpointsRestBinding,
  getCheckpointAtRestBinding,
  getWorkflowTimelineRestBinding,
];

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
export function createLiveOperationRegistry(): OperationRegistry {
  return createOperationRegistry([
    listWorkflowsOperation,
    purgeWorkflowsOperation,
    bulkCancelWorkflowsOperation,
    bulkSignalWorkflowsOperation,
    bulkDeleteWorkflowsOperation,
    bulkMutateWorkflowTagsOperation,
    getWorkflowOperation,
    getWorkflowResultOperation,
    getWorkflowAttributesOperation,
    getWorkflowEventsOperation,
    queryWorkflowOperation,
    getRetentionOverviewOperation,
    getBudgetPolicyOperation,
    getUpdateResultOperation,
    listReviewsOperation,
    getReviewOperation,
    listCheckpointsOperation,
    getCheckpointAtOperation,
    getWorkflowTimelineOperation,
  ]);
}
