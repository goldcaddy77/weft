/** A single KV operation in a batch. */
export type BatchOperation =
  | { type: 'put'; key: string; value: Uint8Array }
  | { type: 'delete'; key: string };

/** Options for range scans. */
export interface ScanOptions {
  limit?: number;
  reverse?: boolean;
  gt?: string;
  lt?: string;
  gte?: string;
  lte?: string;
}

/** KV-oriented storage interface. All storage adapters implement this. */
export interface Storage extends Disposable {
  get(key: string): Promise<Uint8Array | null>;
  put(key: string, value: Uint8Array): Promise<void>;
  delete(key: string): Promise<void>;
  scan(prefix: string, options?: ScanOptions): AsyncIterable<[string, Uint8Array]>;
  batch(operations: BatchOperation[]): Promise<void>;
  has?(key: string): Promise<boolean>;
  deletePrefix?(prefix: string): Promise<number>;
  keys?(prefix: string, options?: ScanOptions): AsyncIterable<string>;
  count?(prefix: string): Promise<number>;
  scoped?(prefix: string): Storage;

  /** Optional SQL passthrough for dashboard/debugging (SQLite only). */
  query?<T>(sql: string, params?: unknown[]): Promise<T[]>;
}

/** Resolve the exclusive upper bound for a lexicographic prefix scan. */
export function resolvePrefixRangeEnd(prefix: string): string {
  return prefix.length > 0
    ? prefix.slice(0, -1) + String.fromCharCode(prefix.charCodeAt(prefix.length - 1) + 1)
    : '\xff';
}

/** Apply gt/gte/lt/lte scan bounds to a single key. */
export function matchesScanOptions(key: string, options: ScanOptions = {}): boolean {
  if (options.gt !== undefined && key <= options.gt) {
    return false;
  }

  if (options.gte !== undefined && key < options.gte) {
    return false;
  }

  if (options.lt !== undefined && key >= options.lt) {
    return false;
  }

  if (options.lte !== undefined && key > options.lte) {
    return false;
  }

  return true;
}

/** Check key existence using the adapter method when available or a core fallback otherwise. */
export async function storageHas(storage: Storage, key: string): Promise<boolean> {
  if (storage.has) {
    return storage.has(key);
  }

  return (await storage.get(key)) !== null;
}

/** Iterate keys only, using the adapter shortcut when available or `scan()` as a fallback. */
export function storageKeys(
  storage: Storage,
  prefix: string,
  options?: ScanOptions,
): AsyncIterable<string> {
  if (storage.keys) {
    return storage.keys(prefix, options);
  }

  return (async function* (): AsyncIterable<string> {
    for await (const [key] of storage.scan(prefix, options)) {
      yield key;
    }
  })();
}

/** Count keys for a prefix using the adapter method when available or iteration otherwise. */
export async function storageCount(storage: Storage, prefix: string): Promise<number> {
  if (storage.count) {
    return storage.count(prefix);
  }

  let count = 0;
  for await (const _key of storageKeys(storage, prefix)) {
    count++;
  }
  return count;
}

/** Delete a whole prefix using the adapter method when available or a batched fallback otherwise. */
export async function storageDeletePrefix(storage: Storage, prefix: string): Promise<number> {
  if (storage.deletePrefix) {
    return storage.deletePrefix(prefix);
  }

  const operations: BatchOperation[] = [];

  for await (const key of storageKeys(storage, prefix)) {
    operations.push({ type: 'delete', key });
  }

  if (operations.length === 0) {
    return 0;
  }

  await storage.batch(operations);
  return operations.length;
}

/** Encode an untrusted string so it is safe to embed in a colon-delimited storage key. */
export function encodeStorageKeyComponent(value: string): string {
  return encodeURIComponent(value);
}

/** Decode a storage-key component produced by {@link encodeStorageKeyComponent}. */
export function decodeStorageKeyComponent(value: string): string {
  return decodeURIComponent(value);
}

/**
 * Decode a storage-key component produced by {@link encodeStorageKeyComponent}.
 * Returns `null` when the component is malformed instead of throwing.
 */
