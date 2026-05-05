import type { BatchOperation } from '../storage/interface.ts';
import { KEYS } from '../storage/interface.ts';
import type { SearchAttributeDefinition, SearchAttributeValue } from './types.ts';

export { searchAttribute, searchAttributeName } from './types.ts';

const SIGN_BIT = 1n << 63n;
const ALL_BITS = (1n << 64n) - 1n;

/**
 * Maximum size in bytes for an encoded attribute value. Values exceeding this
 * limit produce storage keys that may blow past backend size constraints.
 */
export const MAX_ENCODED_VALUE_BYTES = 1024;

/**
 * Encode an IEEE 754 float64 to a sortable hex string.
 *
 * The approach:
 * 1. Write the float64 into a DataView and read back its bits as a BigInt.
 * 2. If the sign bit is 0 (positive or +0), flip the sign bit so positives sort after negatives.
 * 3. If the sign bit is 1 (negative or -0), flip ALL bits to reverse the negative ordering.
 * 4. Return a 16-character zero-padded hex string.
 */
function floatToSortableHex(value: number): string {
  const buffer = new ArrayBuffer(8);
  const view = new DataView(buffer);
  view.setFloat64(0, value);
  let bits = view.getBigUint64(0);

  if (bits & SIGN_BIT) {
    // Negative: flip all bits
    bits = bits ^ ALL_BITS;
  } else {
    // Positive: flip only sign bit
    bits = bits ^ SIGN_BIT;
  }

  return bits.toString(16).padStart(16, '0');
}

/**
 * Decode a sortable hex string back to an IEEE 754 float64.
 */
function sortableHexToFloat(hex: string): number {
  let bits = BigInt(`0x${hex}`);

  if (bits & SIGN_BIT) {
    // Was positive: flip sign bit back
    bits = bits ^ SIGN_BIT;
  } else {
    // Was negative: flip all bits back
    bits = bits ^ ALL_BITS;
  }

  const buffer = new ArrayBuffer(8);
  const view = new DataView(buffer);
  view.setBigUint64(0, bits);
  return view.getFloat64(0);
}

/**
 * Encode a search attribute value to a sortable string for index keys.
 *
 * @example
 * ```ts
 * import { encodeAttributeValue } from 'weft';
 *
 * console.log(encodeAttributeValue('acme'));        // 's:acme'
 * console.log(encodeAttributeValue(42));            // 'n:...' (sortable hex)
 * console.log(encodeAttributeValue(true));          // 'b:1'
 * console.log(encodeAttributeValue(new Date('2026-01-01'))); // 'd:2026-01-01T00:00:00.000Z'
 * ```
 */
export function encodeAttributeValue(value: SearchAttributeValue): string {
  let encoded: string;

  if (typeof value === 'string') {
    encoded = `s:${value}`;
  } else if (typeof value === 'number') {
    encoded = `n:${floatToSortableHex(value)}`;
  } else if (typeof value === 'boolean') {
    encoded = `b:${value ? '1' : '0'}`;
  } else if (value instanceof Date) {
    encoded = `d:${value.toISOString()}`;
  } else {
    // string[] — should not be called directly for keyword lists in index ops,
    // but provided for completeness. Each element is encoded separately.
    throw new Error(
      'Cannot encode a keyword list as a single value; encode elements individually.',
    );
  }

  return encoded;
}

/**
 * Validate that an encoded attribute value does not exceed the storage key size limit.
 * Call this in the attribute-setting path, NOT in the general-purpose encoder — the encoder
 * is also used to reconstruct old keys for deletion, and throwing there would prevent
 * cleanup of pre-existing oversized values.
 */
export function validateEncodedValueSize(encoded: string, attributeName: string): void {
  const byteLength = new TextEncoder().encode(encoded).byteLength;
  if (byteLength > MAX_ENCODED_VALUE_BYTES) {
    throw new Error(
      `Encoded search attribute "${attributeName}" exceeds the ${MAX_ENCODED_VALUE_BYTES}-byte limit ` +
        `(got ${byteLength} bytes). Reduce the value size before setting the attribute.`,
    );
  }
}

/**
 * Decode an encoded attribute value back to its original type.
 *
 * @example
 * ```ts
 * import { encodeAttributeValue, decodeAttributeValue } from 'weft';
 *
 * const encoded = encodeAttributeValue('acme');
 * const decoded = decodeAttributeValue(encoded, 'string');
 * console.log(decoded); // 'acme'
 *
 * const num = encodeAttributeValue(42);
 * console.log(decodeAttributeValue(num, 'number')); // 42
 * ```
 */
export function decodeAttributeValue(encoded: string, type: string): SearchAttributeValue {
  const colonIndex = encoded.indexOf(':');
  const payload = encoded.slice(colonIndex + 1);

  switch (type) {
    case 'string':
      return payload;
    case 'number':
      return sortableHexToFloat(payload);
    case 'boolean':
      return payload === '1';
    case 'date-time':
    case 'datetime':
      return new Date(payload);
    default:
      throw new Error(`Unknown search attribute type: ${type}`);
  }
}

/**
 * Validate that a value's runtime type matches the declared schema type.
 * Throws a descriptive error on mismatch.
 */
