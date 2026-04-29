/**
 * MessagePack codec with structuredClone semantics.
 *
 * Wraps `@msgpack/msgpack` with custom extension types to handle
 * all types that `structuredClone` supports.
 *
 * @module codec
 */

import { ExtensionCodec, decode as msgpackDecode, encode as msgpackEncode } from '@msgpack/msgpack';

import {
  coerceCodecArray,
  coerceCodecRecord,
  decodeCodecDate,
  encodeCodecDate,
} from './codec-helpers.ts';

// ---------------------------------------------------------------------------
// Extension type identifiers
// ---------------------------------------------------------------------------

const EXTENSION_TYPE_DATE = 1;
const EXTENSION_TYPE_REGEXP = 2;
const EXTENSION_TYPE_MAP = 3;
const EXTENSION_TYPE_SET = 4;
const EXTENSION_TYPE_UNDEFINED = 5;
const EXTENSION_TYPE_ERROR = 6;

// ---------------------------------------------------------------------------
// Helpers for safe type narrowing from msgpack decode results
// ---------------------------------------------------------------------------

const extensionCodec = new ExtensionCodec();

// Date (ext type 1): float64 milliseconds since epoch
extensionCodec.register({
  type: EXTENSION_TYPE_DATE,
  encode: encodeCodecDate,
  decode: decodeCodecDate,
});

// RegExp (ext type 2): encoded as { source, flags } object
extensionCodec.register({
  type: EXTENSION_TYPE_REGEXP,
  encode(value: unknown): Uint8Array | null {
    if (value instanceof RegExp) {
      return msgpackEncode({ source: value.source, flags: value.flags });
    }
    return null;
  },
  decode(data: Uint8Array): RegExp {
    const decoded = coerceCodecRecord(msgpackDecode(data));
    const source = typeof decoded['source'] === 'string' ? decoded['source'] : '';
    const flags = typeof decoded['flags'] === 'string' ? decoded['flags'] : '';
    return new RegExp(source, flags);
  },
});

// Map (ext type 3): encoded as array of [key, value] pairs
extensionCodec.register({
  type: EXTENSION_TYPE_MAP,
  encode(value: unknown): Uint8Array | null {
    if (value instanceof Map) {
      const entries = [...value.entries()];
      return msgpackEncode(entries, { extensionCodec });
    }
    return null;
  },
  decode(data: Uint8Array): Map<unknown, unknown> {
    const decoded = coerceCodecArray(msgpackDecode(data, { extensionCodec }));
    const entries = decoded.map((entry) => {
      const pair = coerceCodecArray(entry);
      return [pair[0], pair[1]] as const;
    });
    return new Map(entries);
  },
});

// Set (ext type 4): encoded as array of values
extensionCodec.register({
  type: EXTENSION_TYPE_SET,
  encode(value: unknown): Uint8Array | null {
    if (value instanceof Set) {
      const elements = [...value.values()];
      return msgpackEncode(elements, { extensionCodec });
    }
    return null;
  },
  decode(data: Uint8Array): Set<unknown> {
    const elements = coerceCodecArray(msgpackDecode(data, { extensionCodec }));
    return new Set(elements);
  },
});

// undefined (ext type 5): encoded as empty buffer.
// Note: msgpack treats undefined the same as null (via `== null` check) before
// the extension codec can intercept it. We use a sentinel object that the
// extension codec *can* see, then replace undefined with the sentinel before
// encoding and restore it after decoding.

/**
 * Sentinel object used to represent `undefined` so the extension codec can
 * detect it. We use a unique symbol tag for identification.
 */
const UNDEFINED_SENTINEL_TAG = Symbol('UndefinedSentinel');

interface UndefinedSentinel {
  readonly __tag: typeof UNDEFINED_SENTINEL_TAG;
}

const undefinedSentinel: UndefinedSentinel = Object.freeze({
  __tag: UNDEFINED_SENTINEL_TAG,
});

function isUndefinedSentinel(value: unknown): value is UndefinedSentinel {
  return (
    typeof value === 'object' &&
    value !== null &&
    '__tag' in value &&
    // After the `in` check, we know __tag exists; use indexed access
    (value as Record<string, unknown>)['__tag'] === UNDEFINED_SENTINEL_TAG
  );
}

extensionCodec.register({
  type: EXTENSION_TYPE_UNDEFINED,
  encode(value: unknown): Uint8Array | null {
    if (isUndefinedSentinel(value)) {
      return new Uint8Array(0);
    }
    return null;
  },
  decode(): undefined {
    return undefined;
  },
});

// Error (ext type 6): encoded as { name, message, stack } object
extensionCodec.register({
  type: EXTENSION_TYPE_ERROR,
  encode(value: unknown): Uint8Array | null {
    if (value instanceof Error) {
      return msgpackEncode({
        name: value.name,
        message: value.message,
        stack: value.stack,
      });
    }
    return null;
  },
  decode(data: Uint8Array): Error {
    const decoded = coerceCodecRecord(msgpackDecode(data));
    const name = typeof decoded['name'] === 'string' ? decoded['name'] : 'Error';
    const message = typeof decoded['message'] === 'string' ? decoded['message'] : '';
    const stack = typeof decoded['stack'] === 'string' ? decoded['stack'] : undefined;
    const error = new Error(message);
    error.name = name;
    if (stack !== undefined) {
      error.stack = stack;
    }
    return error;
  },
});

