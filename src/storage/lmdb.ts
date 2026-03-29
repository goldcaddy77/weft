import * as lmdb from 'lmdb';

import type { BatchOperation, ScanOptions, Storage } from './interface';

/**
 * LMDB-backed storage adapter. Reads are synchronous zero-copy via
 * memory-mapped files. Writes use lmdb-js's async batching: individual
 * `put`/`remove` calls return promises that resolve once the next
 * batched transaction commits to disk.
 */
export class LMDBStorage implements Storage {
  #database: lmdb.RootDatabase<Buffer, string>;

  constructor(path: string) {
    this.#database = lmdb.open<Buffer, string>({
      path,
      encoding: 'binary',
    });
  }

  async get(key: string): Promise<Uint8Array | null> {
    const value = this.#database.get(key);
    if (value === undefined) return null;
    return new Uint8Array(value);
  }

  async put(key: string, value: Uint8Array): Promise<void> {
    await this.#database.put(key, Buffer.from(value));
  }

  async delete(key: string): Promise<void> {
    await this.#database.remove(key);
  }

  async *scan(prefix: string, options: ScanOptions = {}): AsyncIterable<[string, Uint8Array]> {
    const { limit, reverse, gt, lt, gte, lte } = options;

    // Compute the exclusive upper bound for the prefix range, matching
    // MemoryStorage and BunSQLiteStorage.
    const prefixEnd =
      prefix.length > 0
        ? prefix.slice(0, -1) + String.fromCharCode(prefix.charCodeAt(prefix.length - 1) + 1)
        : '\xff';

    // In lmdb-js, reverse iteration requires start > end: start is the
    // upper bound to iterate backwards from, end is the lower bound to stop at.
    const range = reverse
      ? this.#database.getRange({
          start: prefixEnd,
          end: prefix,
          reverse: true,
        })
      : this.#database.getRange({ start: prefix, end: prefixEnd });

    let count = 0;
    for (const { key, value } of range) {
      // Safety: ensure we stay within the prefix range.
      // Forward: keys past the prefix are lexicographically greater — break.
      // Reverse: iteration starts at prefixEnd which may itself not match — skip
      // non-matching keys until we enter the prefix range, then break when we leave.
      if (!key.startsWith(prefix)) {
        if (reverse) continue;
        break;
      }
      if (gt !== undefined && key <= gt) continue;
      if (gte !== undefined && key < gte) continue;
      if (lt !== undefined && key >= lt) continue;
      if (lte !== undefined && key > lte) continue;

      if (limit !== undefined && count >= limit) break;

      yield [key, new Uint8Array(value)];
      count++;
    }
  }

  async batch(operations: BatchOperation[]): Promise<void> {
    if (operations.length === 0) return;

    await this.#database.batch(() => {
      for (const operation of operations) {
        if (operation.type === 'put') {
          void this.#database.put(operation.key, Buffer.from(operation.value));
        } else {
          void this.#database.remove(operation.key);
        }
      }
    });
  }

  [Symbol.dispose](): void {
    void this.#database.close();
  }
}
