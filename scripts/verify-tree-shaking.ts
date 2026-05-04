/**
 * Verifies that per-backend submodule exports are correctly tree-shakable.
 *
 * Builds tiny consumer entries against the local dist/ and asserts that:
 *  - Importing from dist/storage/memory does NOT pull in lmdb or @libsql/client
 *  - Importing from dist/storage/lmdb keeps lmdb as an external import (not inlined)
 *
 * Run after `bun run build`: bun run verify:exports
 */

import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

const repositoryPath = join(import.meta.dir, '..');
const distPath = join(repositoryPath, 'dist');

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

function runSmokeScript(
  command: readonly string[],
  runtimeName: string,
  description: string,
  script: string,
): void {
  const result = Bun.spawnSync([...command, script], {
    cwd: repositoryPath,
    stdout: 'pipe',
    stderr: 'pipe',
    env: process.env,
  });

  if (result.exitCode === 0) {
    pass(`${description} under ${runtimeName}`);
    return;
  }

  const stderr = new TextDecoder().decode(result.stderr).trim();
  const stdout = new TextDecoder().decode(result.stdout).trim();
  fail(
    [
      `${description} failed under ${runtimeName}`,
      stdout ? `stdout:\n${stdout}` : '',
      stderr ? `stderr:\n${stderr}` : '',
    ]
      .filter(Boolean)
      .join('\n'),
  );
}

function runSQLiteImportSmokeTest(
  command: readonly string[],
  expectedConstructorName: string,
  runtimeName: string,
): void {
  const script = [
    "import { SQLiteStorage } from 'weft/storage/sqlite';",
    `if (SQLiteStorage.name !== ${JSON.stringify(expectedConstructorName)}) {`,
    `  throw new Error(\`Expected ${runtimeName} to resolve SQLiteStorage to ${expectedConstructorName}, got \${SQLiteStorage.name}\`);`,
    '}',
  ].join('\n');
  runSmokeScript(
    command,
    runtimeName,
    `weft/storage/sqlite resolves to ${expectedConstructorName}`,
    script,
  );
}

function resolveRealNodeExecutable(): string | null {
  const bunExecutable = realpathSync(process.execPath);
  for (const directory of (process.env.PATH ?? '').split(delimiter)) {
    if (directory.includes('bun-node-')) continue;

    const candidate = join(directory, 'node');
    if (!existsSync(candidate)) continue;

    const realCandidate = realpathSync(candidate);
    if (realCandidate === bunExecutable || realCandidate.includes('/.bun/')) continue;

    return candidate;
  }

  return null;
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
// Test 5: storage package entrypoints load in their intended runtimes
// ---------------------------------------------------------------------------
const storageBarrelScript = [
  "import * as storage from 'weft/storage';",
  "for (const name of ['KEYS', 'MemoryStorage', 'resolveStorage', 'ScopedStorage', 'scopedStorage', 'withCodec', 'jsonCodec', 'msgpackCodec']) {",
  '  if (!(name in storage)) throw new Error(`Missing storage barrel export: ${name}`);',
  '}',
].join('\n');

const storageAdapterSubpathsScript = [
  "import { HTTPStorage } from 'weft/storage/http';",
  "import { resolveStorage } from 'weft/storage/resolve';",
  "import { WebExtensionStorage } from 'weft/storage/web-extension';",
  "if (typeof HTTPStorage !== 'function') throw new Error('HTTPStorage subpath failed');",
  "if (typeof WebExtensionStorage !== 'function') throw new Error('WebExtensionStorage subpath failed');",
  "if (typeof resolveStorage !== 'function') throw new Error('resolveStorage subpath failed');",
].join('\n');

const bunSqliteOverrideScript = [
  "import { BunSQLiteStorage, SQLiteStorage } from 'weft/storage/sqlite/bun';",
  "if (BunSQLiteStorage.name !== 'BunSQLiteStorage') throw new Error('BunSQLiteStorage export failed');",
  "if (SQLiteStorage.name !== 'BunSQLiteStorage') throw new Error('SQLiteStorage Bun override failed');",
].join('\n');

const nodeSqliteOverrideScript = [
  "import { NodeSQLiteStorage, SQLiteStorage } from 'weft/storage/sqlite/node';",
  "if (NodeSQLiteStorage.name !== 'NodeSQLiteStorage') throw new Error('NodeSQLiteStorage export failed');",
  "if (SQLiteStorage.name !== 'NodeSQLiteStorage') throw new Error('SQLiteStorage Node override failed');",
].join('\n');

runSmokeScript(
  [process.execPath, '--eval'],
  'Bun',
  'weft/storage full barrel imports',
  storageBarrelScript,
);
runSmokeScript(
  [process.execPath, '--eval'],
  'Bun',
  'new storage adapter subpaths import',
  storageAdapterSubpathsScript,
);
runSmokeScript(
  [process.execPath, '--eval'],
  'Bun',
  'weft/storage/sqlite/bun explicit override imports',
  bunSqliteOverrideScript,
);
runSQLiteImportSmokeTest([process.execPath, '--eval'], 'BunSQLiteStorage', 'Bun');

const nodeExecutable = resolveRealNodeExecutable();
if (nodeExecutable === null) {
  fail('weft/storage/sqlite Node.js import smoke test requires a real node executable on PATH');
} else {
  runSmokeScript(
    [nodeExecutable, '--input-type=module', '--eval'],
    'Node.js',
    'weft/storage full barrel imports',
    storageBarrelScript,
  );
  runSmokeScript(
    [nodeExecutable, '--input-type=module', '--eval'],
    'Node.js',
    'new storage adapter subpaths import',
    storageAdapterSubpathsScript,
  );
  runSmokeScript(
    [nodeExecutable, '--input-type=module', '--eval'],
    'Node.js',
    'weft/storage/sqlite/node explicit override imports',
    nodeSqliteOverrideScript,
  );
  runSQLiteImportSmokeTest(
    [nodeExecutable, '--input-type=module', '--eval'],
    'NodeSQLiteStorage',
    'Node.js',
  );
}

if (failed) {
  process.exit(1);
}

process.stdout.write('\nAll tree-shaking checks passed.\n');