// ---------------------------------------------------------------------------
// Undefined preprocessing
// ---------------------------------------------------------------------------

/**
 * Recursively replace `undefined` with the sentinel so msgpack's encoder
 * routes it through the extension codec instead of encoding it as null.
 */
function replaceUndefined(value: unknown, visited: Set<object>): unknown {
  if (value === undefined) return undefinedSentinel;
  if (value === null || typeof value !== 'object') return value;

  if (visited.has(value)) return value;
  visited.add(value);

  if (Array.isArray(value)) {
    const result: unknown[] = Array.from({ length: value.length });
    for (let i = 0; i < value.length; i++) {
      result[i] = replaceUndefined(value[i], visited);
    }
    visited.delete(value);
    return result;
  }

  if (value instanceof Map) {
    const result = new Map<unknown, unknown>();
    for (const [key, mapValue] of value) {
      result.set(replaceUndefined(key, visited), replaceUndefined(mapValue, visited));
    }
    visited.delete(value);
    return result;
  }

  if (value instanceof Set) {
    const result = new Set<unknown>();
    for (const setValue of value) {
      result.add(replaceUndefined(setValue, visited));
    }
    visited.delete(value);
    return result;
  }

  // Skip types that don't contain nested values
  if (
    value instanceof Date ||
    value instanceof RegExp ||
    value instanceof Error ||
    value instanceof Uint8Array ||
    value instanceof ArrayBuffer
  ) {
    visited.delete(value);
    return value;
  }

  // Plain objects
  const record = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(record)) {
    result[key] = replaceUndefined(record[key], visited);
  }
  visited.delete(value);
  return result;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Encode a value to MessagePack bytes with structuredClone semantics.
 *
 * @example
 * ```ts
 * import { encode, decode } from 'weft';
 *
 * const data = { name: 'Alice', createdAt: new Date(), tags: new Set(['admin']) };
 * const bytes = encode(data);
 * console.log(bytes instanceof Uint8Array); // true
 *
 * const restored = decode(bytes) as typeof data;
 * console.log(restored.name);          // 'Alice'
 * console.log(restored.tags instanceof Set); // true
 * ```
 */
export function encode(value: unknown): Uint8Array {
  const preprocessed = replaceUndefined(value, new Set());
  return msgpackEncode(preprocessed, { extensionCodec });
}

/**
 * Decode MessagePack bytes back to a value.
 *
 * @example
 * ```ts
 * import { encode, decode } from 'weft';
 *
 * const original = { id: 42, labels: new Map([['env', 'prod']]) };
 * const bytes = encode(original);
 * const result = decode(bytes) as typeof original;
 * console.log(result.id);                      // 42
 * console.log(result.labels.get('env'));        // 'prod'
 * ```
 */
