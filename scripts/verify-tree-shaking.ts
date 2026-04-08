/**
 * Verifies that per-backend submodule exports are correctly tree-shakable.
 *
 * Builds tiny consumer entries against the local dist/ and asserts that:
 *  - Importing from dist/storage/memory does NOT pull in lmdb or @libsql/client
 *  - Importing from dist/storage/lmdb keeps lmdb as an external import (not inlined)
 *
 * Run after `bun run build`: bun run verify:exports
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const distPath = join(import.meta.dir, '../dist');

// ---------------------------------------------------------------------------
// Helper: build a tiny entry file importing from a dist path and return text
// ---------------------------------------------------------------------------
async function buildEntry(
  distRelativePath: string,
  namedExport: string,
  external: string[] = [],
): Promise<string> {
  const tempDir = mkdtempSync(join(tmpdir(), 'weft-treeshake-'));
  const entryFile = join(tempDir, 'entry.ts');
  const absoluteTarget = join(distPath, distRelativePath);

  try {
    writeFileSync(
      entryFile,
      `import { ${namedExport} } from ${JSON.stringify(absoluteTarget)}; export { ${namedExport} };`,
      'utf-8',
    );

    const result = await Bun.build({
      entrypoints: [entryFile],
      outdir: join(tempDir, 'out'),
      target: 'bun',
      format: 'esm',
      minify: true,
      packages: 'bundle',
      external,
    });

    if (!result.success) {
      const messages = result.logs.map((l) => l.message).join('\n');
      throw new Error(`Build failed:\n${messages}`);
    }

    const outputs = await Promise.all(result.outputs.map((o) => o.text()));
    return outputs.join('\n');
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

let failed = false;

function pass(message: string): void {
  process.stdout.write(`✓ ${message}\n`);
}

function fail(message: string): void {
  process.stderr.write(`✗ ${message}\n`);
  failed = true;
}

// ---------------------------------------------------------------------------
// Test 1: storage/memory must NOT contain heavy backend code
// ---------------------------------------------------------------------------
const memoryBundle = await buildEntry('storage/memory.js', 'MemoryStorage', [
  'lmdb',
  '@libsql/client',
  'bun:sqlite',
]);

const heavyTokens = ['LMDBStorage', 'TursoStorage', 'BunSQLiteStorage'];
const foundHeavy = heavyTokens.filter((token) => memoryBundle.includes(token));

if (foundHeavy.length > 0) {
  fail(`weft/storage/memory bundle contains heavy backend code: ${foundHeavy.join(', ')}`);
} else {
  pass('weft/storage/memory is free of heavy backend code');
}

// ---------------------------------------------------------------------------
// Test 2: storage/index (barrel) must NOT pull in heavy backends
// ---------------------------------------------------------------------------
const storageBarrelBundle = await buildEntry('storage/index.js', 'MemoryStorage', [
  'lmdb',
  '@libsql/client',
  'bun:sqlite',
]);

const foundInBarrel = heavyTokens.filter((token) => storageBarrelBundle.includes(token));

if (foundInBarrel.length > 0) {
  fail(`weft/storage barrel bundle contains heavy backend code: ${foundInBarrel.join(', ')}`);
} else {
  pass('weft/storage barrel is free of heavy backend code');
}

// ---------------------------------------------------------------------------
// Test 3: storage/lmdb keeps lmdb as an external (not inlined)
// ---------------------------------------------------------------------------
const lmdbBundle = await buildEntry('storage/lmdb.js', 'LMDBStorage', [
  'lmdb',
  '@libsql/client',
  'bun:sqlite',
]);

if (!lmdbBundle.includes('lmdb')) {
  fail('weft/storage/lmdb bundle has no reference to lmdb (should be external import)');
} else if (lmdbBundle.includes('@libsql/client')) {
  fail('weft/storage/lmdb bundle unexpectedly contains @libsql/client');
} else {
  pass('weft/storage/lmdb externalizes lmdb correctly');
}

// ---------------------------------------------------------------------------
// Test 4: storage/turso keeps @libsql/client as an external
// ---------------------------------------------------------------------------
const tursoBundle = await buildEntry('storage/turso.js', 'TursoStorage', [
  'lmdb',
  '@libsql/client',
  'bun:sqlite',
]);

if (!tursoBundle.includes('@libsql/client')) {
  fail('weft/storage/turso bundle has no reference to @libsql/client (should be external import)');
} else {
  pass('weft/storage/turso externalizes @libsql/client correctly');
}

if (failed) {
  process.exit(1);
}

process.stdout.write('\nAll tree-shaking checks passed.\n');
