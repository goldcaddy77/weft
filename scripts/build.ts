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
    './src/storage/index.ts',
    './src/storage/interface.ts',
    './src/storage/memory.ts',
    './src/storage/compressed-storage.ts',
    './src/storage/bun-sql.ts',
    './src/storage/lmdb.ts',
    './src/storage/turso.ts',
    './src/storage/node-sqlite.ts',
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

// Browser entrypoints (Service Worker, IndexedDB, handler)
await Bun.build({
  entrypoints: [
    './src/service-worker/index.ts',
    './src/storage/indexeddb.ts',
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
