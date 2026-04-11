import { describe, expect, it } from 'bun:test';
import { z } from 'zod';

import { MemoryStorage } from './memory.ts';
import { jsonCodec, msgpackCodec, withCodec } from './typed-storage.ts';

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = [];
  for await (const value of iterable) {
    values.push(value);
  }
  return values;
}

describe('withCodec', () => {
  it('withCodec(storage, jsonCodec) round-trips structured values without TextEncoder boilerplate', async () => {
    const storage = withCodec(
      new MemoryStorage(),
      jsonCodec(
        z.object({
          name: z.string(),
          count: z.number(),
        }).parse,
      ),
    );

    await storage.put('profile', { name: 'alice', count: 2 });

    expect(await storage.get('profile')).toEqual({ name: 'alice', count: 2 });
  });

  it('withCodec(storage, msgpackCodec) round-trips richer structured-clone values', async () => {
    const storage = withCodec(
      new MemoryStorage(),
      msgpackCodec(
        z.object({
          createdAt: z.date(),
          tags: z.set(z.string()),
        }).parse,
      ),
    );

    const value = {
      createdAt: new Date('2026-01-02T03:04:05.000Z'),
      tags: new Set(['durable', 'workflow']),
    };

    await storage.put('metadata', value);

    const result = await storage.get('metadata');
    expect(result).toEqual(value);
  });

  it('withCodec(storage, codec) forwards batch, scan, keys, count, and deletePrefix through the codec wrapper', async () => {
    const storage = withCodec(
      new MemoryStorage(),
      jsonCodec(
        z.object({
          value: z.string(),
        }).parse,
      ),
    );

    await storage.batch([
      { type: 'put', key: 'items:a', value: { value: 'a' } },
      { type: 'put', key: 'items:b', value: { value: 'b' } },
      { type: 'put', key: 'other:c', value: { value: 'c' } },
    ]);

    expect(await collect(storage.keys('items:'))).toEqual(['items:a', 'items:b']);
    expect(await storage.count('items:')).toBe(2);
    expect(await collect(storage.scan('items:'))).toEqual([
      ['items:a', { value: 'a' }],
      ['items:b', { value: 'b' }],
    ]);
    expect(await storage.deletePrefix('items:')).toBe(2);
    expect(await storage.count('items:')).toBe(0);
  });

  it('jsonCodec requires validation before typed data crosses the storage boundary', async () => {
    const storage = new MemoryStorage();
    await storage.put(
      'profile',
      new TextEncoder().encode(JSON.stringify({ name: 42, count: 'x' })),
    );

    const typedStorage = withCodec(
      storage,
      jsonCodec(
        z.object({
          name: z.string(),
          count: z.number(),
        }).parse,
      ),
    );

    await expect(typedStorage.get('profile')).rejects.toThrow();
  });
});
