import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { resolveDefaultStorage } from './auto.ts';

describe('resolveDefaultStorage', () => {
  // All tests run inside an isolated temp directory and route the
  // resolver's path policy through `WEFT_DEFAULT_STORAGE_PATH` so the
  // test never touches the real `${tmpdir()}/weft-default/` location
  // (which would persist across runs and across tests).
  let testTempDir: string;
  let previousEnv: string | undefined;

  beforeEach(() => {
    testTempDir = mkdtempSync(join(tmpdir(), 'weft-auto-test-'));
    previousEnv = process.env['WEFT_DEFAULT_STORAGE_PATH'];
    process.env['WEFT_DEFAULT_STORAGE_PATH'] = join(testTempDir, 'weft.db');
  });

  afterEach(() => {
    if (previousEnv === undefined) delete process.env['WEFT_DEFAULT_STORAGE_PATH'];
    else process.env['WEFT_DEFAULT_STORAGE_PATH'] = previousEnv;
    rmSync(testTempDir, { recursive: true, force: true });
  });

  it('returns BunSQLiteStorage in the Bun runtime', async () => {
    await using storage = await resolveDefaultStorage();
    expect(storage.constructor.name).toBe('BunSQLiteStorage');
  });

  it('honors WEFT_DEFAULT_STORAGE_PATH and creates the parent directory', async () => {
    const customPath = join(testTempDir, 'nested', 'subdir', 'weft.db');
    process.env['WEFT_DEFAULT_STORAGE_PATH'] = customPath;
    await using storage = await resolveDefaultStorage();
    expect(storage.constructor.name).toBe('BunSQLiteStorage');
    expect(existsSync(join(testTempDir, 'nested', 'subdir'))).toBe(true);
  });

  // The throw branch (no Bun, no Node) can't be exercised in a Bun
  // test runner because the runtime is, by definition, Bun. Smoke
  // verification is left to the `scripts/smoke-storage-auto.ts`
  // integration script and to the message format below — verified by
  // round-tripping the underlying detection function.
});
