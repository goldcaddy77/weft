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
    expect(checkpoint.accumulatedResults).toEqual([]);
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
      accumulatedResults: [],
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
      accumulatedResults: [],
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

describe('validateCheckpointShape (via deserializeCheckpoint)', () => {
  it('throws when decoded value is not an object', () => {
    const { encode } = require('./codec.ts');
    const bytes = encode('not-an-object');
    expect(() => deserializeCheckpoint(bytes)).toThrow('expected an object');
  });

  it('throws when decoded value is null', () => {
    const { encode } = require('./codec.ts');
    const bytes = encode(null);
    expect(() => deserializeCheckpoint(bytes)).toThrow('expected an object');
  });

  it('throws when workflowId is missing', () => {
    const { encode } = require('./codec.ts');
    const bytes = encode({
      step: 0,
      locals: {},
      accumulatedResults: [],
      pendingSignals: [],
      searchAttributes: {},
      version: '1.0.0',
      createdAt: Date.now(),
    });
    expect(() => deserializeCheckpoint(bytes)).toThrow('workflowId');
  });

  it('throws when step is missing', () => {
    const { encode } = require('./codec.ts');
    const bytes = encode({
      workflowId: 'wf-1',
      locals: {},
      accumulatedResults: [],
      pendingSignals: [],
      searchAttributes: {},
      version: '1.0.0',
      createdAt: Date.now(),
    });
    expect(() => deserializeCheckpoint(bytes)).toThrow('step');
  });

  it('throws when locals is missing or null', () => {
    const { encode } = require('./codec.ts');
    const bytes = encode({
      workflowId: 'wf-1',
      step: 0,
      locals: null,
      accumulatedResults: [],
      pendingSignals: [],
      searchAttributes: {},
      version: '1.0.0',
      createdAt: Date.now(),
    });
    expect(() => deserializeCheckpoint(bytes)).toThrow('locals');
  });

  it('throws when pendingSignals is not an array', () => {
    const { encode } = require('./codec.ts');
    const bytes = encode({
      workflowId: 'wf-1',
      step: 0,
      locals: {},
      pendingSignals: 'not-an-array',
      searchAttributes: {},
      version: '1.0.0',
      createdAt: Date.now(),
    });
    expect(() => deserializeCheckpoint(bytes)).toThrow('pendingSignals');
  });

  it('throws when accumulatedResults is not an array', () => {
    const { encode } = require('./codec.ts');
    const bytes = encode({
      workflowId: 'wf-1',
      step: 0,
      locals: {},
      accumulatedResults: 'not-an-array',
      pendingSignals: [],
      searchAttributes: {},
      version: '1.0.0',
      createdAt: Date.now(),
    });
    expect(() => deserializeCheckpoint(bytes)).toThrow('accumulatedResults');
  });

  it('throws when searchAttributes is missing or null', () => {
    const { encode } = require('./codec.ts');
    const bytes = encode({
      workflowId: 'wf-1',
      step: 0,
      locals: {},
      accumulatedResults: [],
      pendingSignals: [],
      searchAttributes: null,
      version: '1.0.0',
      createdAt: Date.now(),
    });
    expect(() => deserializeCheckpoint(bytes)).toThrow('searchAttributes');
  });

  it('throws when version is missing', () => {
    const { encode } = require('./codec.ts');
    const bytes = encode({
      workflowId: 'wf-1',
      step: 0,
      locals: {},
      accumulatedResults: [],
      pendingSignals: [],
      searchAttributes: {},
      createdAt: Date.now(),
    });
    expect(() => deserializeCheckpoint(bytes)).toThrow('version');
  });

  it('throws when createdAt is missing', () => {
    const { encode } = require('./codec.ts');
    const bytes = encode({
      workflowId: 'wf-1',
      step: 0,
      locals: {},
      accumulatedResults: [],
      pendingSignals: [],
      searchAttributes: {},
      version: '1.0.0',
    });
    expect(() => deserializeCheckpoint(bytes)).toThrow('createdAt');
  });
});

