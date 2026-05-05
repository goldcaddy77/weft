import { KEYS, tryDecodeStorageKeyComponent } from '../../storage/interface.ts';
import { decode } from '../codec.ts';
import { parseDuration } from '../scheduler.ts';
import type { TenantQuotaOptions, WorkflowStatus } from '../types.ts';
import type { DecodedWorkflowTenantRecord, NormalizedTenantQuotaOptions } from './types.ts';

const STORAGE_BYTE_ENCODER = new TextEncoder();

const WORKFLOW_OWNED_PREFIXES = [
  'wf:',
  'attr:',
  'sig:',
  'ev:',
  'review:',
  'wf-headers:',
  'offload:',
  'archive:',
  'state:execution:',
  'blob:',
  'tool-effect:',
  'upd:',
  'upk:',
] as const;

export const WORKFLOW_USAGE_SCAN_PREFIXES = [
  'attr:',
  'idx:',
  'tag:',
  'wf-deadline:',
  'wf-delayed:',
  'timer-idx:',
] as const;

const WORKFLOW_STATUSES: ReadonlySet<WorkflowStatus> = new Set([
  'pending',
  'running',
  'completed',
  'failed',
  'cancelled',
  'timed-out',
]);

export const MAX_CONDITIONAL_BATCH_ATTEMPTS = 5;

function validateLimitNumber(name: string, value: number): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function validateByteLimit(name: string, value: number): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return value;
}

export function normalizeQuotaOptions(
  options: TenantQuotaOptions | undefined,
): NormalizedTenantQuotaOptions {
  const maxConcurrentWorkflows =
    options?.maxConcurrentWorkflows !== undefined
      ? validateLimitNumber(
          'EngineOptions.quotas.maxConcurrentWorkflows',
          options.maxConcurrentWorkflows,
        )
      : null;

  const maxStorageBytes =
    options?.maxStorageBytes !== undefined
      ? validateByteLimit('EngineOptions.quotas.maxStorageBytes', options.maxStorageBytes)
      : null;

  const maxWorkflowCreationRate =
    options?.maxWorkflowCreationRate !== undefined
      ? {
          count: validateLimitNumber(
            'EngineOptions.quotas.maxWorkflowCreationRate.count',
            options.maxWorkflowCreationRate.count,
          ),
          windowMilliseconds: validateLimitNumber(
            'EngineOptions.quotas.maxWorkflowCreationRate.window',
            parseDuration(options.maxWorkflowCreationRate.window),
          ),
        }
      : null;

  return {
    maxConcurrentWorkflows,
    maxStorageBytes,
    maxWorkflowCreationRate,
  };
}

export function isTopLevelWorkflowStateKey(key: string): boolean {
  return key.startsWith('wf:') && !key.slice('wf:'.length).includes(':');
}

export function isActiveWorkflowStatus(status: WorkflowStatus): boolean {
  return status === 'pending' || status === 'running';
}

