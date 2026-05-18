/**
 * Mid-transaction SIGKILL tests.
 *
 * Two complementary tests per adapter:
 *
 *   - 3a (adapter-batch kill window): subprocess opens the real adapter,
 *     starts a long `batch()`, parent SIGKILLs after observing readiness.
 *     The kill may land before, during, or after the SQL transaction. The
 *     claim is intentionally narrow: at most the pre-batch state survives,
 *     and the batch never silently committed before the kill.
 *
 *   - 3b (deterministic in-transaction kill, Bun/Node only): subprocess
 *     opens the real adapter to create file/schema/pragmas, disposes,
 *     reopens via a raw `bun:sqlite` / `better-sqlite3` handle with
 *     mirrored pragmas, runs `BEGIN IMMEDIATE` + an INSERT, then prints
 *     `WEFT_DURABILITY_IN_TRANSACTION`. The parent SIGKILLs only after
 *     observing that marker — the kill is guaranteed mid-transaction.
 *     After reopen via the adapter, the in-transaction row is absent.
 *
 * Cleanup invariant: every spawn is wrapped in try/finally. In finally:
 * if the child has not exited, send SIGKILL and race `process.exited`
 * against a 2s timeout. Timeout throws so a leaked subprocess never
 * deadlocks the runner.
 */

import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import {
  availableAdapterSpecs,
  availableBunNodeAdapterSpecs,
  FixtureScope,
  type AdapterSpec,
} from './adapter-spec.ts';

function realSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

const sqliteModuleUrl = import.meta.resolve('../bun-sql.ts');
const nodeSqliteModuleUrl = import.meta.resolve('../node-sqlite.ts');
const tursoModuleUrl = import.meta.resolve('../turso.ts');

type RunningChild = ReturnType<typeof Bun.spawn>;

async function killAndWait(child: RunningChild): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGKILL');
  const winner = await Promise.race([
    child.exited.then(() => 'exited' as const),
    realSleep(2000).then(() => 'timeout' as const),
  ]);
  if (winner === 'timeout') {
    throw new Error('Subprocess did not exit within 2s after SIGKILL — leak guard fired');
  }
}

async function readUntil(
  stream: ReadableStream<Uint8Array>,
  marker: string,
  deadlineMs: number,
): Promise<string> {
  const decoder = new TextDecoder();
  const reader = stream.getReader();
  let buffer = '';
  const deadline = Date.now() + deadlineMs;
  try {
    while (Date.now() < deadline) {
      const remaining = deadline - Date.now();
      const result = await Promise.race([
        reader.read(),
        realSleep(remaining).then(() => ({ value: undefined, done: true })),
      ]);
      if (result.done) break;
      if (result.value) {
        buffer += decoder.decode(result.value, { stream: true });
        if (buffer.includes(marker)) return buffer;
      }
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // best-effort
    }
  }
  throw new Error(`Timed out waiting for marker ${JSON.stringify(marker)}. Got:\n${buffer}`);
}

function importLineFor(spec: AdapterSpec): string {
  switch (spec.name) {
    case 'BunSQLiteStorage':
      return `import { BunSQLiteStorage as Adapter } from ${JSON.stringify(sqliteModuleUrl)};\nfunction openAdapter(path) { return new Adapter(path); }`;
    case 'NodeSQLiteStorage':
      return `import { NodeSQLiteStorage as Adapter } from ${JSON.stringify(nodeSqliteModuleUrl)};\nfunction openAdapter(path) { return new Adapter(path); }`;
    case 'TursoStorage':
      return `import { TursoStorage as Adapter } from ${JSON.stringify(tursoModuleUrl)};\nfunction openAdapter(path) { return new Adapter({ url: 'file:' + path }); }`;
  }
}

function adapterBatchEntrypointSource(spec: AdapterSpec): string {
  return `
${importLineFor(spec)}

const databasePath = process.argv[2];
const storage = openAdapter(databasePath);
await storage.batch([{ type: 'put', key: 'before:ok', value: new Uint8Array([1]) }]);
process.stdout.write('WEFT_DURABILITY_READY\\n');
const big = [];
for (let index = 0; index < 50000; index++) {
  big.push({
    type: 'put',
    key: 'mid:' + index.toString().padStart(8, '0'),
    value: new Uint8Array([index & 0xff]),
  });
}
await storage.batch(big);
process.stdout.write('WEFT_DURABILITY_UNREACHABLE\\n');
`;
}

