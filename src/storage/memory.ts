import type { BatchOperation, ScanOptions, Storage } from './interface';

export class MemoryStorage implements Storage {
  #data: Map<string, Uint8Array> = new Map();

  async get(key: string): Promise<Uint8Array | null> {
    return this.#data.get(key) ?? null;
  }

  async put(key: string, value: Uint8Array): Promise<void> {
    this.#data.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.#data.delete(key);
  }

  async *scan(prefix: string, options: ScanOptions = {}): AsyncIterable<[string, Uint8Array]> {
    const { limit, reverse, gt, lt, gte, lte } = options;

    // Compute the exclusive upper bound for the prefix range.
    const prefixEnd =
      prefix.slice(0, -1) + String.fromCharCode(prefix.charCodeAt(prefix.length - 1) + 1);

    // Sort all keys lexicographically and filter to the prefix range.
    let keys = [...this.#data.keys()].filter((key) => key >= prefix && key < prefixEnd).toSorted();

    // Apply bound filters.
    if (gt !== undefined) {
      keys = keys.filter((key) => key > gt);
    }
    if (gte !== undefined) {
      keys = keys.filter((key) => key >= gte);
    }
    if (lt !== undefined) {
      keys = keys.filter((key) => key < lt);
    }
    if (lte !== undefined) {
      keys = keys.filter((key) => key <= lte);
    }

    if (reverse) {
      keys.reverse();
    }

    let count = 0;
    for (const key of keys) {
      if (limit !== undefined && count >= limit) break;
      const value = this.#data.get(key);
      if (value !== undefined) {
        yield [key, value];
        count++;
      }
    }
  }

  async batch(operations: BatchOperation[]): Promise<void> {
    for (const operation of operations) {
      if (operation.type === 'put') {
        this.#data.set(operation.key, operation.value);
      } else {
        this.#data.delete(operation.key);
      }
    }
  }

  get size(): number {
    return this.#data.size;
  }

  clear(): void {
    this.#data.clear();
  }

  has(key: string): boolean {
    return this.#data.has(key);
  }

  keys(): string[] {
    return [...this.#data.keys()].toSorted();
  }

  snapshot(): Map<string, Uint8Array> {
    const copy = new Map<string, Uint8Array>();
    for (const [key, value] of this.#data) {
      copy.set(key, new Uint8Array(value));
    }
    return copy;
  }

  [Symbol.dispose](): void {
    this.#data.clear();
  }
}
