import { MAX_BATCH_OPERATIONS } from './batch-limits.ts';
import type { NormalizedDeleteRangeOptions } from './delete-range.ts';
import { type BatchOperation, type ScanOptions, type Storage } from './interface.ts';

/**
 * Non-dispatching implementations of the derived storage operations.
 *
 * These helpers compute `has`/`keys`/`count`/`deletePrefix` purely from the
 * required `get`/`scan`/`batch` primitives. Unlike the public `storageHas`,
 * `storageKeys`, `storageCount`, and `storageDeletePrefix` dispatchers in
 * `./interface.ts`, they **never** consult the adapter's optional fast-path
 * methods. That distinction matters in two places:
 *
 * 1. The public dispatchers call these as their fallback branch (when the
 *    adapter omits the optional method), so the derived logic lives here once.
 * 2. Adapters that *do* expose the optional methods (e.g. {@link HTTPStorage},
 *    {@link WebExtensionStorage}) implement them by delegating here. They cannot
 *    delegate to the public dispatchers, which would re-dispatch back into the
 *    adapter method and recurse forever.
 *
 * This module is internal: it is not listed as a package subpath export and must
 * not be re-exported from public entry points.
 */

/**
 * Core `has` derivation: a key exists when `get` returns a non-null value.
 */
export async function storageHasCore(storage: Storage, key: string): Promise<boolean> {
  return (await storage.get(key)) !== null;
}

/**
 * Core `keys` derivation: project `scan` entries down to their keys, preserving
 * the adapter's `scan` ordering, `limit`, and `reverse` semantics.
 */
export async function* storageKeysCore(
  storage: Storage,
  prefix: string,
  options?: ScanOptions,
): AsyncIterable<string> {
  for await (const [key] of storage.scan(prefix, options)) {
    yield key;
  }
}

/**
 * Core `count` derivation: count the keys matching a prefix.
 */
export async function storageCountCore(storage: Storage, prefix: string): Promise<number> {
  let count = 0;
  for await (const _key of storageKeysCore(storage, prefix)) {
    count++;
  }
  return count;
}

/**
 * Delete the keys yielded by `keys()` in batches capped at
 * {@link MAX_BATCH_OPERATIONS}, so a prefix/range holding more keys than one
 * batch admits still deletes fully instead of throwing
 * {@link StorageBatchOperationLimitExceededError}. Returns the number of keys
 * deleted.
 *
 * The chunking sacrifices the whole-prefix atomicity a single `batch()` would
 * give — a crash between chunks leaves a partial delete — but a partial delete
 * of an owned key range is safe for every caller here: purge deletes the state
 * row last in its own fenced commit, so a partially-deleted run stays terminal,
 * listed, and re-purgeable. Callers that need all-or-nothing must not route
 * through this fallback.
 */
async function deleteKeysInCappedBatches(
  storage: Storage,
  keys: AsyncIterable<string>,
): Promise<number> {
  let deleted = 0;
  let operations: BatchOperation[] = [];

  for await (const key of keys) {
    operations.push({ type: 'delete', key });
    if (operations.length >= MAX_BATCH_OPERATIONS) {
      await storage.batch(operations);
      deleted += operations.length;
      operations = [];
    }
  }

  if (operations.length > 0) {
    await storage.batch(operations);
    deleted += operations.length;
  }

  return deleted;
}

/**
 * Core `deletePrefix` derivation: remove every key under `prefix` in
 * cap-sized batches. Returns the number of keys deleted. Chunked (rather than
 * one batch) so a prefix larger than {@link MAX_BATCH_OPERATIONS} still deletes
 * — see {@link deleteKeysInCappedBatches} for the atomicity trade-off.
 */
export async function storageDeletePrefixCore(storage: Storage, prefix: string): Promise<number> {
  return deleteKeysInCappedBatches(storage, storageKeysCore(storage, prefix));
}

/**
 * Core `deleteRange` derivation: scan the keys under `prefix` that match the
 * (already-normalized) bounds and remove them in cap-sized batches. Returns the
 * number of keys deleted.
 *
 * The bounds are honored by `scan` via `matchesScanOptions`; `limit` caps the
 * delete to the lowest (ascending) keys in range. Like
 * {@link storageDeletePrefixCore}, this is best-effort over the keys observed by
 * the scan: a key inserted after the scan begins is not deleted. Takes a
 * {@link NormalizedDeleteRangeOptions} because the only caller, the public
 * `storageDeleteRange` dispatcher, validates first — keeping this module's
 * type-only dependency on `interface.ts` intact (no runtime import cycle).
 */
export async function storageDeleteRangeCore(
  storage: Storage,
  prefix: string,
  options: NormalizedDeleteRangeOptions,
): Promise<number> {
  return deleteKeysInCappedBatches(storage, storageKeysCore(storage, prefix, options));
}
