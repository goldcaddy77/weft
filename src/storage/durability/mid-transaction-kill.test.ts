/**
 * Mid-transaction SIGKILL tests.
 *
 * Two complementary tests per adapter:
 *
 *   - 3a (adapter-batch kill window): subprocess opens the real adapter,
 *     seeds a pre-batch marker, prints `WEFT_DURABILITY_READY`, then calls
 *     a large `batch()`. The parent SIGKILLs after seeing readiness. The
 *     readiness marker is emitted BEFORE `batch()` starts, so the kill may
 *     land before, during, or after the SQL transaction — the test does
 *     not (and cannot) claim the kill is mid-transaction. The narrow
 *     claim is: "a SIGKILL anywhere from the moment the batch is
 *     scheduled through commit leaves at most the pre-batch state, and
 *     no partial `mid:` rows are visible." The full `mid:` prefix is
 *     scanned to make partial commits loud.
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
 * deadlocks the runner. The reader handle opened in the parent is also
 * closed in `finally` so a thrown assertion never leaves a SQLite handle
 * open against a temp directory that's about to be removed.
 */

import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import {
  availableAdapterSpecs,
  availableBunNodeAdapterSpecs,
  closeIfOpen,
  FixtureScope,
  type AdapterSpec,
  type BunOrNodeAdapterSpec,
  type OpenedAdapter,
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

function expectReadableStream(
  stream: ReadableStream<Uint8Array> | number | undefined,
  label: 'stdout' | 'stderr',
): ReadableStream<Uint8Array> {
  if (stream === undefined || typeof stream === 'number') {
    throw new Error(
      `Expected ${label} to be a piped ReadableStream — got ${typeof stream}. ` +
        `Did the Bun.spawn options forget \`${label}: 'pipe'\`?`,
    );
  }
  return stream;
}

/**
 * Drain a stream fully to a string. Called only on the error path AFTER
 * the subprocess has exited, so reading to EOF cannot block — there is no
 * more producer. A previous version of this helper raced each read against
 * a 200ms inactivity timer, which truncated bursty stderr output and hid
 * the most useful part of the diagnostic.
 */
async function drainStream(stream: ReadableStream<Uint8Array>): Promise<string> {
  const decoder = new TextDecoder();
  let text = '';
  const reader = stream.getReader();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value !== undefined) text += decoder.decode(value, { stream: true });
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // best-effort
    }
  }
  return text;
}

/**
 * Wait for the marker on stdout or for the subprocess to exit. If the
 * subprocess exits before the marker arrives, throw a diagnostic error that
 * includes the exit code, signal, captured stdout, and remaining stderr.
 */
async function readUntilMarkerOrExit(
  child: RunningChild,
  marker: string,
  deadlineMs: number,
): Promise<string> {
  const decoder = new TextDecoder();
  const stdoutStream = expectReadableStream(child.stdout, 'stdout');
  const reader = stdoutStream.getReader();
  let buffer = '';
  const deadline = Date.now() + deadlineMs;
  let earlyExit = false;
  type ReadResult = Awaited<ReturnType<typeof reader.read>>;
  type RaceResult =
    | { kind: 'read'; readResult: ReadResult }
    | { kind: 'exited' }
    | { kind: 'timeout' };
  try {
    while (Date.now() < deadline) {
      const remaining = Math.max(0, deadline - Date.now());
      const result: RaceResult = await Promise.race([
        reader.read().then((readResult): RaceResult => ({ kind: 'read', readResult })),
        child.exited.then((): RaceResult => ({ kind: 'exited' })),
        realSleep(remaining).then((): RaceResult => ({ kind: 'timeout' })),
      ]);
      if (result.kind === 'exited') {
        earlyExit = true;
        break;
      }
      if (result.kind === 'timeout') break;
      if (result.readResult.done) {
        earlyExit = true;
        break;
      }
      if (result.readResult.value) {
        buffer += decoder.decode(result.readResult.value, { stream: true });
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
  if (earlyExit) {
    const stderr = await drainStream(expectReadableStream(child.stderr, 'stderr'));
    throw new Error(
      `Subprocess exited before marker ${JSON.stringify(marker)} appeared.\n` +
        `exitCode=${String(child.exitCode)} signalCode=${String(child.signalCode)}\n` +
        `stdout:\n${buffer}\nstderr:\n${stderr}`,
    );
  }
  throw new Error(`Timed out waiting for marker ${JSON.stringify(marker)}.\nstdout:\n${buffer}`);
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

function rawInTransactionEntrypointSource(spec: BunOrNodeAdapterSpec): string {
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

async function countMidRows(reader: OpenedAdapter): Promise<number> {
  let count = 0;
  for await (const _entry of reader.storage.scan('mid:')) {
    count++;
  }
  return count;
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

    it('SIGKILL during the adapter batch leaves at most pre-batch state with zero partial rows', async () => {
      const directory = scope.makeTempDirectory('batch-kill');
      const entrypointPath = join(directory, 'entrypoint.ts');
      const databasePath = join(directory, 'weft.db');
      await Bun.write(entrypointPath, adapterBatchEntrypointSource(spec));

      const child = Bun.spawn({
        cmd: ['bun', entrypointPath, databasePath],
        stdout: 'pipe',
        stderr: 'pipe',
      });

      let reader: OpenedAdapter | undefined;
      try {
        const stdoutBuffer = await readUntilMarkerOrExit(child, 'WEFT_DURABILITY_READY', 5000);
        await killAndWait(child);

        // Best-effort early signal: if the child managed to print the
        // unreachable marker before SIGKILL was delivered, the batch must
        // have committed. The authoritative check is the full `mid:`
        // prefix scan below.
        expect(stdoutBuffer).not.toContain('WEFT_DURABILITY_UNREACHABLE');

        reader = await spec.open(databasePath);
        expect(await reader.storage.get('before:ok')).not.toBeNull();

        // Authoritative assertion: scan the entire `mid:` prefix. A
        // partial commit anywhere in the 50k entries would show up as a
        // non-zero count.
        const partialMidCount = await countMidRows(reader);
        expect(partialMidCount).toBe(0);
      } catch (error) {
        scope.markFailed();
        throw error;
      } finally {
        await closeIfOpen(reader);
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

      let reader: OpenedAdapter | undefined;
      try {
        await readUntilMarkerOrExit(child, 'WEFT_DURABILITY_IN_TRANSACTION', 5000);
        await killAndWait(child);

        // Verify the child was actually killed by SIGKILL, not by a crash
        // mid-setup. If the child exited from a thrown error, that's an
        // environment/test bug, not a durability claim.
        expect(child.signalCode).toBe('SIGKILL');

        reader = await spec.open(databasePath);
        expect(await reader.storage.get('before:ok')).not.toBeNull();
        expect(await reader.storage.get('mid:in-transaction')).toBeNull();
      } catch (error) {
        scope.markFailed();
        throw error;
      } finally {
        await closeIfOpen(reader);
        await killAndWait(child);
      }
    }, 15_000);
  });
}