function isDecodedWorkflowStatus(value: unknown): value is WorkflowStatus {
  return typeof value === 'string' && WORKFLOW_STATUSES.has(value as WorkflowStatus);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

function extractWorkflowIdFromKeyWithPrefix(key: string, prefix: string): string | null {
  if (!key.startsWith(prefix)) {
    return null;
  }

  const remainder = key.slice(prefix.length);
  const separatorIndex = remainder.indexOf(':');
  const encodedWorkflowId = separatorIndex === -1 ? remainder : remainder.slice(0, separatorIndex);
  if (encodedWorkflowId.length === 0) {
    return null;
  }
  return tryDecodeStorageKeyComponent(encodedWorkflowId);
}

function extractWorkflowIdFromLastKeySegment(key: string): string | null {
  const lastSeparatorIndex = key.lastIndexOf(':');
  if (lastSeparatorIndex === -1 || lastSeparatorIndex === key.length - 1) {
    return null;
  }

  return tryDecodeStorageKeyComponent(key.slice(lastSeparatorIndex + 1));
}

export function extractWorkflowIdFromStorageKey(key: string): string | null {
  if (key.startsWith('idx:') || key.startsWith('tag:')) {
    return extractWorkflowIdFromLastKeySegment(key);
  }

  for (const prefix of WORKFLOW_OWNED_PREFIXES) {
    const workflowId = extractWorkflowIdFromKeyWithPrefix(key, prefix);
    if (workflowId !== null) {
      return workflowId;
    }
  }
  return null;
}

export function decodeTimerWorkflowId(bytes: Uint8Array): string | null {
  let decoded: unknown;
  try {
    decoded = decode(bytes);
  } catch {
    return null;
  }

  if (!isRecord(decoded) || typeof decoded['workflowId'] !== 'string') {
    return null;
  }

  return decoded['workflowId'];
}

export function decodeTimerIndexTargetKey(bytes: Uint8Array): string | null {
  let decoded: unknown;
  try {
    decoded = decode(bytes);
  } catch {
    return null;
  }

  return typeof decoded === 'string' ? decoded : null;
}

export function measureStoredRecordBytes(key: string, value: Uint8Array): number {
  return STORAGE_BYTE_ENCODER.encode(key).byteLength + value.byteLength;
}

export function resolveNestedWorkflowPrefix(workflowId: string): string {
  return `${KEYS.workflow(workflowId)}:`;
}

export function decodeWorkflowCreationRateRecord(bytes: Uint8Array | null): number[] {
  if (!bytes) {
    return [];
  }

  let decoded: unknown;
  try {
    decoded = decode(bytes);
  } catch {
    return [];
  }

  if (!isRecord(decoded) || !Array.isArray(decoded['timestamps'])) {
    return [];
  }

  return decoded['timestamps'].filter((value): value is number => Number.isFinite(value));
}

export function decodeTenantStorageUsageBytes(bytes: Uint8Array | null): number {
  if (!bytes) {
    return 0;
  }

  let decoded: unknown;
  try {
    decoded = decode(bytes);
  } catch {
    return 0;
  }

  if (!isRecord(decoded)) {
    return 0;
  }

  const bytesUsed = decoded['bytes'];
  if (typeof bytesUsed !== 'number' || !Number.isInteger(bytesUsed) || bytesUsed < 0) {
    return 0;
  }

  return bytesUsed;
}

export function decodeTenantActiveWorkflowIds(bytes: Uint8Array | null): string[] {
  if (!bytes) {
    return [];
  }

  let decoded: unknown;
  try {
    decoded = decode(bytes);
  } catch {
    return [];
  }

  if (!isRecord(decoded) || !Array.isArray(decoded['workflowIds'])) {
    return [];
  }

  return [
    ...new Set(
      decoded['workflowIds'].filter((value): value is string => typeof value === 'string'),
    ),
  ];
}

export function decodeWorkflowTenantRecord(bytes: Uint8Array): DecodedWorkflowTenantRecord | null {
  let decoded: unknown;
  try {
    decoded = decode(bytes);
  } catch {
    return null;
  }

  if (!isRecord(decoded)) {
    return null;
  }

  const id = decoded['id'];
  const status = decoded['status'];
  const tenant = decoded['tenant'];
  if (typeof id !== 'string' || !isDecodedWorkflowStatus(status)) {
    return null;
  }

  if (tenant === undefined) {
    return { id, status };
  }

  if (!isRecord(tenant) || typeof tenant['id'] !== 'string') {
    return null;
  }

  return {
    id,
    status,
    tenant: {
      id: tenant['id'],
    },
  };
}

export function trimWorkflowCreationTimestamps(
  timestamps: number[],
  now: number,
  windowMilliseconds: number,
): number[] {
  const earliestAllowedTimestamp = now - windowMilliseconds;
  return timestamps.filter((timestamp) => timestamp > earliestAllowedTimestamp);
}