export function tryDecodeStorageKeyComponent(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function formatSortableTimestamp(timestamp: number): string {
  return String(timestamp).padStart(16, '0');
}

/**
 * Key layout constants for hierarchical key encoding.
 * All timestamps are zero-padded to 16 digits for correct lexicographic ordering.
 */
export const KEYS = {
  workflow: (id: string) => `wf:${encodeStorageKeyComponent(id)}`,
  checkpoint: (id: string) => `wf:${encodeStorageKeyComponent(id)}:ckpt`,
  checkpointHistory: (id: string, step: number) =>
    `wf:${encodeStorageKeyComponent(id)}:ckpt:${String(step).padStart(10, '0')}`,
  timelinePrefix: (id: string) => `wf:${encodeStorageKeyComponent(id)}:timeline:`,
  timeline: (id: string, step: number) =>
    `wf:${encodeStorageKeyComponent(id)}:timeline:${String(step).padStart(10, '0')}`,
  schedule: (id: string) => `schedule:${encodeStorageKeyComponent(id)}`,
  scheduleTick: (fireAt: number, id: string) =>
    `schedule-due:${String(fireAt).padStart(16, '0')}:${encodeStorageKeyComponent(id)}`,
  scheduleRun: (workflowId: string) => `schedule-run:${encodeStorageKeyComponent(workflowId)}`,
  operation: (queue: string, scheduledAt: number, id: string) =>
    `op:${queue}:${formatSortableTimestamp(scheduledAt)}:${id}`,
  operationInflight: (id: string) => `op:inflight:${id}`,
  operationQueued: (id: string) => `op:queued:${id}`,
  operationResolved: (id: string) => `op:resolved:${id}`,
  eventPrefix: (workflowId: string) => `ev:${encodeStorageKeyComponent(workflowId)}:`,
  event: (workflowId: string, sequence: number) =>
    `ev:${encodeStorageKeyComponent(workflowId)}:${String(sequence).padStart(10, '0')}`,
  eventHead: (workflowId: string) => `ev:${encodeStorageKeyComponent(workflowId)}:head`,
  signal: (workflowId: string, name: string, id: string) =>
    `sig:${encodeStorageKeyComponent(workflowId)}:${name}:${id}`,
  deadline: (deadline: number, workflowId: string) =>
    `wf-deadline:${formatSortableTimestamp(deadline)}:${encodeStorageKeyComponent(workflowId)}`,
  delayedStart: (startAt: number, workflowId: string) =>
    `wf-delayed:${formatSortableTimestamp(startAt)}:${encodeStorageKeyComponent(workflowId)}`,
  terminalWorkflowPrefix: () => 'wf-terminal:',
  terminalWorkflow: (updatedAt: number, workflowId: string) =>
    `wf-terminal:${formatSortableTimestamp(updatedAt)}:${encodeStorageKeyComponent(workflowId)}`,
  attribute: (workflowId: string) => `attr:${encodeStorageKeyComponent(workflowId)}`,
  attributeIndex: (attributeName: string, encodedValue: string, workflowId: string) =>
    `idx:${attributeName}:${encodedValue}:${encodeStorageKeyComponent(workflowId)}`,
  tagIndex: (tag: string, workflowId: string) =>
    `tag:${encodeStorageKeyComponent(tag)}:${encodeStorageKeyComponent(workflowId)}`,
  updatePrefix: (workflowId: string) => `upd:${encodeStorageKeyComponent(workflowId)}:`,
  update: (workflowId: string, updateId: string) =>
    `upd:${encodeStorageKeyComponent(workflowId)}:${updateId}`,
  updateResponse: (updateId: string) => `upr:${updateId}`,
  updateIdempotency: (workflowId: string, key: string) =>
    `upk:${encodeStorageKeyComponent(workflowId)}:${key}`,
  budget: (namespace: string, period: string, date: string) =>
    `budget:${namespace}:${period}:${date}`,
  review: (workflowId: string, reviewId: string) =>
    `review:${encodeStorageKeyComponent(workflowId)}:${reviewId}`,
  workflowHeaders: (workflowId: string) => `wf-headers:${encodeStorageKeyComponent(workflowId)}`,
  offload: (workflowId: string, key: string) =>
    `offload:${encodeStorageKeyComponent(workflowId)}:${key}`,
  archive: (workflowId: string, key: string) =>
    `archive:${encodeStorageKeyComponent(workflowId)}:${key}`,
  sharedState: (workflowId: string, stateKey: string) =>
    `shared:${encodeStorageKeyComponent(workflowId)}:${stateKey}`,
  sharedStateVersion: (workflowId: string, stateKey: string) =>
    `shared:${encodeStorageKeyComponent(workflowId)}:${stateKey}:version`,
  streamChunkPrefix: (workflowId: string, key: string) =>
    `blob:${encodeStorageKeyComponent(workflowId)}:${key}:chunk:`,
  streamChunk: (workflowId: string, key: string, chunkIndex: number) =>
    `blob:${encodeStorageKeyComponent(workflowId)}:${key}:chunk:${String(chunkIndex).padStart(10, '0')}`,
  streamMetadata: (workflowId: string, key: string) =>
    `blob:${encodeStorageKeyComponent(workflowId)}:${key}:meta`,
  budgetCharged: (operationId: string) => `budget-charged:${operationId}`,
  toolEffect: (workflowId: string, agentId: string, semanticHash: string) =>
    `tool-effect:${encodeStorageKeyComponent(workflowId)}:${agentId}:${semanticHash}`,
} as const;
