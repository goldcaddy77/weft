import { $ } from 'bun';
import sveltePlugin from 'bun-plugin-svelte';

const entrypoints = ['./src/index.ts'];

await $`rm -rf dist`;

await Bun.build({
  entrypoints,
  outdir: './dist',
  target: 'node',
  format: 'esm',
  naming: '[dir]/[name].js',
  sourcemap: 'external',
  minify: true,
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
  plugins: [sveltePlugin()],
});

await $`bunx tsc --declaration --emitDeclarationOnly --project tsconfig.build.json`;

console.log('Build complete!');
