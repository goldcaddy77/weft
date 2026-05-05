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
    // The dynamic IndexedDB import will fail in Bun (no global IndexedDB),
    // but reaching that branch (rather than the Node branch) is what we
    // verify — the error message comes from the IndexedDB module load,
    // not from our detection logic.
    await expect(
      resolveDefaultStorage({ hasBun: false, hasNode: true, hasIndexedDB: true }),
    ).rejects.toThrow();
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
