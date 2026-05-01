import type { Duration } from './retry-retention.ts';

// ---------------------------------------------------------------------------
// Per-tenant quotas
// ---------------------------------------------------------------------------

/**
 * Rate-limit configuration for tenant workflow creation. `count` is the
 * maximum number of workflows allowed within `window`. Pass as
 * {@link TenantQuotaOptions.maxWorkflowCreationRate} to enforce burst
 * protection per tenant.
 *
 * @example
 * ```ts
 * import { Engine, type TenantWorkflowCreationRateLimit } from 'weft';
 *
 * const rateLimit: TenantWorkflowCreationRateLimit = { count: 100, window: '1m' };
 * const engine = new Engine({ quotas: { maxWorkflowCreationRate: rateLimit } });
 * void engine;
 * ```
 */
export interface TenantWorkflowCreationRateLimit {
  count: number;
  window: Duration;
}

/**
 * Per-tenant admission control limits enforced by the engine when a
 * `tenantResolver` is configured. Set limits on concurrent running workflows,
 * creation rate, and total storage. Any limit can be omitted to leave that
 * dimension unconstrained. Pass as {@link EngineOptions.quotas}.
 *
 * @example
 * ```ts
 * import { Engine, type TenantQuotaOptions } from 'weft';
 *
 * const quotas: TenantQuotaOptions = {
 *   maxConcurrentWorkflows: 50,
 *   maxWorkflowCreationRate: { count: 100, window: '1m' },
 *   maxStorageBytes: 10_000_000,
 * };
 * const engine = new Engine({ quotas });
 * void engine;
 * ```
 */
export interface TenantQuotaOptions {
  maxConcurrentWorkflows?: number;
  maxWorkflowCreationRate?: TenantWorkflowCreationRateLimit;
  maxStorageBytes?: number;
}

/**
 * Current usage and configured limit for a single tenant quota dimension.
 * `limit` is `null` when no limit was configured for this dimension.
 * Returned as part of {@link TenantQuotaUsage} from `engine.getQuotaUsage`.
 */
export interface TenantQuotaMetricUsage {
  used: number;
  limit: number | null;
}

/**
 * Rate-limit usage for workflow creation, extending {@link TenantQuotaMetricUsage}
 * with the `windowMilliseconds` field. `null` when no rate limit was configured.
 * Returned as the `workflowCreationRate` field of {@link TenantQuotaUsage}.
 */
export interface TenantWorkflowCreationRateUsage extends TenantQuotaMetricUsage {
  windowMilliseconds: number | null;
}

/**
 * Snapshot of all quota usage metrics for a specific tenant. Returned by
 * `engine.getQuotaUsage(tenantId)`. Read `activeWorkflows.used` vs
 * `activeWorkflows.limit` to determine headroom before hitting concurrency limits.
 */
export interface TenantQuotaUsage {
  tenantId: string;
  activeWorkflows: TenantQuotaMetricUsage;
  storageBytes: TenantQuotaMetricUsage;
  workflowCreationRate: TenantWorkflowCreationRateUsage;
}
