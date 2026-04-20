import * as lmdb from 'lmdb';

import {
  matchesScanOptions,
  resolvePrefixRangeEnd,
  type BatchOperation,
  type ScanOptions,
  type Storage,
} from './interface';
import { scopedStorage } from './scoped-storage';

/**
 * LMDB-backed storage adapter. Reads are synchronous zero-copy via
 * memory-mapped files. Writes use lmdb-js's async batching: individual
 * `put`/`remove` calls return promises that resolve once the next
 * batched transaction commits to disk.
 */
export class LMDBStorage implements Storage {
  #database: lmdb.RootDatabase<Buffer, string>;
  #requiresFreshReadSnapshot = false;

  constructor(path: string) {
    this.#database = lmdb.open<Buffer, string>({
      path,
      encoding: 'binary',
    });
  }

  #refreshReadSnapshotIfRequired(): void {
    if (!this.#requiresFreshReadSnapshot) {
      return;
    }

    this.#database.resetReadTxn();
    this.#requiresFreshReadSnapshot = false;
  }

  async get(key: string): Promise<Uint8Array | null> {
    this.#refreshReadSnapshotIfRequired();
    const value = this.#database.get(key);
    if (value === undefined) return null;
    return new Uint8Array(value);
  }

  async put(key: string, value: Uint8Array): Promise<void> {
    await this.#database.put(key, Buffer.from(value));
    this.#requiresFreshReadSnapshot = true;
  }

  async delete(key: string): Promise<void> {
    await this.#database.remove(key);
    this.#requiresFreshReadSnapshot = true;
  }

  async has(key: string): Promise<boolean> {
    this.#refreshReadSnapshotIfRequired();
    return this.#database.doesExist(key);
  }

  async deletePrefix(prefix: string): Promise<number> {
    const keys: string[] = [];
    for await (const key of this.keys(prefix)) {
      keys.push(key);
    }

    if (keys.length === 0) {
      return 0;
    }

    await this.#database.batch(() => {
      for (const key of keys) {
        void this.#database.remove(key);
      }
    });
    this.#requiresFreshReadSnapshot = true;

    return keys.length;
  }

  async *scan(prefix: string, options: ScanOptions = {}): AsyncIterable<[string, Uint8Array]> {
    this.#refreshReadSnapshotIfRequired();
    const { limit, reverse, gt, lt, gte, lte } = options;

    const prefixEnd = resolvePrefixRangeEnd(prefix);

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
    let enteredPrefix = false;
    for (const { key, value } of range) {
      // Safety: ensure we stay within the prefix range.
      // Forward: keys past the prefix are lexicographically greater — break.
      // Reverse: iteration starts at prefixEnd which may itself not match — skip
      // non-matching keys until we enter the prefix range, then break when we leave.
      if (!key.startsWith(prefix)) {
        if (reverse && !enteredPrefix) continue;
        break;
      }
      enteredPrefix = true;
      if (gt !== undefined && key <= gt) continue;
      if (gte !== undefined && key < gte) continue;
      if (lt !== undefined && key >= lt) continue;
      if (lte !== undefined && key > lte) continue;

      if (limit !== undefined && count >= limit) break;

      yield [key, new Uint8Array(value)];
      count++;
    }
  }

  async *keys(prefix: string, options: ScanOptions = {}): AsyncIterable<string> {
    this.#refreshReadSnapshotIfRequired();
    const { limit, reverse } = options;
    const prefixEnd = resolvePrefixRangeEnd(prefix);

    const range = reverse
      ? this.#database.getKeys({
          start: prefixEnd,
          end: prefix,
          reverse: true,
        })
      : this.#database.getKeys({ start: prefix, end: prefixEnd });

    let count = 0;
    let enteredPrefix = false;
    for (const key of range) {
      if (!key.startsWith(prefix)) {
        if (reverse && !enteredPrefix) {
          continue;
        }
        break;
      }

      enteredPrefix = true;

      if (!matchesScanOptions(key, options)) {
        continue;
      }

      if (limit !== undefined && count >= limit) {
        break;
      }

      yield key;
      count++;
    }
  }

  async count(prefix: string): Promise<number> {
    this.#refreshReadSnapshotIfRequired();
    const prefixEnd = resolvePrefixRangeEnd(prefix);
    return this.#database.getKeysCount({ start: prefix, end: prefixEnd });
  }

  scoped(prefix: string): Storage {
    const scoped = scopedStorage(this, prefix);
    return scoped;
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
    this.#requiresFreshReadSnapshot = true;
  }

  [Symbol.dispose](): void {
    this.#requiresFreshReadSnapshot = false;
    void this.#database.close();
  }
}
