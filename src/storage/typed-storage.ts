import { decode as decodeMessagePack, encode as encodeMessagePack } from '../core/codec.ts';

import {
  storageCount,
  storageDeletePrefix,
  storageHas,
  storageKeys,
  type BatchOperation,
  type ScanOptions,
  type Storage,
} from './interface.ts';

export interface StorageCodec<Value> {
  encode(value: Value): Uint8Array;
  decode(bytes: Uint8Array): Value;
}

export type StorageValueParser<Value> = (value: unknown) => Value;

export type TypedBatchOperation<Value> =
  | { type: 'put'; key: string; value: Value }
  | { type: 'delete'; key: string };

export interface TypedStorage<Value> extends Disposable {
  get(key: string): Promise<Value | null>;
  put(key: string, value: Value): Promise<void>;
  delete(key: string): Promise<void>;
  scan(prefix: string, options?: ScanOptions): AsyncIterable<[string, Value]>;
  batch(operations: TypedBatchOperation<Value>[]): Promise<void>;
  has(key: string): Promise<boolean>;
  deletePrefix(prefix: string): Promise<number>;
  keys(prefix: string, options?: ScanOptions): AsyncIterable<string>;
  count(prefix: string): Promise<number>;
}

class CodecStorage<Value> implements TypedStorage<Value> {
  #storage: Storage;
  #codec: StorageCodec<Value>;

  constructor(storage: Storage, codec: StorageCodec<Value>) {
    this.#storage = storage;
    this.#codec = codec;
  }

  async get(key: string): Promise<Value | null> {
    const value = await this.#storage.get(key);
    return value === null ? null : this.#codec.decode(value);
  }

  async put(key: string, value: Value): Promise<void> {
    await this.#storage.put(key, this.#codec.encode(value));
  }

  async delete(key: string): Promise<void> {
    await this.#storage.delete(key);
  }

  async *scan(prefix: string, options?: ScanOptions): AsyncIterable<[string, Value]> {
    for await (const [key, value] of this.#storage.scan(prefix, options)) {
      yield [key, this.#codec.decode(value)];
    }
  }

  async batch(operations: TypedBatchOperation<Value>[]): Promise<void> {
    const encodedOperations: BatchOperation[] = operations.map((operation) => {
      if (operation.type === 'put') {
        return {
          type: 'put',
          key: operation.key,
          value: this.#codec.encode(operation.value),
        };
      }

      return operation;
    });

    await this.#storage.batch(encodedOperations);
  }

  async has(key: string): Promise<boolean> {
    return storageHas(this.#storage, key);
  }

  async deletePrefix(prefix: string): Promise<number> {
    return storageDeletePrefix(this.#storage, prefix);
  }

  keys(prefix: string, options?: ScanOptions): AsyncIterable<string> {
    return storageKeys(this.#storage, prefix, options);
  }

  async count(prefix: string): Promise<number> {
    return storageCount(this.#storage, prefix);
  }

  [Symbol.dispose](): void {
    this.#storage[Symbol.dispose]();
  }
}

export function withCodec<Value>(
  storage: Storage,
  codec: StorageCodec<Value>,
): TypedStorage<Value> {
  return new CodecStorage(storage, codec);
}

export function jsonCodec(): StorageCodec<unknown>;
export function jsonCodec<Value>(parse: StorageValueParser<Value>): StorageCodec<Value>;
export function jsonCodec<Value>(
  parse?: StorageValueParser<Value>,
): StorageCodec<unknown> | StorageCodec<Value> {
  return {
    encode(value: unknown): Uint8Array {
      return new TextEncoder().encode(JSON.stringify(value));
    },
    decode(bytes: Uint8Array): unknown {
      const decodedValue = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
      return parse ? parse(decodedValue) : decodedValue;
    },
  };
}

export function msgpackCodec(): StorageCodec<unknown>;
export function msgpackCodec<Value>(parse: StorageValueParser<Value>): StorageCodec<Value>;
export function msgpackCodec<Value>(
  parse?: StorageValueParser<Value>,
): StorageCodec<unknown> | StorageCodec<Value> {
  return {
    encode(value: unknown): Uint8Array {
      return encodeMessagePack(value);
    },
    decode(bytes: Uint8Array): unknown {
      const decodedValue = decodeMessagePack(bytes);
      return parse ? parse(decodedValue) : decodedValue;
    },
  };
}
