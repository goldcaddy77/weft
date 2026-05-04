import { describe, expect, it } from 'bun:test';

import type { BatchOperation } from './interface.ts';
import { WebExtensionStorage } from './web-extension.ts';

function encode(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function decode(value: Uint8Array | null): string | null {
  return value === null ? null : new TextDecoder().decode(value);
}

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const results: T[] = [];
  for await (const value of iterable) {
    results.push(value);
  }
  return results;
}

type FakeStorageAreaOptions = {
  callbackStyle?: boolean;
  quotaBytes?: number;
  quotaBytesPerItem?: number;
};

type WebExtensionTestGlobal = typeof globalThis & {
  browser?: unknown;
  chrome?: unknown;
};

class FakeStorageArea {
  readonly data = new Map<string, unknown>();
  readonly callbackStyle: boolean;
  readonly QUOTA_BYTES?: number;
  readonly QUOTA_BYTES_PER_ITEM?: number;
  setCallCount = 0;
  removeCallCount = 0;

  constructor(options: FakeStorageAreaOptions = {}) {
    this.callbackStyle = options.callbackStyle ?? false;
    if (options.quotaBytes !== undefined) this.QUOTA_BYTES = options.quotaBytes;
    if (options.quotaBytesPerItem !== undefined)
      this.QUOTA_BYTES_PER_ITEM = options.quotaBytesPerItem;
  }

  get(keys?: string | string[] | null, callback?: (items: Record<string, unknown>) => void) {
    const result: Record<string, unknown> = {};
    if (keys === undefined || keys === null) {
      for (const [key, value] of this.data) result[key] = value;
    } else if (typeof keys === 'string') {
      const value = this.data.get(keys);
      if (value !== undefined) result[keys] = value;
    } else {
      for (const key of keys) {
        const value = this.data.get(key);
        if (value !== undefined) result[key] = value;
      }
    }
    return this.#finish(result, callback);
  }

  set(items: Record<string, unknown>, callback?: () => void) {
    this.setCallCount += 1;
    for (const [key, value] of Object.entries(items)) this.data.set(key, value);
    return this.#finish(undefined, callback);
  }

  remove(keys: string | string[], callback?: () => void) {
    this.removeCallCount += 1;
    const normalized = Array.isArray(keys) ? keys : [keys];
    for (const key of normalized) this.data.delete(key);
    return this.#finish(undefined, callback);
  }

  getBytesInUse(keys?: string | string[] | null, callback?: (bytes: number) => void) {
    const selected = new Map<string, unknown>();
    if (keys === undefined || keys === null) {
      for (const [key, value] of this.data) selected.set(key, value);
    } else if (typeof keys === 'string') {
      if (this.data.has(keys)) selected.set(keys, this.data.get(keys));
    } else {
      for (const key of keys) {
        if (this.data.has(key)) selected.set(key, this.data.get(key));
      }
    }
    const bytes = new TextEncoder().encode(JSON.stringify(Object.fromEntries(selected))).byteLength;
    return this.#finish(bytes, callback);
  }

  #finish<T>(value: T, callback?: (value: T) => void): Promise<T> | undefined {
    if (this.callbackStyle) {
      queueMicrotask(() => callback?.(value));
      return undefined;
    }
    return Promise.resolve(value);
  }
}

function installStorageNamespace(
  namespace: 'browser' | 'chrome',
  area: FakeStorageArea,
): () => void {
  const globalObject = globalThis as WebExtensionTestGlobal;
  const previousBrowser = globalObject.browser;
  const previousChrome = globalObject.chrome;
  const storageNamespace = {
    storage: {
      local: area,
      sync: area,
      managed: area,
      onChanged: {
        addListener() {},
        removeListener() {},
      },
    },
  };
  Object.assign(globalObject, {
    browser: undefined,
    chrome: undefined,
    [namespace]: storageNamespace,
  });
  return () => {
    Object.assign(globalObject, { browser: previousBrowser, chrome: previousChrome });
  };
}

describe('WebExtensionStorage', () => {
  it('stores bytes and scans keys through browser.storage', async () => {
    const area = new FakeStorageArea();
    const restore = installStorageNamespace('browser', area);
    try {
      const storage = new WebExtensionStorage();
      await storage.put('wf:one', encode('first'));
      await storage.put('wf:two', encode('second'));
      await storage.put('other', encode('ignored'));
      const entries = await collect(storage.scan('wf:'));

      expect(decode(await storage.get('wf:one'))).toBe('first');
      expect(await collect(storage.keys('wf:'))).toEqual(['wf:one', 'wf:two']);
      expect(entries.map(([key, value]) => [key, decode(value)])).toEqual([
        ['wf:one', 'first'],
        ['wf:two', 'second'],
      ]);
    } finally {
      restore();
    }
  });

  it('supports callback-style chrome.storage APIs', async () => {
    const area = new FakeStorageArea({ callbackStyle: true });
    const restore = installStorageNamespace('chrome', area);
    try {
      const storage = new WebExtensionStorage();
      await storage.put('key', encode('value'));
      expect(decode(await storage.get('key'))).toBe('value');
    } finally {
      restore();
    }
  });

  it('applies a batch through a single storage-area write', async () => {
    const area = new FakeStorageArea();
    const restore = installStorageNamespace('browser', area);
    try {
      const storage = new WebExtensionStorage();
      const operations: BatchOperation[] = [
        { type: 'put', key: 'a', value: encode('one') },
        { type: 'put', key: 'b', value: encode('two') },
        { type: 'delete', key: 'a' },
      ];

      await storage.batch(operations);

      expect(await storage.get('a')).toBeNull();
      expect(decode(await storage.get('b'))).toBe('two');
      expect(await collect(storage.keys(''))).toEqual(['b']);
      expect(area.data.has('a')).toBe(false);
      expect(area.data.size).toBe(1);
      expect(area.setCallCount).toBe(1);
      expect(area.removeCallCount).toBe(0);
    } finally {
      restore();
    }
  });

  it('removes keys from the logical keyspace when deleting a prefix', async () => {
    const area = new FakeStorageArea();
    const restore = installStorageNamespace('browser', area);
    try {
      const storage = new WebExtensionStorage();
      await storage.put('wf:a', encode('a'));
      await storage.put('wf:b', encode('b'));
      await storage.put('other', encode('c'));

      expect(await storage.deletePrefix('wf:')).toBe(2);

      expect(await collect(storage.keys(''))).toEqual(['other']);
      expect(area.data.has('wf:a')).toBe(false);
      expect(area.data.has('wf:b')).toBe(false);
      expect(area.data.size).toBe(1);
    } finally {
      restore();
    }
  });

  it('rejects writes to managed storage', async () => {
    const area = new FakeStorageArea();
    const restore = installStorageNamespace('browser', area);
    try {
      const storage = new WebExtensionStorage({ area: 'managed' });
      await expect(storage.put('key', encode('value'))).rejects.toThrow(
        'WebExtensionStorage area "managed" is read-only.',
      );
    } finally {
      restore();
    }
  });

  it('fails fast when a sync item exceeds quota', async () => {
    const area = new FakeStorageArea({ quotaBytes: 256, quotaBytesPerItem: 64 });
    const restore = installStorageNamespace('browser', area);
    try {
      const storage = new WebExtensionStorage({ area: 'sync' });
      await expect(storage.put('large', encode('x'.repeat(128)))).rejects.toThrow(
        'WebExtensionStorage sync item quota exceeded',
      );
    } finally {
      restore();
    }
  });
});