// oxlint-disable-next-line complexity -- ID:core-search-attributes-validate-attribute-type-complexity
export function validateAttributeType(
  attributeName: string,
  value: SearchAttributeValue,
  definition: SearchAttributeDefinition,
): void {
  const { type: declaredType } = definition;

  switch (declaredType) {
    case 'string':
      if (definition.format === 'date-time') {
        if (!(value instanceof Date)) {
          throw new Error(
            `Search attribute "${attributeName}" is declared as "string" with format "date-time" but received ${typeof value}.`,
          );
        }
        break;
      }
      if (typeof value !== 'string') {
        throw new Error(
          `Search attribute "${attributeName}" is declared as "string" but received ${typeof value}.`,
        );
      }
      break;
    case 'integer':
      if (typeof value !== 'number' || !Number.isInteger(value)) {
        throw new Error(
          `Search attribute "${attributeName}" is declared as "integer" but received ${typeof value}.`,
        );
      }
      break;
    case 'number':
      if (typeof value !== 'number') {
        throw new Error(
          `Search attribute "${attributeName}" is declared as "number" but received ${typeof value}.`,
        );
      }
      break;
    case 'boolean':
      if (typeof value !== 'boolean') {
        throw new Error(
          `Search attribute "${attributeName}" is declared as "boolean" but received ${typeof value}.`,
        );
      }
      break;
    case 'array':
      if (!Array.isArray(value)) {
        throw new Error(
          `Search attribute "${attributeName}" is declared as "array" but received ${typeof value}.`,
        );
      }
      if (!value.every((element) => typeof element === 'string')) {
        throw new Error(
          `Search attribute "${attributeName}" is declared as "array" but array contains non-string elements.`,
        );
      }
      break;
    default: {
      const _exhaustive: never = declaredType;
      throw new Error(`Unknown search attribute type declaration: ${String(_exhaustive)}`);
    }
  }
}

function valuesEqual(a: SearchAttributeValue, b: SearchAttributeValue): boolean {
  if (a instanceof Date && b instanceof Date) {
    return a.getTime() === b.getTime();
  }
  return a === b;
}

const EMPTY_VALUE = new Uint8Array(0);

/**
 * Compute the diff between old and new attributes, returning BatchOperations for index updates.
 *
 * @example
 * ```ts
 * import { buildIndexOperations } from 'weft';
 *
 * const ops = buildIndexOperations(
 *   'wf-123',
 *   { status: 'pending' },
 *   { status: 'completed', customerId: 'acme' },
 * );
 * // ops: delete old 'status' index key, put new 'status' key, put 'customerId' key
 * console.log(ops.length > 0); // true
 * ```
 */
// oxlint-disable-next-line complexity -- ID:core-search-attributes-build-index-operations-complexity
export function buildIndexOperations(
  workflowId: string,
  previous: Record<string, SearchAttributeValue>,
  current: Record<string, SearchAttributeValue>,
): BatchOperation[] {
  const operations: BatchOperation[] = [];
  const allKeys = new Set([...Object.keys(previous), ...Object.keys(current)]);

  for (const attributeName of allKeys) {
    const oldValue = previous[attributeName];
    const newValue = current[attributeName];

    const hadOld = attributeName in previous;
    const hasNew = attributeName in current;

    const oldIsArray = Array.isArray(oldValue);
    const newIsArray = Array.isArray(newValue);

    // Handle string arrays element-by-element, while preserving correct index
    // mutations when a schema-free attribute changes between scalar and array.
    if (oldIsArray || newIsArray) {
      if (oldIsArray && newIsArray) {
        const oldElements = new Set(oldValue);
        const newElements = new Set(newValue);

        for (const element of oldElements) {
          if (!newElements.has(element)) {
            operations.push({
              type: 'delete',
              key: KEYS.attributeIndex(attributeName, encodeAttributeValue(element), workflowId),
            });
          }
        }

        for (const element of newElements) {
          if (!oldElements.has(element)) {
            operations.push({
              type: 'put',
              key: KEYS.attributeIndex(attributeName, encodeAttributeValue(element), workflowId),
              value: EMPTY_VALUE,
            });
          }
        }

        continue;
      }

      if (hadOld) {
        const oldValues = oldIsArray ? oldValue : [oldValue!];
        for (const element of oldValues) {
          operations.push({
            type: 'delete',
            key: KEYS.attributeIndex(attributeName, encodeAttributeValue(element), workflowId),
          });
        }
      }

      if (hasNew) {
        const newValues = newIsArray ? newValue : [newValue!];
        for (const element of newValues) {
          operations.push({
            type: 'put',
            key: KEYS.attributeIndex(attributeName, encodeAttributeValue(element), workflowId),
            value: EMPTY_VALUE,
          });
        }
      }

      continue;
    }

    // Scalar attribute: removed
    if (hadOld && !hasNew) {
      operations.push({
        type: 'delete',
        key: KEYS.attributeIndex(attributeName, encodeAttributeValue(oldValue!), workflowId),
      });
      continue;
    }

    // Scalar attribute: added
    if (!hadOld && hasNew) {
      operations.push({
        type: 'put',
        key: KEYS.attributeIndex(attributeName, encodeAttributeValue(newValue!), workflowId),
        value: EMPTY_VALUE,
      });
      continue;
    }

    // Scalar attribute: changed
    if (hadOld && hasNew && !valuesEqual(oldValue!, newValue!)) {
      operations.push({
        type: 'delete',
        key: KEYS.attributeIndex(attributeName, encodeAttributeValue(oldValue!), workflowId),
      });
      operations.push({
        type: 'put',
        key: KEYS.attributeIndex(attributeName, encodeAttributeValue(newValue!), workflowId),
        value: EMPTY_VALUE,
      });
    }
  }

  return operations;
}
