import {
  storageCount,
  storageDeletePrefix,
  storageHas,
  storageKeys,
  type BatchOperation,
  type ScanOptions,
  type Storage,
} from './interface.ts';

function normalizeScopePrefix(prefix: string): string {
  return prefix.replaceAll(/:+$/g, '');
}

function joinScopePrefixes(leftPrefix: string, rightPrefix: string): string {
  const normalizedLeftPrefix = normalizeScopePrefix(leftPrefix);
  const normalizedRightPrefix = normalizeScopePrefix(rightPrefix);

  if (normalizedLeftPrefix.length === 0) {
    return normalizedRightPrefix;
  }

  if (normalizedRightPrefix.length === 0) {
    return normalizedLeftPrefix;
  }

  return `${normalizedLeftPrefix}:${normalizedRightPrefix}`;
}

export class ScopedStorage implements Storage {
  #storage: Storage;
  #scopePrefix: string;

  constructor(storage: Storage, prefix: string) {
    this.#storage = storage;
    this.#scopePrefix = normalizeScopePrefix(prefix);
  }

  #toInnerKey(key: string): string {
    if (this.#scopePrefix.length === 0) {
      return key;
    }

    return key.length === 0 ? `${this.#scopePrefix}:` : `${this.#scopePrefix}:${key}`;
  }

  #toPublicKey(key: string): string {
    if (this.#scopePrefix.length === 0) {
      return key;
    }

    return key.slice(this.#scopePrefix.length + 1);
  }

  #toInnerOptions(options: ScanOptions = {}): ScanOptions {
    const innerOptions: ScanOptions = {};

    if (options.limit !== undefined) {
      innerOptions.limit = options.limit;
    }

    if (options.reverse !== undefined) {
      innerOptions.reverse = options.reverse;
    }

    if (options.gt !== undefined) {
      innerOptions.gt = this.#toInnerKey(options.gt);
    }

    if (options.gte !== undefined) {
      innerOptions.gte = this.#toInnerKey(options.gte);
    }

    if (options.lt !== undefined) {
      innerOptions.lt = this.#toInnerKey(options.lt);
    }

    if (options.lte !== undefined) {
      innerOptions.lte = this.#toInnerKey(options.lte);
    }

    return innerOptions;
  }

  scoped(prefix: string): ScopedStorage {
    return new ScopedStorage(this.#storage, joinScopePrefixes(this.#scopePrefix, prefix));
  }

  async get(key: string): Promise<Uint8Array | null> {
    return this.#storage.get(this.#toInnerKey(key));
  }

  async put(key: string, value: Uint8Array): Promise<void> {
    await this.#storage.put(this.#toInnerKey(key), value);
  }

  async delete(key: string): Promise<void> {
    await this.#storage.delete(this.#toInnerKey(key));
  }

  async *scan(prefix: string, options?: ScanOptions): AsyncIterable<[string, Uint8Array]> {
    for await (const [key, value] of this.#storage.scan(
      this.#toInnerKey(prefix),
      this.#toInnerOptions(options),
    )) {
      yield [this.#toPublicKey(key), value];
    }
  }

  async batch(operations: BatchOperation[]): Promise<void> {
    await this.#storage.batch(
      operations.map((operation) => {
        if (operation.type === 'put') {
          return {
            type: 'put' as const,
            key: this.#toInnerKey(operation.key),
            value: operation.value,
          };
        }

        return {
          type: 'delete' as const,
          key: this.#toInnerKey(operation.key),
        };
      }),
    );
  }

  async has(key: string): Promise<boolean> {
    return storageHas(this.#storage, this.#toInnerKey(key));
  }

  async deletePrefix(prefix: string): Promise<number> {
    return storageDeletePrefix(this.#storage, this.#toInnerKey(prefix));
  }

  async *keys(prefix: string, options?: ScanOptions): AsyncIterable<string> {
    for await (const key of storageKeys(
      this.#storage,
      this.#toInnerKey(prefix),
      this.#toInnerOptions(options),
    )) {
      yield this.#toPublicKey(key);
    }
  }

  async count(prefix: string): Promise<number> {
    return storageCount(this.#storage, this.#toInnerKey(prefix));
  }

  [Symbol.dispose](): void {
    this.#storage[Symbol.dispose]();
  }
}

export function scopedStorage(storage: Storage, prefix: string): ScopedStorage {
  return new ScopedStorage(storage, prefix);
}
