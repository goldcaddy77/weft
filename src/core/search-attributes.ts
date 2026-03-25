import type { BatchOperation } from '../storage/interface.ts';
import { KEYS } from '../storage/interface.ts';
import type { SearchAttributeValue } from './types.ts';

const SIGN_BIT = 1n << 63n;
const ALL_BITS = (1n << 64n) - 1n;

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

/** Encode a search attribute value to a sortable string for index keys. */
export function encodeAttributeValue(value: SearchAttributeValue): string {
  if (typeof value === 'string') {
    return `s:${value}`;
  }

  if (typeof value === 'number') {
    return `n:${floatToSortableHex(value)}`;
  }

  if (typeof value === 'boolean') {
    return `b:${value ? '1' : '0'}`;
  }

  if (value instanceof Date) {
    return `d:${value.toISOString()}`;
  }

  // string[] — should not be called directly for keyword lists in index ops,
  // but provided for completeness. Each element is encoded separately.
  throw new Error('Cannot encode a keyword list as a single value; encode elements individually.');
}

/** Decode an encoded attribute value back to its original type. */
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
    case 'datetime':
      return new Date(payload);
    default:
      throw new Error(`Unknown search attribute type: ${type}`);
  }
}

function valuesEqual(a: SearchAttributeValue, b: SearchAttributeValue): boolean {
  if (a instanceof Date && b instanceof Date) {
    return a.getTime() === b.getTime();
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    const sortedA = [...a].toSorted();
    const sortedB = [...b].toSorted();
    return sortedA.every((element, index) => element === sortedB[index]);
  }
  return a === b;
}

const EMPTY_VALUE = new Uint8Array(0);

/** Compute the diff between old and new attributes, returning BatchOperations for index updates. */
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

    // Handle keyword lists (string[]) element-by-element
    if ((hadOld && Array.isArray(oldValue)) || (hasNew && Array.isArray(newValue))) {
      const oldElements = new Set(hadOld ? (oldValue as string[]) : []);
      const newElements = new Set(hasNew ? (newValue as string[]) : []);

      // DELETE removed elements
      for (const element of oldElements) {
        if (!newElements.has(element)) {
          operations.push({
            type: 'delete',
            key: KEYS.attributeIndex(attributeName, encodeAttributeValue(element), workflowId),
          });
        }
      }

      // PUT added elements
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