function rawInTransactionEntrypointSource(spec: AdapterSpec): string {
  if (spec.name === 'BunSQLiteStorage') {
    return `
${importLineFor(spec)}
import { Database } from 'bun:sqlite';

const databasePath = process.argv[2];
const storage = openAdapter(databasePath);
await storage.batch([{ type: 'put', key: 'before:ok', value: new Uint8Array([1]) }]);
storage[Symbol.dispose]();

const database = new Database(databasePath);
database.exec('PRAGMA journal_mode = WAL');
database.exec('PRAGMA synchronous = NORMAL');
database.exec('BEGIN IMMEDIATE');
const insert = database.prepare('INSERT INTO kv (key, value) VALUES (?, ?)');
insert.run('mid:in-transaction', new Uint8Array([42]));
process.stdout.write('WEFT_DURABILITY_IN_TRANSACTION\\n');
await new Promise(() => {});
`;
  }
  // NodeSQLiteStorage
  return `
${importLineFor(spec)}
import { createRequire } from 'node:module';

const databasePath = process.argv[2];
const storage = openAdapter(databasePath);
await storage.batch([{ type: 'put', key: 'before:ok', value: new Uint8Array([1]) }]);
storage[Symbol.dispose]();

const requireFromHere = createRequire(import.meta.url);
const BetterSqlite3 = requireFromHere('better-sqlite3');
const database = new BetterSqlite3(databasePath);
database.pragma('journal_mode = WAL');
database.pragma('synchronous = NORMAL');
database.exec('BEGIN IMMEDIATE');
const insert = database.prepare('INSERT INTO kv (key, value) VALUES (?, ?)');
insert.run('mid:in-transaction', new Uint8Array([42]));
process.stdout.write('WEFT_DURABILITY_IN_TRANSACTION\\n');
await new Promise(() => {});
`;
}

function makeFixtureDirectory(label: string): string {
  const directory = join(tmpdir(), `weft-durability-${label}-${crypto.randomUUID()}`);
  mkdirSync(directory, { recursive: true });
  return directory;
}

for (const spec of availableAdapterSpecs()) {
  describe(`mid-transaction kill (3a, adapter batch) — ${spec.name}`, () => {
    let scope: FixtureScope;

    beforeEach(() => {
      scope = new FixtureScope();
    });

    afterEach(() => {
      scope.cleanup();
    });

    it('SIGKILL during or before batch() leaves at most pre-batch state', async () => {
      const directory = scope.makeTempDirectory('batch-kill');
      const entrypointPath = join(directory, 'entrypoint.ts');
      const databasePath = join(directory, 'weft.db');
      await Bun.write(entrypointPath, adapterBatchEntrypointSource(spec));

      const child = Bun.spawn({
        cmd: ['bun', entrypointPath, databasePath],
        stdout: 'pipe',
        stderr: 'pipe',
      });

      try {
        const stdoutBuffer = await readUntil(child.stdout, 'WEFT_DURABILITY_READY', 5000);
        await killAndWait(child);

        // If the batch ever completed before SIGKILL, the child printed
        // WEFT_DURABILITY_UNREACHABLE. Catch that.
        expect(stdoutBuffer).not.toContain('WEFT_DURABILITY_UNREACHABLE');

        const reader = await spec.open(databasePath);
        expect(await reader.storage.get('before:ok')).not.toBeNull();

        // No mid: rows survived. We sample a few; if any one is present,
        // either the batch committed (UNREACHABLE check would have caught
        // it) or partial state leaked.
        for (const index of [0, 1, 10, 100, 1000, 49_999]) {
          const key = `mid:${index.toString().padStart(8, '0')}`;
          expect(await reader.storage.get(key)).toBeNull();
        }
        await reader.close();
      } catch (error) {
        scope.markFailed();
        throw error;
      } finally {
        await killAndWait(child);
      }
    }, 15_000);
  });
}

for (const spec of availableBunNodeAdapterSpecs()) {
  describe(`mid-transaction kill (3b, deterministic) — ${spec.name}`, () => {
    let scope: FixtureScope;

    beforeEach(() => {
      scope = new FixtureScope();
    });

    afterEach(() => {
      scope.cleanup();
    });

    it('SIGKILL after BEGIN+INSERT, before COMMIT, rolls back the in-transaction row', async () => {
      const directory = scope.makeTempDirectory('in-transaction-kill');
      const entrypointPath = join(directory, 'entrypoint.ts');
      const databasePath = join(directory, 'weft.db');
      await Bun.write(entrypointPath, rawInTransactionEntrypointSource(spec));

      const child = Bun.spawn({
        cmd: ['bun', entrypointPath, databasePath],
        stdout: 'pipe',
        stderr: 'pipe',
      });

      try {
        await readUntil(child.stdout, 'WEFT_DURABILITY_IN_TRANSACTION', 5000);
        await killAndWait(child);

        const reader = await spec.open(databasePath);
        expect(await reader.storage.get('before:ok')).not.toBeNull();
        expect(await reader.storage.get('mid:in-transaction')).toBeNull();
        await reader.close();
      } catch (error) {
        scope.markFailed();
        throw error;
      } finally {
        await killAndWait(child);
      }
    }, 15_000);
  });
}

// Suppress unused-import warning when the suite skips Node specs.
void makeFixtureDirectory;
