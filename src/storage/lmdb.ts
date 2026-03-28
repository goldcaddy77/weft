import type { Database } from 'lmdb';
import { open } from 'lmdb';

import type { BatchOperation, ScanOptions, Storage } from './interface';

/** High-performance LMDB storage adapter. Uses memory-mapped, zero-copy reads. */
export class LMDBStorage implements Storage {
  #database: Database<Buffer, string>;

  constructor(path: string = './weft-data') {
    this.#database = open({
      path,
      encoding: 'binary',
      mapSize: 2 * 1024 * 1024 * 1024, // 2GB initial map (auto-grows)
      maxDbs: 1,
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

    const prefixEnd =
      prefix.length > 0
        ? prefix.slice(0, -1) + String.fromCharCode(prefix.charCodeAt(prefix.length - 1) + 1)
        : '\xff';

    const rangeStart = gte ?? prefix;
    const rangeEnd = lt ?? prefixEnd;

    const range = this.#database.getRange({
      start: reverse ? rangeEnd : rangeStart,
      end: reverse ? rangeStart : rangeEnd,
      reverse: reverse ?? false,
    });

    let count = 0;
    for (const { key, value } of range) {
      const k = key;

      // Apply prefix filter (needed when gte overrides the prefix start).
      if (prefix.length > 0 && (k < prefix || k >= prefixEnd)) continue;

      // Apply bound filters.
      if (gt !== undefined && k <= gt) continue;
      if (lte !== undefined && k > lte) continue;

      // For reverse scans, exclude the end boundary key.
      if (reverse && k >= rangeEnd) continue;

      if (limit !== undefined && count >= limit) break;

      yield [k, new Uint8Array(value)];
      count++;
    }
  }

  async batch(operations: BatchOperation[]): Promise<void> {
    if (operations.length === 0) return;

    await this.#database.transaction(() => {
      for (const operation of operations) {
        if (operation.type === 'put') {
          this.#database.putSync(operation.key, Buffer.from(operation.value));
        } else {
          this.#database.removeSync(operation.key);
        }
      }
    });
  }

  [Symbol.dispose](): void {
    void this.#database.close();
  }
}