export function decode(bytes: Uint8Array): unknown {
  return msgpackDecode(bytes, { extensionCodec });
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export interface CloneValidationError {
  path: string;
  value: unknown;
  reason: string;
  suggestion: string;
}

export interface CloneValidationResult {
  valid: boolean;
  errors: CloneValidationError[];
}

/**
 * Validate that a value is cloneable (structuredClone compatible).
 * Returns errors for non-cloneable values. Reports ALL errors, not just the first.
 *
 * @example
 * ```ts
 * import { validateCloneable } from 'weft';
 *
 * const safe = validateCloneable({ name: 'Alice', scores: [1, 2, 3] });
 * console.log(safe.valid);   // true
 * console.log(safe.errors);  // []
 *
 * const unsafe = validateCloneable({ fn: () => 42 });
 * console.log(unsafe.valid);           // false
 * console.log(unsafe.errors[0]?.path); // 'fn'
 * ```
 */
export function validateCloneable(value: unknown, path = ''): CloneValidationResult {
  const errors: CloneValidationError[] = [];
  const visited = new Set<object>();
  walkValue(value, path, errors, visited);
  return { valid: errors.length === 0, errors };
}

/**
 * Check whether an object is a class instance with methods on its prototype
 * (beyond what plain Object provides).
 */
function isClassInstanceWithMethods(value: object): boolean {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const prototype: unknown = Object.getPrototypeOf(value);

  // Plain objects have Object.prototype (or null) as their prototype
  if (prototype === Object.prototype || prototype === null) {
    return false;
  }

  // Skip known supported types and arrays
  if (
    Array.isArray(value) ||
    value instanceof Date ||
    value instanceof RegExp ||
    value instanceof Map ||
    value instanceof Set ||
    value instanceof Error ||
    value instanceof Uint8Array ||
    value instanceof ArrayBuffer
  ) {
    return false;
  }

  // Check if the prototype has any methods (own properties that are functions)
  if (typeof prototype !== 'object' || prototype === null) return false;
  const propertyNames = Object.getOwnPropertyNames(prototype);
  return propertyNames.some((name) => {
    if (name === 'constructor') return false;
    const descriptor = Object.getOwnPropertyDescriptor(prototype, name);
    return descriptor !== undefined && typeof descriptor.value === 'function';
  });
}

type CloneValidationFailure = Omit<CloneValidationError, 'path' | 'value'>;

function pushCloneValidationError(
  errors: CloneValidationError[],
  path: string,
  value: unknown,
  failure: CloneValidationFailure,
): void {
  errors.push({
    path,
    value,
    reason: failure.reason,
    suggestion: failure.suggestion,
  });
}

function getPrimitiveCloneValidationFailure(value: unknown): CloneValidationFailure | null {
  if (typeof value === 'function') {
    return {
      reason: 'Functions cannot be serialized.',
      suggestion: 'Move this into ctx.run() or reconstruct it on resume.',
    };
  }

  if (typeof value === 'symbol') {
    return {
      reason: 'Symbols cannot be serialized.',
      suggestion: 'Use a string identifier instead of a Symbol.',
    };
  }

  return null;
}

function getObjectCloneValidationFailure(
  value: object,
  visited: Set<object>,
): CloneValidationFailure | null {
  if (value instanceof WeakRef) {
    return {
      reason: 'WeakRef cannot be serialized.',
      suggestion: 'Store the referenced value directly instead of using a WeakRef.',
    };
  }

  if (value instanceof WeakMap) {
    return {
      reason: 'WeakMap cannot be serialized.',
      suggestion: 'Use a Map instead of a WeakMap.',
    };
  }

  if (value instanceof WeakSet) {
    return {
      reason: 'WeakSet cannot be serialized.',
      suggestion: 'Use a Set instead of a WeakSet.',
    };
  }

  if (visited.has(value)) {
    return {
      reason: 'Circular reference detected.',
      suggestion: 'Remove the circular reference or restructure the data.',
    };
  }

  if (isClassInstanceWithMethods(value)) {
    return {
      reason: 'Class instances with methods cannot be serialized.',
      suggestion: 'Store only the data and reconstruct the instance.',
    };
  }

  return null;
}

function isSerializableLeafValue(value: object): boolean {
  return (
    value instanceof Date ||
    value instanceof RegExp ||
    value instanceof Error ||
    value instanceof Uint8Array ||
    value instanceof ArrayBuffer
  );
}

function walkMapValues(
  value: Map<unknown, unknown>,
  path: string,
  errors: CloneValidationError[],
  visited: Set<object>,
): void {
  for (const [key, mapValue] of value) {
    const keyString = String(key);
    walkValue(mapValue, path ? `${path}.${keyString}` : keyString, errors, visited);
  }
}

function walkSetValues(
  value: Set<unknown>,
  path: string,
  errors: CloneValidationError[],
  visited: Set<object>,
): void {
  let index = 0;
  for (const setValue of value) {
    const elementPath = path ? `${path}[${index}]` : `[${index}]`;
    walkValue(setValue, elementPath, errors, visited);
    index++;
  }
}

function walkArrayValues(
  value: unknown[],
  path: string,
  errors: CloneValidationError[],
  visited: Set<object>,
): void {
  for (let index = 0; index < value.length; index++) {
    const elementPath = path ? `${path}[${index}]` : `[${index}]`;
    walkValue(value[index], elementPath, errors, visited);
  }
}

function walkRecordValues(
  value: Record<string, unknown>,
  path: string,
  errors: CloneValidationError[],
  visited: Set<object>,
): void {
  for (const key of Object.keys(value)) {
    const propertyPath = path ? `${path}.${key}` : key;
    walkValue(value[key], propertyPath, errors, visited);
  }
}

function walkValue(
  value: unknown,
  path: string,
  errors: CloneValidationError[],
  visited: Set<object>,
): void {
  // Primitives are always fine
  if (value === null || value === undefined) return;

  const primitiveFailure = getPrimitiveCloneValidationFailure(value);
  if (primitiveFailure) {
    pushCloneValidationError(errors, path, value, primitiveFailure);
    return;
  }

  // Only objects need further inspection
  if (typeof value !== 'object') return;

  const objectFailure = getObjectCloneValidationFailure(value, visited);
  if (objectFailure) {
    pushCloneValidationError(errors, path, value, objectFailure);
    return;
  }

  visited.add(value);
  try {
    if (isSerializableLeafValue(value)) {
      return;
    }

    if (value instanceof Map) {
      walkMapValues(value, path, errors, visited);
      return;
    }

    if (value instanceof Set) {
      walkSetValues(value, path, errors, visited);
      return;
    }

    if (Array.isArray(value)) {
      walkArrayValues(value, path, errors, visited);
      return;
    }

    walkRecordValues(value as Record<string, unknown>, path, errors, visited);
  } finally {
    visited.delete(value);
  }
}