describe('compareValues (via validateCheckpointRoundTrip with custom serializer)', () => {
  // Helper: a serializer that intentionally alters data to trigger divergence paths
  function createAlteringSerializer(alteration: (checkpoint: any) => any): Serializer {
    return {
      serialize(value: unknown): Uint8Array {
        return new TextEncoder().encode(JSON.stringify(value));
      },
      deserialize(bytes: Uint8Array): unknown {
        const parsed = JSON.parse(new TextDecoder().decode(bytes));
        return alteration(parsed);
      },
    };
  }

  it('detects null vs non-null divergence', () => {
    const serializer = createAlteringSerializer((checkpoint: any) => {
      checkpoint.locals.value = null;
      return checkpoint;
    });

    const checkpoint: Checkpoint = {
      workflowId: 'wf-1',
      step: 1,
      locals: { value: 'hello' },
      accumulatedResults: [],
      pendingSignals: [],
      searchAttributes: {},
      version: '1.0.0',
      createdAt: Date.now(),
    };

    const result = validateCheckpointRoundTrip(checkpoint, serializer);
    expect(result.valid).toBe(false);
    expect(result.divergences.some((d) => d.path.includes('value'))).toBe(true);
  });

  it('detects type mismatch (string vs number)', () => {
    const serializer = createAlteringSerializer((checkpoint: any) => {
      checkpoint.locals.count = 'not-a-number';
      return checkpoint;
    });

    const checkpoint: Checkpoint = {
      workflowId: 'wf-1',
      step: 1,
      locals: { count: 42 },
      accumulatedResults: [],
      pendingSignals: [],
      searchAttributes: {},
      version: '1.0.0',
      createdAt: Date.now(),
    };

    const result = validateCheckpointRoundTrip(checkpoint, serializer);
    expect(result.valid).toBe(false);
    const divergence = result.divergences.find((d) => d.path.includes('count'));
    expect(divergence).toBeDefined();
    expect(divergence!.suggestion).toContain('Type changed');
  });

  it('detects primitive value change', () => {
    const serializer = createAlteringSerializer((checkpoint: any) => {
      checkpoint.locals.name = 'altered';
      return checkpoint;
    });

    const checkpoint: Checkpoint = {
      workflowId: 'wf-1',
      step: 1,
      locals: { name: 'original' },
      accumulatedResults: [],
      pendingSignals: [],
      searchAttributes: {},
      version: '1.0.0',
      createdAt: Date.now(),
    };

    const result = validateCheckpointRoundTrip(checkpoint, serializer);
    expect(result.valid).toBe(false);
    expect(result.divergences.some((d) => d.suggestion.includes('Primitive value changed'))).toBe(
      true,
    );
  });

  it('detects missing key in deserialized result', () => {
    const serializer = createAlteringSerializer((checkpoint: any) => {
      delete checkpoint.locals.important;
      return checkpoint;
    });

    const checkpoint: Checkpoint = {
      workflowId: 'wf-1',
      step: 1,
      locals: { important: 'data', other: 'stuff' },
      accumulatedResults: [],
      pendingSignals: [],
      searchAttributes: {},
      version: '1.0.0',
      createdAt: Date.now(),
    };

    const result = validateCheckpointRoundTrip(checkpoint, serializer);
    expect(result.valid).toBe(false);
    expect(
      result.divergences.some((d) => d.suggestion.includes('Key missing from deserialized')),
    ).toBe(true);
  });

  it('detects extra key in deserialized result', () => {
    const serializer = createAlteringSerializer((checkpoint: any) => {
      checkpoint.locals.extraKey = 'unexpected';
      return checkpoint;
    });

    const checkpoint: Checkpoint = {
      workflowId: 'wf-1',
      step: 1,
      locals: { existing: 'data' },
      accumulatedResults: [],
      pendingSignals: [],
      searchAttributes: {},
      version: '1.0.0',
      createdAt: Date.now(),
    };

    const result = validateCheckpointRoundTrip(checkpoint, serializer);
    expect(result.valid).toBe(false);
    expect(result.divergences.some((d) => d.suggestion.includes('Extra key appeared'))).toBe(true);
  });

  it('detects array length differences (extra elements after round-trip)', () => {
    const serializer = createAlteringSerializer((checkpoint: any) => {
      checkpoint.locals.items.push('extra');
      return checkpoint;
    });

    const checkpoint: Checkpoint = {
      workflowId: 'wf-1',
      step: 1,
      locals: { items: ['a', 'b'] },
      accumulatedResults: [],
      pendingSignals: [],
      searchAttributes: {},
      version: '1.0.0',
      createdAt: Date.now(),
    };

    const result = validateCheckpointRoundTrip(checkpoint, serializer);
    expect(result.valid).toBe(false);
    expect(result.divergences.some((d) => d.suggestion.includes('Extra array element'))).toBe(true);
  });

  it('detects array length differences (missing elements after round-trip)', () => {
    const serializer = createAlteringSerializer((checkpoint: any) => {
      checkpoint.locals.items.pop();
      return checkpoint;
    });

    const checkpoint: Checkpoint = {
      workflowId: 'wf-1',
      step: 1,
      locals: { items: ['a', 'b', 'c'] },
      accumulatedResults: [],
      pendingSignals: [],
      searchAttributes: {},
      version: '1.0.0',
      createdAt: Date.now(),
    };

    const result = validateCheckpointRoundTrip(checkpoint, serializer);
    expect(result.valid).toBe(false);
    expect(result.divergences.some((d) => d.suggestion.includes('Array element missing'))).toBe(
      true,
    );
  });

  it('detects nested object divergence', () => {
    const serializer = createAlteringSerializer((checkpoint: any) => {
      checkpoint.locals.nested.deep.value = 99;
      return checkpoint;
    });

    const checkpoint: Checkpoint = {
      workflowId: 'wf-1',
      step: 1,
      locals: { nested: { deep: { value: 42 } } },
      accumulatedResults: [],
      pendingSignals: [],
      searchAttributes: {},
      version: '1.0.0',
      createdAt: Date.now(),
    };

    const result = validateCheckpointRoundTrip(checkpoint, serializer);
    expect(result.valid).toBe(false);
    expect(
      result.divergences.some((d) => d.path.includes('nested') && d.path.includes('deep')),
    ).toBe(true);
  });

  it('detects Date divergence in round-trip', () => {
    const checkpoint: Checkpoint = {
      workflowId: 'wf-1',
      step: 1,
      locals: { timestamp: new Date('2025-01-15T10:30:00Z') },
      accumulatedResults: [],
      pendingSignals: [],
      searchAttributes: {},
      version: '1.0.0',
      createdAt: Date.now(),
    };

    // Default codec preserves Dates, so this should pass cleanly
    const result = validateCheckpointRoundTrip(checkpoint);
    expect(result.valid).toBe(true);
  });

  it('detects Date time change via custom serializer', () => {
    const { encode: codecEncode, decode: codecDecode } = require('./codec.ts');

    const serializer: Serializer = {
      serialize(value: unknown): Uint8Array {
        return codecEncode(value);
      },
      deserialize(bytes: Uint8Array): unknown {
        const decoded = codecDecode(bytes);
        // Shift the Date by 1 second to cause divergence
        if (decoded.locals?.timestamp instanceof Date) {
          decoded.locals.timestamp = new Date(decoded.locals.timestamp.getTime() + 1000);
        }
        return decoded;
      },
    };

    const checkpoint: Checkpoint = {
      workflowId: 'wf-1',
      step: 1,
      locals: { timestamp: new Date('2025-01-15T10:30:00Z') },
      accumulatedResults: [],
      pendingSignals: [],
      searchAttributes: {},
      version: '1.0.0',
      createdAt: Date.now(),
    };

    const result = validateCheckpointRoundTrip(checkpoint, serializer);
    expect(result.valid).toBe(false);
    expect(result.divergences.some((d) => d.suggestion.includes('Date value changed'))).toBe(true);
  });

  it('detects RegExp divergence via custom serializer', () => {
    const { encode: codecEncode, decode: codecDecode } = require('./codec.ts');

    const serializer: Serializer = {
      serialize(value: unknown): Uint8Array {
        return codecEncode(value);
      },
      deserialize(bytes: Uint8Array): unknown {
        const decoded = codecDecode(bytes);
        // Alter the RegExp flags to cause divergence
        if (decoded.locals?.pattern instanceof RegExp) {
          decoded.locals.pattern = new RegExp(decoded.locals.pattern.source, 'gi');
        }
        return decoded;
      },
    };

    const checkpoint: Checkpoint = {
      workflowId: 'wf-1',
      step: 1,
      locals: { pattern: new RegExp('test', 'g') },
      accumulatedResults: [],
      pendingSignals: [],
      searchAttributes: {},
      version: '1.0.0',
      createdAt: Date.now(),
    };

    const result = validateCheckpointRoundTrip(checkpoint, serializer);
    expect(result.valid).toBe(false);
    expect(result.divergences.some((d) => d.suggestion.includes('RegExp value changed'))).toBe(
      true,
    );
  });

  it('detects Map key missing after round-trip', () => {
    const { encode: codecEncode, decode: codecDecode } = require('./codec.ts');

    const serializer: Serializer = {
      serialize(value: unknown): Uint8Array {
        return codecEncode(value);
      },
      deserialize(bytes: Uint8Array): unknown {
        const decoded = codecDecode(bytes);
        // Remove a key from the Map
        if (decoded.locals?.myMap instanceof Map) {
          decoded.locals.myMap.delete('alpha');
        }
        return decoded;
      },
    };

    const checkpoint: Checkpoint = {
      workflowId: 'wf-1',
      step: 1,
      locals: {
        myMap: new Map([
          ['alpha', 1],
          ['beta', 2],
        ]),
      },
      accumulatedResults: [],
      pendingSignals: [],
      searchAttributes: {},
      version: '1.0.0',
      createdAt: Date.now(),
    };

    const result = validateCheckpointRoundTrip(checkpoint, serializer);
    expect(result.valid).toBe(false);
    expect(result.divergences.some((d) => d.suggestion.includes('Map key missing'))).toBe(true);
  });

  it('detects extra Map key after round-trip', () => {
    const { encode: codecEncode, decode: codecDecode } = require('./codec.ts');

    const serializer: Serializer = {
      serialize(value: unknown): Uint8Array {
        return codecEncode(value);
      },
      deserialize(bytes: Uint8Array): unknown {
        const decoded = codecDecode(bytes);
        if (decoded.locals?.myMap instanceof Map) {
          decoded.locals.myMap.set('extra', 999);
        }
        return decoded;
      },
    };

    const checkpoint: Checkpoint = {
      workflowId: 'wf-1',
      step: 1,
      locals: {
        myMap: new Map([['alpha', 1]]),
      },
      accumulatedResults: [],
      pendingSignals: [],
      searchAttributes: {},
      version: '1.0.0',
      createdAt: Date.now(),
    };

    const result = validateCheckpointRoundTrip(checkpoint, serializer);
    expect(result.valid).toBe(false);
    expect(result.divergences.some((d) => d.suggestion.includes('Extra Map key'))).toBe(true);
  });

  it('detects Set size change after round-trip', () => {
    const { encode: codecEncode, decode: codecDecode } = require('./codec.ts');

    const serializer: Serializer = {
      serialize(value: unknown): Uint8Array {
        return codecEncode(value);
      },
      deserialize(bytes: Uint8Array): unknown {
        const decoded = codecDecode(bytes);
        if (decoded.locals?.mySet instanceof Set) {
          decoded.locals.mySet.add('extra');
        }
        return decoded;
      },
    };

    const checkpoint: Checkpoint = {
      workflowId: 'wf-1',
      step: 1,
      locals: {
        mySet: new Set([1, 2, 3]),
      },
      accumulatedResults: [],
      pendingSignals: [],
      searchAttributes: {},
      version: '1.0.0',
      createdAt: Date.now(),
    };

    const result = validateCheckpointRoundTrip(checkpoint, serializer);
    expect(result.valid).toBe(false);
    expect(result.divergences.some((d) => d.suggestion.includes('Set size changed'))).toBe(true);
  });

  it('compares Set elements when same size', () => {
    const { encode: codecEncode, decode: codecDecode } = require('./codec.ts');

    const serializer: Serializer = {
      serialize(value: unknown): Uint8Array {
        return codecEncode(value);
      },
      deserialize(bytes: Uint8Array): unknown {
        const decoded = codecDecode(bytes);
        if (decoded.locals?.mySet instanceof Set) {
          // Replace the set with one of the same size but different last element
          decoded.locals.mySet = new Set(['a', 'b', 'altered']);
        }
        return decoded;
      },
    };

    const checkpoint: Checkpoint = {
      workflowId: 'wf-1',
      step: 1,
      locals: {
        mySet: new Set(['a', 'b', 'c']),
      },
      accumulatedResults: [],
      pendingSignals: [],
      searchAttributes: {},
      version: '1.0.0',
      createdAt: Date.now(),
    };

    const result = validateCheckpointRoundTrip(checkpoint, serializer);
    expect(result.valid).toBe(false);
    expect(result.divergences.some((d) => d.path.includes('Set'))).toBe(true);
  });

  it('compares Map values recursively', () => {
    const { encode: codecEncode, decode: codecDecode } = require('./codec.ts');

    const serializer: Serializer = {
      serialize(value: unknown): Uint8Array {
        return codecEncode(value);
      },
      deserialize(bytes: Uint8Array): unknown {
        const decoded = codecDecode(bytes);
        if (decoded.locals?.myMap instanceof Map) {
          decoded.locals.myMap.set('key1', 'altered');
        }
        return decoded;
      },
    };

    const checkpoint: Checkpoint = {
      workflowId: 'wf-1',
      step: 1,
      locals: {
        myMap: new Map([['key1', 'original']]),
      },
      accumulatedResults: [],
      pendingSignals: [],
      searchAttributes: {},
      version: '1.0.0',
      createdAt: Date.now(),
    };

    const result = validateCheckpointRoundTrip(checkpoint, serializer);
    expect(result.valid).toBe(false);
    expect(result.divergences.some((d) => d.path.includes('Map(key1)'))).toBe(true);
  });

  it('detects undefined vs non-undefined divergence', () => {
    const serializer = createAlteringSerializer((checkpoint: any) => {
      // Set a field to undefined where it was previously a value
      checkpoint.locals.field = undefined;
      return checkpoint;
    });

    const checkpoint: Checkpoint = {
      workflowId: 'wf-1',
      step: 1,
      locals: { field: 'present' },
      accumulatedResults: [],
      pendingSignals: [],
      searchAttributes: {},
      version: '1.0.0',
      createdAt: Date.now(),
    };

    const result = validateCheckpointRoundTrip(checkpoint, serializer);
    expect(result.valid).toBe(false);
  });

  it('handles array comparison with recursive elements', () => {
    const serializer = createAlteringSerializer((checkpoint: any) => {
      checkpoint.locals.items[1].nested = 'changed';
      return checkpoint;
    });

    const checkpoint: Checkpoint = {
      workflowId: 'wf-1',
      step: 1,
      locals: {
        items: [{ nested: 'original' }, { nested: 'original' }],
      },
      accumulatedResults: [],
      pendingSignals: [],
      searchAttributes: {},
      version: '1.0.0',
      createdAt: Date.now(),
    };

    const result = validateCheckpointRoundTrip(checkpoint, serializer);
    expect(result.valid).toBe(false);
  });
});
