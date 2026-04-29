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

/**
 * {@link Storage} decorator that transparently prefixes all keys with a
 * namespace, isolating a logical partition of a shared backing store.
 *
 * Reads and writes pass through to the underlying storage with the scope prefix
 * prepended; keys returned by `scan` and `keys` are stripped back to their
 * unprefixed form.  Use {@link scopedStorage} to construct one without `new`.
 *
 * @example
 * ```ts
 * import { MemoryStorage, ScopedStorage } from 'weft';
 *
 * await using raw = new MemoryStorage();
 * const tenantA = new ScopedStorage(raw, 'tenant:a');
 * const tenantB = new ScopedStorage(raw, 'tenant:b');
 *
 * await tenantA.put('setting', new TextEncoder().encode('dark'));
 * await tenantB.put('setting', new TextEncoder().encode('light'));
 *
 * // Keys are isolated — tenantA cannot see tenantB's data
 * console.log(await tenantA.has('setting')); // true
 * console.log(await tenantB.get('setting')); // Uint8Array for 'light'
 * ```
 */
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

/**
 * Factory that creates a {@link ScopedStorage} view of `storage` under the
 * given `prefix`.
 *
 * Prefer this over `new ScopedStorage(...)` for readability at the engine
 * construction site — the return type and behavior are identical.
 *
 * @example
 * ```ts
 * import { Engine, MemoryStorage, scopedStorage } from 'weft';
 *
 * await using raw = new MemoryStorage();
 *
 * // Give each engine its own key namespace in the same backing store
 * await using engine = new Engine({ storage: scopedStorage(raw, 'eng:v1') });
 * engine.register('ping', async function* () { return 'pong'; });
 *
 * const handle = await engine.start('ping', null);
 * console.log(await handle.result()); // 'pong'
 * ```
 */
export function scopedStorage(storage: Storage, prefix: string): ScopedStorage {
  return new ScopedStorage(storage, prefix);
}
