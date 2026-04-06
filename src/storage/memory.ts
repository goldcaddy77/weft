import type { BatchOperation, ScanOptions, Storage } from './interface';

export class MemoryStorage implements Storage {
  #data: Map<string, Uint8Array>;

  constructor() {
    this.#data = new Map();
  }

  #matchesPrefix(key: string, prefix: string, prefixEnd: string): boolean {
    return key >= prefix && key < prefixEnd;
  }

  #resolvePrefixEnd(prefix: string): string {
    return prefix.length > 0
      ? prefix.slice(0, -1) + String.fromCharCode(prefix.charCodeAt(prefix.length - 1) + 1)
      : '\xff';
  }

  #collectSortedKeys(prefix: string, prefixEnd: string): string[] {
    const keys: string[] = [];
    for (const key of this.#data.keys()) {
      if (this.#matchesPrefix(key, prefix, prefixEnd)) {
        keys.push(key);
      }
    }
    return keys.toSorted();
  }

  #applyBound(
    keys: string[],
    bound: string | undefined,
    predicate: (key: string, boundary: string) => boolean,
  ): string[] {
    if (bound === undefined) {
      return keys;
    }

    const filtered: string[] = [];
    for (const key of keys) {
      if (predicate(key, bound)) {
        filtered.push(key);
      }
    }
    return filtered;
  }

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

    const prefixEnd = this.#resolvePrefixEnd(prefix);
    let keys = this.#collectSortedKeys(prefix, prefixEnd);
    keys = this.#applyBound(keys, gt, (key, boundary) => key > boundary);
    keys = this.#applyBound(keys, gte, (key, boundary) => key >= boundary);
    keys = this.#applyBound(keys, lt, (key, boundary) => key < boundary);
    keys = this.#applyBound(keys, lte, (key, boundary) => key <= boundary);

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
