import type { BatchOperation, Storage as WeftStorage } from '../../storage/interface.ts';
import { KEYS, storageConditionalBatch } from '../../storage/interface.ts';
import { encode } from '../codec.ts';
import type { TenantQuotaOptions, TenantQuotaUsage } from '../types.ts';
import {
  extractWorkflowIdFromPendingOperation,
  extractWorkflowIdFromStoredRecord,
  listTenantActiveWorkflowIds,
  measureWorkflowStorageBytes,
} from './manager-storage.ts';
import { QuotaExceededError } from './quota-error.ts';
import {
  decodeTenantActiveWorkflowIds,
  decodeTenantStorageUsageBytes,
  decodeWorkflowCreationRateRecord,
  decodeWorkflowTenantRecord,
  isActiveWorkflowStatus,
  isTopLevelWorkflowStateKey,
  MAX_CONDITIONAL_BATCH_ATTEMPTS,
  measureStoredRecordBytes,
  normalizeQuotaOptions,
  resolveNestedWorkflowPrefix,
  trimWorkflowCreationTimestamps,
  WORKFLOW_USAGE_SCAN_PREFIXES,
} from './storage-helpers.ts';
import type {
  NormalizedTenantQuotaOptions,
  StartAdmissionParameters,
  TenantActiveWorkflowRecord,
  TenantStorageUsageRecord,
  TerminalTransitionParameters,
  WorkflowCreationRateRecord,
} from './types.ts';

/**
 * Computes tenant-scoped usage from durable storage and prepares start-time
 * quota checks for workflow admission.
 */
export class TenantQuotaManager {
  readonly #storage: WeftStorage;
  readonly #getNow: () => number;
  readonly #quotas: NormalizedTenantQuotaOptions;

  constructor(storage: WeftStorage, getNow: () => number, quotas: TenantQuotaOptions | undefined) {
    this.#storage = storage;
    this.#getNow = getNow;
    this.#quotas = normalizeQuotaOptions(quotas);

    if (this.#requiresConditionalBatch() && !storage.conditionalBatch) {
      throw new Error(
        'EngineOptions.quotas.maxConcurrentWorkflows, maxWorkflowCreationRate, and maxStorageBytes require a storage backend that implements conditionalBatch().',
      );
    }
  }

  estimateStartStorageBytes(workflowId: string, operations: BatchOperation[]): number {
    const putOperationValues = new Map<string, Uint8Array>();
    for (const operation of operations) {
      if (operation.type === 'put') {
        putOperationValues.set(operation.key, operation.value);
      }
    }

    let estimatedBytes = 0;

    for (const operation of operations) {
      if (operation.type !== 'put') {
        continue;
      }

      if (
        extractWorkflowIdFromPendingOperation(
          operation.key,
          operation.value,
          putOperationValues,
        ) !== workflowId
      ) {
        continue;
      }

      estimatedBytes += measureStoredRecordBytes(operation.key, operation.value);
    }

    return estimatedBytes;
  }

