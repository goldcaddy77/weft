import 'fake-indexeddb/auto';

import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Engine } from '../core/engine.ts';
import type { WorkflowStatus } from '../core/types.ts';
import { BunSQLiteStorage } from '../storage/bun-sql.ts';
import { IndexedDBStorage } from '../storage/indexeddb.ts';
import {
  storageHas as storageHasFallback,
  storageKeys,
  type Storage,
} from '../storage/interface.ts';
import { LMDBStorage } from '../storage/lmdb.ts';
import { MemoryStorage } from '../storage/memory.ts';
import { TursoStorage } from '../storage/turso.ts';
import { sleepForTesting, yieldToEventLoop } from './fake-timers.ts';

/**
 * A factory function that creates a fresh storage instance and returns
 * both the storage and a cleanup callback. The cleanup function disposes
 * of the storage and removes any temporary files (for disk-backed backends).
 */
export type StorageFactory = () => {
  storage: Storage;
  cleanup: () => void | Promise<void>;
};

/** Descriptor for a storage backend used in parametrized tests. */
export type StorageBackendDescriptor = {
  name: string;
  factory: StorageFactory;
};

/**
 * All storage backends available for parametrized integration tests.
 *
 * Each entry provides a human-readable name and a factory that creates
 * a fresh, isolated storage instance. When new backends are added to the
 * codebase, add an entry here and every parametrized test suite will
 * automatically cover them.
 */
export const storageBackends: StorageBackendDescriptor[] = [
  {
    name: 'MemoryStorage',
    factory: () => {
      const storage = new MemoryStorage();
      return {
        storage,
        cleanup: () => storage[Symbol.dispose](),
      };
    },
  },
  {
    name: 'BunSQLiteStorage',
    factory: () => {
      const storage = new BunSQLiteStorage(':memory:');
      return {
        storage,
        cleanup: () => storage[Symbol.dispose](),
      };
    },
  },
  {
    name: 'LMDBStorage',
    factory: () => {
      const path = join(tmpdir(), `lmdb-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
      const storage = new LMDBStorage(path);
      return {
        storage,
        cleanup: async () => {
          await storage.close();
          if (existsSync(path)) {
            rmSync(path, { recursive: true, force: true });
          }
        },
      };
    },
  },
  {
    name: 'TursoStorage',
    factory: () => {
      const storage = new TursoStorage({ url: 'file::memory:' });
      return {
        storage,
        cleanup: () => storage[Symbol.dispose](),
      };
    },
  },
  {
    name: 'IndexedDBStorage',
    factory: () => {
      const databaseName = `weft-test-${crypto.randomUUID()}`;
      const storage = new IndexedDBStorage(databaseName);
      return {
        storage,
        cleanup: () => {
          storage[Symbol.dispose]();
          // Delete the database to keep fake-indexeddb state isolated across tests.
          try {
            indexedDB.deleteDatabase(databaseName);
          } catch {
            // Best-effort cleanup; ignore errors.
          }
        },
      };
    },
  },
];

/**
 * Collect all keys matching a prefix from a `Storage` instance.
 * Works with any backend (unlike MemoryStorage-specific `.keys()`).
 */
export async function collectKeys(storage: Storage, prefix: string): Promise<string[]> {
  const keys: string[] = [];
  for await (const key of storageKeys(storage, prefix)) {
    keys.push(key);
  }
  return keys;
}

/**
 * Check whether a key exists in storage using only the `Storage` interface.
 * Works with any backend (unlike MemoryStorage-specific `.has()`).
 */
export async function storageHas(storage: Storage, key: string): Promise<boolean> {
  return storageHasFallback(storage, key);
}

/** Drain microtasks so fire-and-forget work completes. */
export async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await yieldToEventLoop();
  }
}

export async function waitForWorkflowStatus(
  engine: Engine,
  workflowId: string,
  status: WorkflowStatus,
  timeoutMs = 500,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const state = await engine.get(workflowId);
    if (state?.status === status) {
      return;
    }

    await sleepForTesting(1);
  }

  throw new Error(`Expected workflow "${workflowId}" to reach status "${status}"`);
}

/**
 * Dispose engine first, flush to let async work drain, then clean up storage.
 * This ordering prevents "client closed" errors from backends like Turso
 * where async operations may still reference storage after engine disposal.
 */
export async function teardown(
  engine?: Engine,
  storageCleanup?: () => void | Promise<void>,
): Promise<void> {
  engine?.[Symbol.dispose]();
  await flush();
  // LMDB-backed tests can still have a read transaction unwinding on the next
  // turn after engine disposal under heavy suite load. Give backend cleanup one
  // more event-loop turn so storage disposal does not race that shutdown path.
  await flush();
  await storageCleanup?.();
}
