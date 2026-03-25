import { describe, expect, it } from 'bun:test';

import {
  advanceCheckpoint,
  checkpointSizeBytes,
  createCheckpoint,
  deserializeCheckpoint,
  serializeCheckpoint,
  validateCheckpointRoundTrip,
} from './checkpoint.ts';
import type { Checkpoint, Serializer } from './types.ts';

describe('createCheckpoint', () => {
  it('produces step 0, empty locals, empty signals, empty searchAttributes', () => {
    const checkpoint = createCheckpoint('wf-1', '1.0.0');

    expect(checkpoint.step).toBe(0);
    expect(checkpoint.locals).toEqual({});
    expect(checkpoint.pendingSignals).toEqual([]);
    expect(checkpoint.searchAttributes).toEqual({});
  });

  it('produces a valid Checkpoint shape', () => {
    const checkpoint = createCheckpoint('wf-1', '1.0.0');

    expect(checkpoint.workflowId).toBe('wf-1');
    expect(checkpoint.version).toBe('1.0.0');
    expect(typeof checkpoint.step).toBe('number');
    expect(typeof checkpoint.createdAt).toBe('number');
    expect(checkpoint.createdAt).toBeGreaterThan(0);
    expect(typeof checkpoint.locals).toBe('object');
    expect(Array.isArray(checkpoint.pendingSignals)).toBe(true);
    expect(typeof checkpoint.searchAttributes).toBe('object');
  });
});

describe('advanceCheckpoint', () => {
  it('increments step by 1', () => {
    const checkpoint = createCheckpoint('wf-1', '1.0.0');
    const advanced = advanceCheckpoint(checkpoint, { count: 42 });

    expect(advanced.step).toBe(1);
  });

  it('replaces locals with new values', () => {
    const checkpoint = createCheckpoint('wf-1', '1.0.0');
    const first = advanceCheckpoint(checkpoint, { a: 1 });
    const second = advanceCheckpoint(first, { b: 2 });

    expect(second.locals).toEqual({ b: 2 });
    expect(second.locals).not.toHaveProperty('a');
  });

  it('merges search attributes (existing preserved, new added)', () => {
    const checkpoint = createCheckpoint('wf-1', '1.0.0');
    const first = advanceCheckpoint(
      checkpoint,
      {},
      {
        searchAttributes: { region: 'us-east' },
      },
    );
    const second = advanceCheckpoint(
      first,
      {},
      {
        searchAttributes: { priority: 'high' },
      },
    );

    expect(second.searchAttributes).toEqual({
      region: 'us-east',
      priority: 'high',
    });
  });

  it('updates createdAt', () => {
    const checkpoint = createCheckpoint('wf-1', '1.0.0');
    const before = checkpoint.createdAt;
    const advanced = advanceCheckpoint(checkpoint, {});

    expect(advanced.createdAt).toBeGreaterThanOrEqual(before);
  });

  it('preserves workflowId and version', () => {
    const checkpoint = createCheckpoint('wf-42', '2.5.0');
    const advanced = advanceCheckpoint(checkpoint, { x: 'hello' });

    expect(advanced.workflowId).toBe('wf-42');
    expect(advanced.version).toBe('2.5.0');
  });

  it('increments step through multiple advances: 0 -> 1 -> 2 -> 3', () => {
    let checkpoint = createCheckpoint('wf-1', '1.0.0');

    expect(checkpoint.step).toBe(0);

    checkpoint = advanceCheckpoint(checkpoint, { a: 1 });
    expect(checkpoint.step).toBe(1);

    checkpoint = advanceCheckpoint(checkpoint, { b: 2 });
    expect(checkpoint.step).toBe(2);

    checkpoint = advanceCheckpoint(checkpoint, { c: 3 });
    expect(checkpoint.step).toBe(3);
  });
});

