import { $ } from 'bun';
import sveltePlugin from 'bun-plugin-svelte';

await $`rm -rf dist`;

// Node/Bun target — main bundle + per-backend storage submodules.
// Heavy backends (lmdb, @libsql/client) are externalized so consumers
// only pay for what they actually import.
await Bun.build({
  entrypoints: [
    './src/index.ts',
    // Storage submodule entry points (one per subpath export)
    './src/storage/interface.ts',
    './src/storage/memory.ts',
    './src/storage/compressed-storage.ts',
    './src/storage/scoped-storage.ts',
    './src/storage/typed-storage.ts',
    './src/storage/resolve.ts',
    './src/storage/lmdb.ts',
    './src/storage/turso.ts',
    './src/testing/index.ts',
    // Bun-only server subpath (weft/server)
    './src/server/index.ts',
  ],
  outdir: './dist',
  target: 'bun',
  format: 'esm',
  root: './src',
  naming: '[dir]/[name].js',
  sourcemap: 'external',
  minify: true,
  external: ['lmdb', '@libsql/client', '@opentelemetry/api', 'bun:sqlite', 'better-sqlite3'],
});

// Keep the storage barrel as direct re-exports. Bun 1.3.13 can incorrectly
// strip imported bindings that are only used by a bundled barrel export list.
await Bun.write(
  './dist/storage/index.js',
  `export { KEYS, storageConditionalBatch, storageValuesEqual } from './interface.js';
export { MemoryStorage } from './memory.js';
export { resolveStorage } from './resolve.js';
export { ScopedStorage, scopedStorage } from './scoped-storage.js';
export { jsonCodec, msgpackCodec, withCodec } from './typed-storage.js';
`,
);
await $`rm -f dist/storage/index.js.map`;

// Preserve runtime constructor names for package export-condition smoke tests.
await Bun.build({
  entrypoints: ['./src/storage/bun-sql.ts', './src/storage/node-sqlite.ts'],
  outdir: './dist',
  target: 'bun',
  format: 'esm',
  root: './src',
  naming: '[dir]/[name].js',
  sourcemap: 'external',
  minify: false,
  external: ['bun:sqlite', 'better-sqlite3'],
});

// Browser entrypoints (Service Worker, IndexedDB, handler)
await Bun.build({
  entrypoints: [
    './src/service-worker/index.ts',
    './src/storage/indexeddb.ts',
    './src/storage/web-extension.ts',
    // HTTPStorage is portable and intentionally emitted from the browser build
    // so the subpath is produced once without a later overwrite.
    './src/storage/http.ts',
    './src/server/handler.ts',
  ],
  outdir: './dist',
  target: 'browser',
  format: 'esm',
  naming: '[dir]/[name].js',
  sourcemap: 'external',
  minify: true,
});

// Dashboard (Svelte SPA for /ui)
await Bun.build({
  entrypoints: ['./src/dashboard/index.html'],
  outdir: './dist/dashboard',
  target: 'browser',
  minify: true,
  sourcemap: 'external',
  plugins: [sveltePlugin],
});

await $`bunx tsc --declaration --emitDeclarationOnly --project tsconfig.build.json`;

console.log('Build complete!');
