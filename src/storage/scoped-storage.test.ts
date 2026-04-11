import { describe, expect, it } from 'bun:test';

import { MemoryStorage } from './memory.ts';
import { scopedStorage } from './scoped-storage.ts';

function encode(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function decode(value: Uint8Array): string {
  return new TextDecoder().decode(value);
}

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = [];
  for await (const value of iterable) {
    values.push(value);
  }
  return values;
}

describe('scopedStorage', () => {
  it('storage.scoped(prefix) prefixes writes and strips prefixes on reads', async () => {
    const storage = new MemoryStorage();
    const scoped = scopedStorage(storage, 'tenant');

    await scoped.put('profile', encode('alice'));

    expect(decode((await storage.get('tenant:profile'))!)).toBe('alice');
    expect(decode((await scoped.get('profile'))!)).toBe('alice');

    const scannedEntries = await collect(scoped.scan(''));
    expect(scannedEntries).toEqual([['profile', encode('alice')]]);
  });

  it("storage.scoped('a').scoped('b') composes under a:b: prefixes", async () => {
    const storage = new MemoryStorage();
    const nested = scopedStorage(storage, 'a').scoped('b');

    await nested.put('key', encode('value'));

    expect(decode((await storage.get('a:b:key'))!)).toBe('value');
    expect(await collect(nested.keys(''))).toEqual(['key']);
  });

  it('storage.scoped(prefix) forwards deletePrefix and count within the namespace only', async () => {
    const storage = new MemoryStorage();
    const scoped = scopedStorage(storage, 'tenant');

    await storage.batch([
      { type: 'put', key: 'tenant:item:1', value: encode('1') },
      { type: 'put', key: 'tenant:item:2', value: encode('2') },
      { type: 'put', key: 'other:item:3', value: encode('3') },
    ]);

    expect(await scoped.count('item:')).toBe(2);
    expect(await scoped.deletePrefix('item:')).toBe(2);
    expect(await storage.get('other:item:3')).toEqual(encode('3'));
    expect(await scoped.count('item:')).toBe(0);
  });
});
