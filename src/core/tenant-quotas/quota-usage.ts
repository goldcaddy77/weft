import type { Storage as WeftStorage } from '../../storage/interface.ts';
import { KEYS } from '../../storage/interface.ts';
import { extractWorkflowIdFromStoredRecord } from './manager-storage.ts';
import {
  decodeWorkflowCreationRateRecord,
  decodeWorkflowTenantRecord,
  isActiveWorkflowStatus,
  isTopLevelWorkflowStateKey,
  measureStoredRecordBytes,
  resolveNestedWorkflowPrefix,
  trimWorkflowCreationTimestamps,
  WORKFLOW_USAGE_SCAN_PREFIXES,
} from './storage-helpers.ts';
import type { NormalizedTenantQuotaOptions } from './types.ts';

export type TenantUsageRecords = {
  tenantWorkflowIds: Set<string>;
  activeWorkflows: number;
  storageBytes: number;
};

export async function collectTenantUsageRecords(
  storage: WeftStorage,
  tenantId: string,
): Promise<TenantUsageRecords> {
  const usageRecords = await collectTopLevelTenantUsageRecords(storage, tenantId);

  if (usageRecords.tenantWorkflowIds.size > 0) {
    usageRecords.storageBytes += await measureNestedWorkflowStorage(
      storage,
      usageRecords.tenantWorkflowIds,
    );
    usageRecords.storageBytes += await measureAssociatedWorkflowStorage(
      storage,
      usageRecords.tenantWorkflowIds,
    );
  }

  return usageRecords;
}

export async function getWorkflowCreationRateUsage(
  storage: WeftStorage,
  getNow: () => number,
  quotas: NormalizedTenantQuotaOptions,
  tenantId: string,
): Promise<number> {
  const rateLimit = quotas.maxWorkflowCreationRate;
  if (!rateLimit) {
    return 0;
  }

  return trimWorkflowCreationTimestamps(
    decodeWorkflowCreationRateRecord(
      await storage.get(KEYS.quotaRate(tenantId, rateLimit.windowMilliseconds)),
    ),
    getNow(),
    rateLimit.windowMilliseconds,
  ).length;
}

async function collectTopLevelTenantUsageRecords(
  storage: WeftStorage,
  tenantId: string,
): Promise<TenantUsageRecords> {
  const tenantWorkflowIds = new Set<string>();
  let activeWorkflows = 0;
  let storageBytes = 0;

  for await (const [key, value] of storage.scan('wf:')) {
    if (!isTopLevelWorkflowStateKey(key)) {
      continue;
    }

    const workflowState = decodeWorkflowTenantRecord(value);
    if (!workflowState || workflowState.tenant?.id !== tenantId) {
      continue;
    }

    tenantWorkflowIds.add(workflowState.id);
    storageBytes += measureStoredRecordBytes(key, value);

    if (isActiveWorkflowStatus(workflowState.status)) {
      activeWorkflows++;
    }
  }

  return { tenantWorkflowIds, activeWorkflows, storageBytes };
}

async function measureNestedWorkflowStorage(
  storage: WeftStorage,
  tenantWorkflowIds: Set<string>,
): Promise<number> {
  let storageBytes = 0;

  for (const workflowId of tenantWorkflowIds) {
    for await (const [key, value] of storage.scan(resolveNestedWorkflowPrefix(workflowId))) {
      storageBytes += measureStoredRecordBytes(key, value);
    }
  }

  return storageBytes;
}

async function measureAssociatedWorkflowStorage(
  storage: WeftStorage,
  tenantWorkflowIds: Set<string>,
): Promise<number> {
  let storageBytes = 0;

  for (const prefix of WORKFLOW_USAGE_SCAN_PREFIXES) {
    for await (const [key, value] of storage.scan(prefix)) {
      const workflowId = await extractWorkflowIdFromStoredRecord(storage, key, value);
      if (workflowId && tenantWorkflowIds.has(workflowId)) {
        storageBytes += measureStoredRecordBytes(key, value);
      }
    }
  }

  return storageBytes;
}