  // oxlint-disable-next-line complexity -- ID:core-tenant-quotas-commit-start-admission-complexity
  async commitStartAdmission(parameters: StartAdmissionParameters): Promise<void> {
    const { tenantId, workflowId, startOperations } = parameters;

    for (let attempt = 1; attempt <= MAX_CONDITIONAL_BATCH_ATTEMPTS; attempt++) {
      const quotaOperations: BatchOperation[] = [];
      const conditions: Array<{
        key: string;
        expectedValue: Uint8Array | null;
      }> = [];
      const currentStorageUsageRecord =
        this.#quotas.maxStorageBytes !== null
          ? await this.#storage.get(KEYS.quotaStorage(tenantId))
          : null;
      const currentWorkflowStorageReservationRecord =
        this.#quotas.maxStorageBytes !== null
          ? await this.#storage.get(KEYS.quotaWorkflowStorage(tenantId, workflowId))
          : null;

      const currentActiveRecord =
        this.#quotas.maxConcurrentWorkflows !== null
          ? await this.#storage.get(KEYS.quotaActive(tenantId))
          : null;
      const durableActiveWorkflowIds =
        this.#quotas.maxConcurrentWorkflows !== null
          ? currentActiveRecord === null
            ? await listTenantActiveWorkflowIds(this.#storage, tenantId)
            : decodeTenantActiveWorkflowIds(currentActiveRecord)
          : [];

      if (this.#quotas.maxConcurrentWorkflows !== null) {
        const nextActiveWorkflowIds = [...new Set([...durableActiveWorkflowIds, workflowId])];
        const projectedActiveWorkflows = nextActiveWorkflowIds.length;
        if (projectedActiveWorkflows > this.#quotas.maxConcurrentWorkflows) {
          throw new QuotaExceededError({
            tenantId,
            quota: 'maxConcurrentWorkflows',
            currentUsage: projectedActiveWorkflows,
            limit: this.#quotas.maxConcurrentWorkflows,
          });
        }

        quotaOperations.push({
          type: 'put',
          key: KEYS.quotaActive(tenantId),
          value: encode({
            workflowIds: nextActiveWorkflowIds,
          } satisfies TenantActiveWorkflowRecord),
        });
        conditions.push({
          key: KEYS.quotaActive(tenantId),
          expectedValue: currentActiveRecord,
        });
      }

      if (this.#quotas.maxStorageBytes !== null) {
        const currentStorageBytes = decodeTenantStorageUsageBytes(currentStorageUsageRecord);
        const projectedStorageBytes = currentStorageBytes + parameters.estimatedStorageBytes;
        if (projectedStorageBytes > this.#quotas.maxStorageBytes) {
          throw new QuotaExceededError({
            tenantId,
            quota: 'maxStorageBytes',
            currentUsage: projectedStorageBytes,
            limit: this.#quotas.maxStorageBytes,
          });
        }

        quotaOperations.push({
          type: 'put',
          key: KEYS.quotaStorage(tenantId),
          value: encode({
            bytes: projectedStorageBytes,
          } satisfies TenantStorageUsageRecord),
        });
        quotaOperations.push({
          type: 'put',
          key: KEYS.quotaWorkflowStorage(tenantId, workflowId),
          value: encode({
            bytes: parameters.estimatedStorageBytes,
          } satisfies TenantStorageUsageRecord),
        });
        conditions.push({
          key: KEYS.quotaStorage(tenantId),
          expectedValue: currentStorageUsageRecord,
        });
        conditions.push({
          key: KEYS.quotaWorkflowStorage(tenantId, workflowId),
          expectedValue: currentWorkflowStorageReservationRecord,
        });
      }

      const rateLimit = this.#quotas.maxWorkflowCreationRate;
      if (rateLimit !== null) {
        const attemptTimestamp = this.#getNow();
        const currentRateRecord = await this.#storage.get(
          KEYS.quotaRate(tenantId, rateLimit.windowMilliseconds),
        );
        const currentTimestamps = trimWorkflowCreationTimestamps(
          decodeWorkflowCreationRateRecord(currentRateRecord),
          attemptTimestamp,
          rateLimit.windowMilliseconds,
        );
        const projectedWorkflowCreations = currentTimestamps.length + 1;

        if (projectedWorkflowCreations > rateLimit.count) {
          throw new QuotaExceededError({
            tenantId,
            quota: 'maxWorkflowCreationRate',
            currentUsage: projectedWorkflowCreations,
            limit: rateLimit.count,
            windowMilliseconds: rateLimit.windowMilliseconds,
          });
        }

        quotaOperations.push({
          type: 'put',
          key: KEYS.quotaRate(tenantId, rateLimit.windowMilliseconds),
          value: encode({
            timestamps: [...currentTimestamps, attemptTimestamp],
          } satisfies WorkflowCreationRateRecord),
        });
        conditions.push({
          key: KEYS.quotaRate(tenantId, rateLimit.windowMilliseconds),
          expectedValue: currentRateRecord,
        });
      }

      if (conditions.length === 0) {
        await this.#storage.batch([...startOperations, ...quotaOperations]);
        return;
      }

      if (
        await storageConditionalBatch(this.#storage, conditions, [
          ...startOperations,
          ...quotaOperations,
        ])
      ) {
        return;
      }

      if (attempt === MAX_CONDITIONAL_BATCH_ATTEMPTS) {
        throw new Error(
          `Failed to commit tenant quota admission for "${tenantId}" after ${String(MAX_CONDITIONAL_BATCH_ATTEMPTS)} concurrent retries`,
        );
      }
    }
  }

  // oxlint-disable-next-line complexity -- ID:core-tenant-quotas-commit-terminal-transition-complexity
  async commitTerminalTransition(parameters: TerminalTransitionParameters): Promise<void> {
    const { tenantId, workflowId, operations } = parameters;

    for (let attempt = 1; attempt <= MAX_CONDITIONAL_BATCH_ATTEMPTS; attempt++) {
      const quotaOperations: BatchOperation[] = [];
      const conditions: Array<{
        key: string;
        expectedValue: Uint8Array | null;
      }> = [];

      if (this.#quotas.maxConcurrentWorkflows !== null) {
        const currentActiveRecord = await this.#storage.get(KEYS.quotaActive(tenantId));
        const durableActiveWorkflowIds =
          currentActiveRecord === null
            ? await listTenantActiveWorkflowIds(this.#storage, tenantId)
            : decodeTenantActiveWorkflowIds(currentActiveRecord);
        const remainingWorkflowIds = [
          ...new Set(durableActiveWorkflowIds.filter((id) => id !== workflowId)),
        ];

        quotaOperations.push(
          ...(remainingWorkflowIds.length > 0
            ? [
                {
                  type: 'put' as const,
                  key: KEYS.quotaActive(tenantId),
                  value: encode({
                    workflowIds: remainingWorkflowIds,
                  } satisfies TenantActiveWorkflowRecord),
                },
              ]
            : [{ type: 'delete' as const, key: KEYS.quotaActive(tenantId) }]),
        );
        conditions.push({
          key: KEYS.quotaActive(tenantId),
          expectedValue: currentActiveRecord,
        });
      }

      if (this.#quotas.maxStorageBytes !== null) {
        const currentStorageUsageRecord = await this.#storage.get(KEYS.quotaStorage(tenantId));
        const currentWorkflowStorageReservationRecord = await this.#storage.get(
          KEYS.quotaWorkflowStorage(tenantId, workflowId),
        );
        const reservedStorageBytes =
          currentWorkflowStorageReservationRecord !== null
            ? decodeTenantStorageUsageBytes(currentWorkflowStorageReservationRecord)
            : await measureWorkflowStorageBytes(this.#storage, workflowId);
        const remainingStorageBytes = Math.max(
          0,
          decodeTenantStorageUsageBytes(currentStorageUsageRecord) - reservedStorageBytes,
        );

        quotaOperations.push(
          ...(remainingStorageBytes > 0
            ? [
                {
                  type: 'put' as const,
                  key: KEYS.quotaStorage(tenantId),
                  value: encode({
                    bytes: remainingStorageBytes,
                  } satisfies TenantStorageUsageRecord),
                },
              ]
            : [{ type: 'delete' as const, key: KEYS.quotaStorage(tenantId) }]),
        );
        quotaOperations.push({
          type: 'delete',
          key: KEYS.quotaWorkflowStorage(tenantId, workflowId),
        });
        conditions.push({
          key: KEYS.quotaStorage(tenantId),
          expectedValue: currentStorageUsageRecord,
        });
        conditions.push({
          key: KEYS.quotaWorkflowStorage(tenantId, workflowId),
          expectedValue: currentWorkflowStorageReservationRecord,
        });
      }

      if (conditions.length === 0) {
        await this.#storage.batch(operations);
        return;
      }

      if (
        await storageConditionalBatch(this.#storage, conditions, [
          ...operations,
          ...quotaOperations,
        ])
      ) {
        return;
      }

      if (attempt === MAX_CONDITIONAL_BATCH_ATTEMPTS) {
        throw new Error(
          `Failed to commit tenant quota release for "${tenantId}" after ${String(MAX_CONDITIONAL_BATCH_ATTEMPTS)} concurrent retries`,
        );
      }
    }
  }

  // oxlint-disable-next-line complexity -- ID:core-tenant-quotas-get-usage-complexity
  async getUsage(tenantId: string): Promise<TenantQuotaUsage> {
    if (tenantId.trim().length === 0) {
      throw new Error('tenantId must be a non-empty string');
    }

    const tenantWorkflowIds = new Set<string>();
    let activeWorkflows = 0;
    let storageBytes = 0;

    for await (const [key, value] of this.#storage.scan('wf:')) {
      if (!isTopLevelWorkflowStateKey(key)) {
        continue;
      }

      const workflowState = decodeWorkflowTenantRecord(value);
      if (!workflowState) {
        continue;
      }
      if (workflowState.tenant?.id !== tenantId) {
        continue;
      }

      tenantWorkflowIds.add(workflowState.id);
      storageBytes += measureStoredRecordBytes(key, value);

      if (isActiveWorkflowStatus(workflowState.status)) {
        activeWorkflows++;
      }
    }

    if (tenantWorkflowIds.size > 0) {
      for (const workflowId of tenantWorkflowIds) {
        for await (const [key, value] of this.#storage.scan(
          resolveNestedWorkflowPrefix(workflowId),
        )) {
          storageBytes += measureStoredRecordBytes(key, value);
        }
      }

      for (const prefix of WORKFLOW_USAGE_SCAN_PREFIXES) {
        for await (const [key, value] of this.#storage.scan(prefix)) {
          const workflowId = await extractWorkflowIdFromStoredRecord(this.#storage, key, value);
          if (!workflowId || !tenantWorkflowIds.has(workflowId)) {
            continue;
          }

          storageBytes += measureStoredRecordBytes(key, value);
        }
      }
    }

    const rateLimit = this.#quotas.maxWorkflowCreationRate;
    const workflowCreationRate = rateLimit
      ? trimWorkflowCreationTimestamps(
          decodeWorkflowCreationRateRecord(
            await this.#storage.get(KEYS.quotaRate(tenantId, rateLimit.windowMilliseconds)),
          ),
          this.#getNow(),
          rateLimit.windowMilliseconds,
        ).length
      : 0;

    return {
      tenantId,
      activeWorkflows: {
        used: activeWorkflows,
        limit: this.#quotas.maxConcurrentWorkflows,
      },
      storageBytes: {
        used: storageBytes,
        limit: this.#quotas.maxStorageBytes,
      },
      workflowCreationRate: {
        used: workflowCreationRate,
        limit: rateLimit?.count ?? null,
        windowMilliseconds: rateLimit?.windowMilliseconds ?? null,
      },
    };
  }

  #requiresConditionalBatch(): boolean {
    return (
      this.#quotas.maxConcurrentWorkflows !== null ||
      this.#quotas.maxStorageBytes !== null ||
      this.#quotas.maxWorkflowCreationRate !== null
    );
  }
}
