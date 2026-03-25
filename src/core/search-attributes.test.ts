import { describe, expect, it } from 'bun:test';

import type { BatchOperation } from '../storage/interface.ts';
import {
  buildIndexOperations,
  decodeAttributeValue,
  encodeAttributeValue,
} from './search-attributes.ts';

describe('search-attributes', () => {
  describe('encodeAttributeValue', () => {
    it('encodes a string with the s: prefix', () => {
      expect(encodeAttributeValue('hello')).toBe('s:hello');
    });

    it('encodes numbers so that 42 sorts after 41', () => {
      const encoded41 = encodeAttributeValue(41);
      const encoded42 = encodeAttributeValue(42);
      expect(encoded42 > encoded41).toBe(true);
    });

    it('encodes negative numbers so they sort correctly (-1 < 0 < 1)', () => {
      const encodedNeg1 = encodeAttributeValue(-1);
      const encoded0 = encodeAttributeValue(0);
      const encoded1 = encodeAttributeValue(1);
      expect(encodedNeg1 < encoded0).toBe(true);
      expect(encoded0 < encoded1).toBe(true);
    });

    it('encodes fractional numbers so they sort correctly (0.1 < 0.2 < 1.0)', () => {
      const encoded01 = encodeAttributeValue(0.1);
      const encoded02 = encodeAttributeValue(0.2);
      const encoded10 = encodeAttributeValue(1.0);
      expect(encoded01 < encoded02).toBe(true);
      expect(encoded02 < encoded10).toBe(true);
    });

    it('encodes extreme values so -Infinity < -1 < 0 < 1 < Infinity', () => {
      const values = [-Infinity, -1, 0, 1, Infinity];
      const encoded = values.map((v) => encodeAttributeValue(v));
      for (let i = 0; i < encoded.length - 1; i++) {
        expect(encoded[i]! < encoded[i + 1]!).toBe(true);
      }
    });

    it('encodes booleans so that false < true', () => {
      const encodedFalse = encodeAttributeValue(false);
      const encodedTrue = encodeAttributeValue(true);
      expect(encodedFalse).toBe('b:0');
      expect(encodedTrue).toBe('b:1');
      expect(encodedFalse < encodedTrue).toBe(true);
    });

    it('encodes dates so earlier dates sort before later dates', () => {
      const earlier = new Date('2024-01-01T00:00:00.000Z');
      const later = new Date('2024-06-15T12:00:00.000Z');
      const encodedEarlier = encodeAttributeValue(earlier);
      const encodedLater = encodeAttributeValue(later);
      expect(encodedEarlier < encodedLater).toBe(true);
    });

    it('encodes a Date value with d: prefix and ISO format', () => {
      const date = new Date('2024-06-15T12:00:00.000Z');
      const encoded = encodeAttributeValue(date);
      expect(encoded).toBe('d:2024-06-15T12:00:00.000Z');
    });

    it('throws when encoding a keyword list (string array) directly', () => {
      expect(() => encodeAttributeValue(['a', 'b'] as any)).toThrow('Cannot encode a keyword list');
    });
  });

  describe('decodeAttributeValue (round-trip)', () => {
    it('round-trips a string value', () => {
      const original = 'hello world';
      const encoded = encodeAttributeValue(original);
      expect(decodeAttributeValue(encoded, 'string')).toBe(original);
    });

    it('round-trips a number value', () => {
      const original = 42.5;
      const encoded = encodeAttributeValue(original);
      expect(decodeAttributeValue(encoded, 'number')).toBe(original);
    });

    it('round-trips a boolean value', () => {
      const encoded = encodeAttributeValue(true);
      expect(decodeAttributeValue(encoded, 'boolean')).toBe(true);

      const encodedFalse = encodeAttributeValue(false);
      expect(decodeAttributeValue(encodedFalse, 'boolean')).toBe(false);
    });

    it('round-trips a date value', () => {
      const original = new Date('2024-03-15T10:30:00.000Z');
      const encoded = encodeAttributeValue(original);
      const decoded = decodeAttributeValue(encoded, 'datetime');
      expect(decoded).toBeInstanceOf(Date);
      expect((decoded as Date).toISOString()).toBe(original.toISOString());
    });

    it('round-trips a negative number value', () => {
      const original = -7.5;
      const encoded = encodeAttributeValue(original);
      expect(decodeAttributeValue(encoded, 'number')).toBe(original);
    });

    it('throws for an unknown attribute type', () => {
      expect(() => decodeAttributeValue('x:something', 'unknown-type')).toThrow(
        'Unknown search attribute type: unknown-type',
      );
    });
  });

  describe('buildIndexOperations', () => {
    it('produces a PUT for a new attribute', () => {
      const operations = buildIndexOperations('wf-1', {}, { customerId: 'abc' });
      expect(operations).toEqual([
        { type: 'put', key: 'idx:customerId:s:abc:wf-1', value: new Uint8Array(0) },
      ]);
    });

    it('produces a DELETE and PUT when a value changes', () => {
      const operations = buildIndexOperations('wf-1', { price: 10 }, { price: 20 });
      expect(operations).toHaveLength(2);
      const deleteOperation = operations.find(
        (operation): operation is Extract<BatchOperation, { type: 'delete' }> =>
          operation.type === 'delete',
      );
      const putOperation = operations.find(
        (operation): operation is Extract<BatchOperation, { type: 'put' }> =>
          operation.type === 'put',
      );
      expect(deleteOperation).toBeDefined();
      expect(putOperation).toBeDefined();
      expect(deleteOperation!.key).toContain('idx:price:');
      expect(deleteOperation!.key).toContain(':wf-1');
      expect(putOperation!.key).toContain('idx:price:');
      expect(putOperation!.key).toContain(':wf-1');
      expect(deleteOperation!.key).not.toBe(putOperation!.key);
    });

    it('produces a DELETE when an attribute is removed', () => {
      const operations = buildIndexOperations('wf-1', { x: 1 }, {});
      expect(operations).toHaveLength(1);
      expect(operations[0]!.type).toBe('delete');
      expect((operations[0] as Extract<BatchOperation, { type: 'delete' }>).key).toContain(
        'idx:x:',
      );
    });

    it('produces two PUTs for a new keyword list', () => {
      const operations = buildIndexOperations('wf-1', {}, { tags: ['a', 'b'] });
      expect(operations).toHaveLength(2);
      expect(operations.every((operation) => operation.type === 'put')).toBe(true);
      const keys = operations.map(
        (operation) => (operation as Extract<BatchOperation, { type: 'put' }>).key,
      );
      expect(keys).toContain('idx:tags:s:a:wf-1');
      expect(keys).toContain('idx:tags:s:b:wf-1');
    });

    it('computes keyword list diff: DELETE removed elements, PUT added elements', () => {
      const operations = buildIndexOperations('wf-1', { tags: ['a', 'b'] }, { tags: ['b', 'c'] });
      expect(operations).toHaveLength(2);
      const deleteOperation = operations.find(
        (operation): operation is Extract<BatchOperation, { type: 'delete' }> =>
          operation.type === 'delete',
      );
      const putOperation = operations.find(
        (operation): operation is Extract<BatchOperation, { type: 'put' }> =>
          operation.type === 'put',
      );
      expect(deleteOperation).toBeDefined();
      expect(deleteOperation!.key).toBe('idx:tags:s:a:wf-1');
      expect(putOperation).toBeDefined();
      expect(putOperation!.key).toBe('idx:tags:s:c:wf-1');
    });

    it('produces no operations when both previous and current are empty', () => {
      const operations = buildIndexOperations('wf-1', {}, {});
      expect(operations).toHaveLength(0);
    });

    it('produces no operations when values are unchanged', () => {
      const operations = buildIndexOperations(
        'wf-1',
        { customerId: 'abc', price: 10, active: true },
        { customerId: 'abc', price: 10, active: true },
      );
      expect(operations).toHaveLength(0);
    });

    it('produces no operations when Date values are equal', () => {
      const date = new Date('2024-01-01T00:00:00.000Z');
      const sameDateDifferentInstance = new Date('2024-01-01T00:00:00.000Z');
      const operations = buildIndexOperations(
        'wf-1',
        { createdAt: date },
        { createdAt: sameDateDifferentInstance },
      );
      expect(operations).toHaveLength(0);
    });

    it('produces DELETE and PUT when Date values differ', () => {
      const oldDate = new Date('2024-01-01T00:00:00.000Z');
      const newDate = new Date('2024-06-01T00:00:00.000Z');
      const operations = buildIndexOperations(
        'wf-1',
        { createdAt: oldDate },
        { createdAt: newDate },
      );
      expect(operations).toHaveLength(2);
      expect(operations[0]!.type).toBe('delete');
      expect(operations[1]!.type).toBe('put');
    });

    it('produces no operations when keyword list values are equal (same elements)', () => {
      const operations = buildIndexOperations('wf-1', { tags: ['a', 'b'] }, { tags: ['b', 'a'] });
      // Elements are the same (just reordered), so no additions or deletions
      expect(operations).toHaveLength(0);
    });

    it('produces DELETE for all elements when keyword list is removed', () => {
      const operations = buildIndexOperations('wf-1', { tags: ['a', 'b'] }, {});
      expect(operations).toHaveLength(2);
      expect(operations.every((operation) => operation.type === 'delete')).toBe(true);
    });
  });
});
