import { afterEach, describe, expect, it } from 'bun:test';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Engine } from '../core/engine.ts';
import { workflow } from '../core/types/workflow-function.ts';
import { BunSQLiteStorage } from '../storage/bun-sql.ts';
import { parseCliArguments } from './parse-arguments.ts';
import {
  executeVisibility,
  VISIBILITY_NOT_CURRENT_EXIT_CODE,
  type VisibilityCommandOptions,
} from './visibility.ts';

const databases: string[] = [];

function temporaryDatabase(name: string): string {
  const database = join(tmpdir(), `weft-visibility-${name}-${Date.now()}-${Math.random()}.db`);
  databases.push(database);
  return database;
}

afterEach(() => {
  while (databases.length > 0) {
    const database = databases.pop();
    if (!database) continue;
    for (const suffix of ['', '-wal', '-shm']) rmSync(`${database}${suffix}`, { force: true });
  }
});

const cliWorkflow = workflow({ name: 'cli-visibility' }).execute(async function* (
  _ctx,
  input: string,
) {
  return input;
});

function command(overrides: Partial<VisibilityCommandOptions>): VisibilityCommandOptions {
  return {
    action: 'verify',
    database: ':memory:',
    storage: 'sqlite',
    batchSize: 500,
    deep: false,
    json: false,
    verbose: false,
    ...overrides,
  };
}

/** Seed a SQLite file with workflows whose visibility index has been dropped. */
async function seedUnindexedDatabase(database: string): Promise<void> {
  const storage = new BunSQLiteStorage(database);
  const engine = new Engine({ storage });
  try {
    engine.register(cliWorkflow);
    const handles = await Promise.all([
      engine.start('cli-visibility', 'a', { id: 'cli-1' }),
      engine.start('cli-visibility', 'b', { id: 'cli-2' }),
    ]);
    for (const handle of handles) await handle.result();
    await engine.dropWorkflowVisibilityIndex();
  } finally {
    engine[Symbol.dispose]();
    storage[Symbol.dispose]();
  }
}

describe('weft visibility', () => {
  it('parses each action and rejects an unknown one', () => {
    expect(parseCliArguments(['visibility', 'backfill'])).toMatchObject({
      command: 'visibility',
      action: 'backfill',
      storage: 'sqlite',
      batchSize: 500,
    });
    expect(parseCliArguments(['visibility', 'verify', '--deep'])).toMatchObject({
      action: 'verify',
      deep: true,
    });
    expect(parseCliArguments(['visibility', 'drop', '--batch-size', '25'])).toMatchObject({
      action: 'drop',
      batchSize: 25,
    });

    expect(() => parseCliArguments(['visibility', 'rebuild'])).toThrow(
      'expected a subcommand: backfill, verify, or drop',
    );
    expect(() => parseCliArguments(['visibility', 'backfill', '--batch-size', '0'])).toThrow(
      '--batch-size must be a positive integer',
    );
    // An in-memory backend would report a vacuously complete backfill.
    expect(() => parseCliArguments(['visibility', 'backfill', '--storage', 'memory'])).toThrow(
      'memory',
    );
  });

  it('reports a stale index, fixes it, and reports it current', async () => {
    const database = temporaryDatabase('roundtrip');
    await seedUnindexedDatabase(database);

    const before = await executeVisibility(command({ action: 'verify', database }));
    expect(before.exitCode).toBe(VISIBILITY_NOT_CURRENT_EXIT_CODE);
    expect(before.stdout).toContain('Watermark: stale');

    const backfill = await executeVisibility(command({ action: 'backfill', database }));
    expect(backfill.exitCode).toBe(0);
    expect(backfill.stdout).toContain('Watermark advanced');

    const after = await executeVisibility(command({ action: 'verify', database, deep: true }));
    expect(after.exitCode).toBe(0);
    expect(after.stdout).toContain('Index is current and complete.');

    const dropped = await executeVisibility(command({ action: 'drop', database }));
    expect(dropped.exitCode).toBe(0);
    expect(dropped.stdout).toContain('full-scan path');

    const afterDrop = await executeVisibility(command({ action: 'verify', database }));
    expect(afterDrop.exitCode).toBe(VISIBILITY_NOT_CURRENT_EXIT_CODE);
  });

  it('emits the machine-readable report under --json', async () => {
    const database = temporaryDatabase('json');
    await seedUnindexedDatabase(database);

    const result = await executeVisibility(command({ action: 'verify', database, json: true }));
    const payload = JSON.parse(result.stdout) as {
      action: string;
      report: { scanned: number; complete: boolean; watermarkOverstated: boolean };
    };
    expect(payload.action).toBe('verify');
    expect(payload.report.scanned).toBe(2);
    expect(payload.report.complete).toBe(false);
    // A stale watermark over an incomplete index is safe: it scans.
    expect(payload.report.watermarkOverstated).toBe(false);
  });
});
