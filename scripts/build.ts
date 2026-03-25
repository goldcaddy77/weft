import { $ } from 'bun';

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

await $`bunx tsc --declaration --emitDeclarationOnly --project tsconfig.build.json`;

console.log('Build complete!');