describe('serializeCheckpoint / deserializeCheckpoint', () => {
  it('round-trips cleanly for a simple checkpoint', () => {
    const original = createCheckpoint('wf-1', '1.0.0');
    const bytes = serializeCheckpoint(original);
    const restored = deserializeCheckpoint(bytes);

    expect(restored).toEqual(original);
  });

  it('round-trips with Date in locals', () => {
    const now = new Date();
    let checkpoint = createCheckpoint('wf-1', '1.0.0');
    checkpoint = advanceCheckpoint(checkpoint, { startedAt: now });

    const bytes = serializeCheckpoint(checkpoint);
    const restored = deserializeCheckpoint(bytes);

    expect(restored.locals['startedAt']).toBeInstanceOf(Date);
    expect((restored.locals['startedAt'] as Date).getTime()).toBe(now.getTime());
  });

  it('round-trips with Map and Set in locals', () => {
    const map = new Map([
      ['key1', 'value1'],
      ['key2', 'value2'],
    ]);
    const set = new Set([1, 2, 3]);
    let checkpoint = createCheckpoint('wf-1', '1.0.0');
    checkpoint = advanceCheckpoint(checkpoint, { myMap: map, mySet: set });

    const bytes = serializeCheckpoint(checkpoint);
    const restored = deserializeCheckpoint(bytes);

    expect(restored.locals['myMap']).toBeInstanceOf(Map);
    expect(restored.locals['mySet']).toBeInstanceOf(Set);
    expect([...(restored.locals['myMap'] as Map<string, string>).entries()]).toEqual([
      ['key1', 'value1'],
      ['key2', 'value2'],
    ]);
    expect([...(restored.locals['mySet'] as Set<number>).values()]).toEqual([1, 2, 3]);
  });

  it('round-trips with nested objects and arrays', () => {
    let checkpoint = createCheckpoint('wf-1', '1.0.0');
    checkpoint = advanceCheckpoint(checkpoint, {
      nested: { deep: { value: 42 } },
      list: [1, 'two', { three: 3 }],
    });

    const bytes = serializeCheckpoint(checkpoint);
    const restored = deserializeCheckpoint(bytes);

    expect(restored.locals).toEqual(checkpoint.locals);
  });

  it('throws on corrupted bytes', () => {
    const corrupted = new Uint8Array([0xff, 0xfe, 0x00, 0x01, 0x99]);

    expect(() => deserializeCheckpoint(corrupted)).toThrow();
  });

  it('throws on valid bytes but wrong shape (missing step field)', () => {
    const { encode } = require('./codec.ts');
    const invalid = encode({ workflowId: 'wf-1', locals: {} });

    expect(() => deserializeCheckpoint(invalid)).toThrow();
  });
});

describe('validateCheckpointRoundTrip', () => {
  it('returns valid: true for a clean checkpoint', () => {
    const checkpoint = createCheckpoint('wf-1', '1.0.0');
    const result = validateCheckpointRoundTrip(checkpoint);

    expect(result.valid).toBe(true);
    expect(result.divergences).toEqual([]);
    expect(result.sizeBytes).toBeGreaterThan(0);
  });

  it('detects non-cloneable values (function in locals)', () => {
    const checkpoint: Checkpoint = {
      workflowId: 'wf-1',
      step: 1,
      locals: { handler: () => 'not serializable' },
      pendingSignals: [],
      searchAttributes: {},
      version: '1.0.0',
      createdAt: Date.now(),
    };

    const result = validateCheckpointRoundTrip(checkpoint);

    expect(result.valid).toBe(false);
    expect(result.divergences.length).toBeGreaterThan(0);
  });

  it('reports path of divergent field', () => {
    const checkpoint: Checkpoint = {
      workflowId: 'wf-1',
      step: 1,
      locals: { nested: { callback: () => {} } },
      pendingSignals: [],
      searchAttributes: {},
      version: '1.0.0',
      createdAt: Date.now(),
    };

    const result = validateCheckpointRoundTrip(checkpoint);

    expect(result.valid).toBe(false);
    const paths = result.divergences.map((d) => d.path);
    expect(paths.some((p) => p.includes('nested') && p.includes('callback'))).toBe(true);
  });
});

describe('checkpointSizeBytes', () => {
  it('returns a positive number', () => {
    const checkpoint = createCheckpoint('wf-1', '1.0.0');
    const size = checkpointSizeBytes(checkpoint);

    expect(size).toBeGreaterThan(0);
  });

  it('increases with larger locals', () => {
    const small = createCheckpoint('wf-1', '1.0.0');
    const large = advanceCheckpoint(small, {
      data: 'x'.repeat(10_000),
      moreData: Array.from({ length: 100 }, (_, i) => i),
    });

    expect(checkpointSizeBytes(large)).toBeGreaterThan(checkpointSizeBytes(small));
  });
});

describe('custom serializer', () => {
  it('JSON-based serializer works with serialize/deserialize', () => {
    const jsonSerializer: Serializer = {
      serialize(value: unknown): Uint8Array {
        return new TextEncoder().encode(JSON.stringify(value));
      },
      deserialize(bytes: Uint8Array): unknown {
        return JSON.parse(new TextDecoder().decode(bytes));
      },
    };

    const checkpoint = createCheckpoint('wf-1', '1.0.0');
    const bytes = serializeCheckpoint(checkpoint, jsonSerializer);
    const restored = deserializeCheckpoint(bytes, jsonSerializer);

    expect(restored.workflowId).toBe('wf-1');
    expect(restored.step).toBe(0);
    expect(restored.version).toBe('1.0.0');
  });
});
