import {
  decode as decodeMessagePack,
  encode as encodeMessagePack,
  validateCloneable,
} from '../core/codec.ts';

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

export type JsonPrimitive = boolean | null | number | string;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type MessagePackPrimitive = bigint | boolean | null | number | string | undefined;
export type MessagePackValue =
  | ArrayBuffer
  | Date
  | Error
  | Map<MessagePackValue, MessagePackValue>
  | MessagePackPrimitive
  | MessagePackValue[]
  | RegExp
  | Set<MessagePackValue>
  | Uint8Array
  | { [key: string]: MessagePackValue };

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

function encodeJsonValue(value: JsonValue): Uint8Array {
  try {
    const serializedValue = JSON.stringify(value);
    if (serializedValue === undefined) {
      throw new TypeError('jsonCodec only supports JSON-serializable values.');
    }

    return new TextEncoder().encode(serializedValue);
  } catch (error) {
    throw new TypeError('jsonCodec only supports JSON-serializable values.', {
      cause: error,
    });
  }
}

function encodeMessagePackValue(value: MessagePackValue): Uint8Array {
  const validationResult = validateCloneable(value);
  if (!validationResult.valid) {
    throw new TypeError(
      `msgpackCodec only supports structuredClone-compatible values. ${validationResult.errors[0]?.reason ?? ''}`.trim(),
    );
  }

  return encodeMessagePack(value);
}

function decodeJsonValue(bytes: Uint8Array): JsonValue {
  const decodedValue = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  // JSON.parse only produces JSON-compatible primitives, arrays, and plain objects.
  return decodedValue as JsonValue;
}

function decodeMessagePackValue(bytes: Uint8Array): MessagePackValue {
  const decodedValue = decodeMessagePack(bytes);
  const validationResult = validateCloneable(decodedValue);
  if (!validationResult.valid) {
    throw new TypeError(
      `msgpackCodec decoded a non-cloneable value. ${validationResult.errors[0]?.reason ?? ''}`.trim(),
    );
  }

  return decodedValue as MessagePackValue;
}

export function jsonCodec(): StorageCodec<JsonValue>;
export function jsonCodec<Value extends JsonValue>(
  parse: StorageValueParser<Value>,
): StorageCodec<Value>;
export function jsonCodec<Value extends JsonValue>(
  parse?: StorageValueParser<Value>,
): StorageCodec<JsonValue> | StorageCodec<Value> {
  return {
    encode(value: JsonValue): Uint8Array {
      return encodeJsonValue(value);
    },
    decode(bytes: Uint8Array): JsonValue | Value {
      const decodedValue = decodeJsonValue(bytes);
      return parse ? parse(decodedValue) : decodedValue;
    },
  };
}

export function msgpackCodec(): StorageCodec<MessagePackValue>;
export function msgpackCodec<Value extends MessagePackValue>(
  parse: StorageValueParser<Value>,
): StorageCodec<Value>;
export function msgpackCodec<Value extends MessagePackValue>(
  parse?: StorageValueParser<Value>,
): StorageCodec<MessagePackValue> | StorageCodec<Value> {
  return {
    encode(value: MessagePackValue): Uint8Array {
      return encodeMessagePackValue(value);
    },
    decode(bytes: Uint8Array): MessagePackValue | Value {
      const decodedValue = decodeMessagePackValue(bytes);
      return parse ? parse(decodedValue) : decodedValue;
    },
  };
}
