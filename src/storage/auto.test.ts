import { describe, expect, it } from 'bun:test';

import { resolveDefaultStorage } from './auto.ts';

describe('resolveDefaultStorage', () => {
  it('returns BunSQLiteStorage in the Bun runtime', async () => {
    await using storage = await resolveDefaultStorage();
    expect(storage.constructor.name).toBe('BunSQLiteStorage');
  });

  it('throws a clear error when no runtime is detected', async () => {
    await expect(
      resolveDefaultStorage({ hasBun: false, hasNode: false, hasIndexedDB: false }),
    ).rejects.toThrow(/could not auto-detect/);
  });

  it('resolves IndexedDB before Node when both are present (Electron / jsdom)', async () => {
    // We can't easily assert the full success path under Bun (no real
    // IndexedDB), but we can prove the detector picks the IndexedDB
    // branch over the Node branch: if the call rejects, the message
    // mentions IndexedDB rather than NodeSQLiteStorage. If it resolves
    // (some Bun versions load IndexedDBStorage without throwing), the
    // returned constructor name is `IndexedDBStorage`.
    let outcome: { kind: 'resolved'; ctor: string } | { kind: 'rejected'; message: string };
    try {
      const storage = await resolveDefaultStorage({
        hasBun: false,
        hasNode: true,
        hasIndexedDB: true,
      });
      outcome = { kind: 'resolved', ctor: storage.constructor.name };
    } catch (error) {
      outcome = {
        kind: 'rejected',
        message: error instanceof Error ? error.message : String(error),
      };
    }
    if (outcome.kind === 'resolved') {
      expect(outcome.ctor).toBe('IndexedDBStorage');
    } else {
      // Whatever branch failed, it must NOT be the Node-SQLite branch
      // (whose error mentions `NodeSQLiteStorage` or `node-sqlite`).
      expect(outcome.message).not.toMatch(/NodeSQLiteStorage|node-sqlite/);
    }
  });

  it('honors WEFT_DEFAULT_STORAGE_PATH and creates the parent directory', async () => {
    const { mkdtempSync, existsSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');

    const tempDir = mkdtempSync(join(tmpdir(), 'weft-auto-test-'));
    const customPath = join(tempDir, 'nested', 'subdir', 'weft.db');
    const previous = process.env['WEFT_DEFAULT_STORAGE_PATH'];
    process.env['WEFT_DEFAULT_STORAGE_PATH'] = customPath;

    try {
      await using storage = await resolveDefaultStorage();
      expect(storage.constructor.name).toBe('BunSQLiteStorage');
      expect(existsSync(join(tempDir, 'nested', 'subdir'))).toBe(true);
    } finally {
      if (previous === undefined) delete process.env['WEFT_DEFAULT_STORAGE_PATH'];
      else process.env['WEFT_DEFAULT_STORAGE_PATH'] = previous;
    }
  });
});
