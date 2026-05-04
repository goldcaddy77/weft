/**
 * Verifies that per-backend submodule exports are correctly tree-shakable.
 *
 * Builds tiny consumer entries against the local dist/ and asserts that:
 *  - Importing from dist/storage/memory does NOT pull in lmdb or @libsql/client
 *  - Importing from dist/storage/lmdb keeps lmdb as an external import (not inlined)
 *
 * Run after `bun run build`: bun run verify:exports
 */

import { mkdtempSync, rmSync } from 'node:fs';
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
    // Use the absolute POSIX path as the import specifier. Bun.build does not
    // accept file:// URLs — and since this script only runs on Bun (macOS/Linux),
    // backslash path separators are not a concern.
    await Bun.write(
      entryFile,
      `import { ${namedExport} } from ${JSON.stringify(absoluteTarget)}; export { ${namedExport} };`,
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

// ---------------------------------------------------------------------------
// Test 5: root entrypoint must not export testing primitives
// ---------------------------------------------------------------------------
{
  const tempDir = mkdtempSync(join(tmpdir(), 'weft-root-testing-export-'));
  const entryFile = join(tempDir, 'entry.ts');
  const fixtureFile = join(import.meta.dir, 'fixtures/root-import-testing.ts');
  const rootEntrypoint = join(distPath, 'index.js');

  try {
    const fixtureSource = await Bun.file(fixtureFile).text();
    const patchedSource = fixtureSource.replace("'weft'", JSON.stringify(rootEntrypoint));
    if (patchedSource === fixtureSource) {
      throw new Error(
        `Test 5: fixture replacement produced no change. ${fixtureFile} no longer contains the literal "'weft'" — update the fixture or the replacement target.`,
      );
    }
    await Bun.write(entryFile, patchedSource);

    try {
      const result = await Bun.build({
        entrypoints: [entryFile],
        outdir: join(tempDir, 'out'),
        target: 'bun',
        format: 'esm',
        minify: true,
        packages: 'bundle',
        throw: false,
      });
      const messages = result.logs.map((log) => log.message).join('\n');

      if (result.success) {
        fail('weft root entrypoint still exports TestEngine');
      } else if (!/TestEngine|no matching export/i.test(messages)) {
        fail(`weft root TestEngine import failed with an unexpected message:\n${messages}`);
      } else {
        pass('weft root entrypoint rejects TestEngine imports');
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/TestEngine|no matching export/i.test(message)) {
        fail(`weft root TestEngine import threw an unexpected error:\n${message}`);
      } else {
        pass('weft root entrypoint rejects TestEngine imports');
      }
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Test 6: root bundle must not contain testing source files or identifiers
// ---------------------------------------------------------------------------
const rootBundle = await buildEntry('index.js', 'Engine', ['lmdb', '@libsql/client', 'bun:sqlite']);

const testingSourceTokens = [
  'src/testing/test-engine',
  'src/testing/time-control',
  'src/testing/mocks',
  'src/testing/chaos',
];
const testingIdentifierTokens = [
  'TestEngine',
  'TimeControl',
  'ActivityMockRegistry',
  'ChaosTransientError',
  'ChaosTimeoutError',
  'ChaosNonRetryableError',
  'withChaos',
];
const foundTestingBundleTokens = [...testingSourceTokens, ...testingIdentifierTokens].filter(
  (token) => rootBundle.includes(token),
);

if (foundTestingBundleTokens.length > 0) {
  fail(`weft root bundle contains testing code: ${foundTestingBundleTokens.join(', ')}`);
} else {
  pass('weft root bundle excludes testing source files and identifiers');
}

// ---------------------------------------------------------------------------
// Test 7: testing subpath exports testing primitives
// ---------------------------------------------------------------------------
{
  const tempDir = mkdtempSync(join(tmpdir(), 'weft-testing-subpath-'));
  const entryFile = join(tempDir, 'entry.ts');
  const testingEntrypoint = join(distPath, 'testing/index.js');

  try {
    await Bun.write(
      entryFile,
      [
        `import { ActivityMockRegistry, TestEngine, TimeControl, withChaos } from ${JSON.stringify(testingEntrypoint)};`,
        'export { ActivityMockRegistry, TestEngine, TimeControl, withChaos };',
      ].join('\n'),
    );

    const result = await Bun.build({
      entrypoints: [entryFile],
      outdir: join(tempDir, 'out'),
      target: 'bun',
      format: 'esm',
      minify: true,
      packages: 'bundle',
      external: ['lmdb', '@libsql/client', 'bun:sqlite'],
    });

    if (!result.success) {
      const messages = result.logs.map((log) => log.message).join('\n');
      fail(`weft/testing failed to export testing primitives:\n${messages}`);
    } else {
      const outputs = await Promise.all(result.outputs.map((output) => output.text()));
      const bundleText = outputs.join('\n');
      const requiredIdentifiers = [
        'ActivityMockRegistry',
        'TestEngine',
        'TimeControl',
        'withChaos',
      ];
      const missing = requiredIdentifiers.filter((token) => !bundleText.includes(token));
      if (missing.length > 0) {
        fail(`weft/testing bundle is missing expected exports: ${missing.join(', ')}`);
      } else {
        pass('weft/testing exports testing primitives');
      }
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Test 8: weft/storage barrel loads cleanly and exposes its value exports
//
// The Bun 1.3.13 minifier emits broken JavaScript for pure re-export barrels,
// where Node's loader rejects the dist file with `Export 'B' is not defined
// in module`. The aliased-const-export workaround in src/storage/index.ts
// fixes that. This test guards against regression: load the dist barrel
// in-process and confirm every documented value export resolves.
// ---------------------------------------------------------------------------
{
  const storageEntrypoint = join(distPath, 'storage/index.js');
  const expectedExports = [
    'KEYS',
    'MemoryStorage',
    'ScopedStorage',
    'jsonCodec',
    'msgpackCodec',
    'scopedStorage',
    'storageConditionalBatch',
    'storageValuesEqual',
    'withCodec',
  ];

  try {
    const module = (await import(storageEntrypoint)) as Record<string, unknown>;
    const missing = expectedExports.filter((name) => module[name] === undefined);
    if (missing.length > 0) {
      fail(`weft/storage barrel is missing exports: ${missing.join(', ')}`);
    } else {
      pass('weft/storage barrel loads cleanly with all value exports');
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    fail(`weft/storage barrel failed to load: ${message}`);
  }
}

if (failed) {
  process.exit(1);
}

process.stdout.write('\nAll tree-shaking checks passed.\n');
