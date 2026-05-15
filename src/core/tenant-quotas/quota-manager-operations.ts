import type { BatchOperation } from '../../storage/interface.ts';
import { KEYS } from '../../storage/interface.ts';
import { encode } from '../codec.ts';

export type QuotaCondition = {
  key: string;
  expectedValue: Uint8Array | null;
};

export function activeQuotaReleaseOperation(
  tenantId: string,
  remainingWorkflowIds: string[],
): BatchOperation {
  if (remainingWorkflowIds.length === 0) {
    return { type: 'delete', key: KEYS.quotaActive(tenantId) };
  }

  return {
    type: 'put',
    key: KEYS.quotaActive(tenantId),
    value: encodeTenantActiveWorkflowIds(remainingWorkflowIds),
  };
}

export function storageQuotaReleaseOperation(
  tenantId: string,
  remainingStorageBytes: number,
): BatchOperation {
  if (remainingStorageBytes === 0) {
    return { type: 'delete', key: KEYS.quotaStorage(tenantId) };
  }

  return {
    type: 'put',
    key: KEYS.quotaStorage(tenantId),
    value: encodeTenantStorageBytes(remainingStorageBytes),
  };
}

export function encodeTenantActiveWorkflowIds(workflowIds: string[]): Uint8Array {
  return encode({ workflowIds });
}

export function encodeTenantStorageBytes(bytes: number): Uint8Array {
  return encode({ bytes });
}

export function quotaCondition(key: string, expectedValue: Uint8Array | null): QuotaCondition {
  return { key, expectedValue };
}
