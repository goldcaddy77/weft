import type { Storage as WeftStorage } from '../../storage/interface.ts';
import { KEYS } from '../../storage/interface.ts';
import {
  decodeTimerIndexTargetKey,
  decodeTimerWorkflowId,
  decodeWorkflowTenantRecord,
  extractWorkflowIdFromStorageKey,
  isActiveWorkflowStatus,
  isTopLevelWorkflowStateKey,
  measureStoredRecordBytes,
  resolveNestedWorkflowPrefix,
  WORKFLOW_USAGE_SCAN_PREFIXES,
} from './storage-helpers.ts';

export async function listTenantActiveWorkflowIds(
  storage: WeftStorage,
  tenantId: string,
): Promise<string[]> {
  const workflowIds = new Set<string>();

  for await (const [key, value] of storage.scan('wf:')) {
    if (!isTopLevelWorkflowStateKey(key)) {
      continue;
    }

    const workflowState = decodeWorkflowTenantRecord(value);
    if (!workflowState || workflowState.tenant?.id !== tenantId) {
      continue;
    }

    if (isActiveWorkflowStatus(workflowState.status)) {
      workflowIds.add(workflowState.id);
    }
  }

  return [...workflowIds];
}

export function extractWorkflowIdFromPendingOperation(
  key: string,
  value: Uint8Array,
  putOperationValues: ReadonlyMap<string, Uint8Array>,
): string | null {
  if (key.startsWith('wf-deadline:') || key.startsWith('wf-delayed:')) {
    return decodeTimerWorkflowId(value);
  }

  if (key.startsWith('timer-idx:')) {
    const timerTargetKey = decodeTimerIndexTargetKey(value);
    if (!timerTargetKey) {
      return null;
    }

    const timerTargetValue = putOperationValues.get(timerTargetKey);
    return timerTargetValue ? decodeTimerWorkflowId(timerTargetValue) : null;
  }

  return extractWorkflowIdFromStorageKey(key);
}

export async function extractWorkflowIdFromStoredRecord(
  storage: WeftStorage,
  key: string,
  value: Uint8Array,
): Promise<string | null> {
  if (key.startsWith('wf-deadline:') || key.startsWith('wf-delayed:')) {
    return decodeTimerWorkflowId(value);
  }

  if (key.startsWith('timer-idx:')) {
    const timerTargetKey = decodeTimerIndexTargetKey(value);
    if (!timerTargetKey) {
      return null;
    }

    const timerTargetValue = await storage.get(timerTargetKey);
    return timerTargetValue ? decodeTimerWorkflowId(timerTargetValue) : null;
  }

  return extractWorkflowIdFromStorageKey(key);
}

export async function measureWorkflowStorageBytes(
  storage: WeftStorage,
  workflowId: string,
): Promise<number> {
  let storageBytes = 0;

  const workflowStateBytes = await storage.get(KEYS.workflow(workflowId));
  if (workflowStateBytes !== null) {
    storageBytes += measureStoredRecordBytes(KEYS.workflow(workflowId), workflowStateBytes);
  }

  for await (const [key, value] of storage.scan(resolveNestedWorkflowPrefix(workflowId))) {
    storageBytes += measureStoredRecordBytes(key, value);
  }

  for (const prefix of WORKFLOW_USAGE_SCAN_PREFIXES) {
    for await (const [key, value] of storage.scan(prefix)) {
      const ownedWorkflowId = await extractWorkflowIdFromStoredRecord(storage, key, value);
      if (ownedWorkflowId !== workflowId) {
        continue;
      }

      storageBytes += measureStoredRecordBytes(key, value);
    }
  }

  return storageBytes;
}
