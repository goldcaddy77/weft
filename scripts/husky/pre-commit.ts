#!/usr/bin/env bun
import { $ } from 'bun';

import {
  error,
  getStagedFiles,
  header,
  info,
  isContinuousIntegration,
  success,
  warning,
} from './utilities.ts';

if (isContinuousIntegration()) {
  info('Skipping hook in CI');
  process.exit(0);
}

header('Pre-commit checks');
let ok = true;

// 1) package/lock checks
const staged = await getStagedFiles();
if (staged.includes('package.json')) {
  info('package.json is staged');
  if (!staged.includes('bun.lock')) {
    const bunLockStatus = await $`git status --porcelain -- bun.lock`.text();
    if (bunLockStatus.trim().length > 0) {
      warning('bun.lock has unstaged changes');
      info('Run bun install and stage bun.lock');
      ok = false;
    } else {
      info('bun.lock unchanged; continuing');
    }
  } else {
    info('Dependencies changed, installing…');
    try {
      await $`bun install`;
      success('Dependencies installed');
    } catch {
      warning('bun install failed; run it manually');
    }
  }
}

// 2) lint:fix
info('Running lint:fix…');
try {
  await $`bun run lint:fix`;
  success('lint:fix passed');
} catch {
  error('lint:fix failed');
  ok = false;
}

// 3) typecheck
info('Running typecheck…');
try {
  await $`bun run typecheck`;
  success('typecheck passed');
} catch {
  error('typecheck failed');
  ok = false;
}

// 4) test
// Run tests but skip benchmark files. Performance benchmarks are sensitive
// to system load and fail intermittently when run alongside 3,400+ other
// tests. They are verified in CI and can be run in isolation via
// `bun test src/benchmarks/`.
//
// Two benchmark-shaped suites live outside `src/benchmarks/` for historical
// reasons and exhibit the same load sensitivity: they assert raw
// throughput numbers (`bun-sql-benchmark.test.ts`) or depend on tight
// timing windows (`bulk-operations.test.ts > snapshots workflow ids
// before bulk signal …`). CI runs them in isolation; pre-commit excludes
// them so a quality-of-throughput regression doesn't masquerade as a
// failed local commit.
const LOAD_SENSITIVE_TEST_PATHS = [
  'src/storage/bun-sql-benchmark.test.ts',
  'src/core/bulk-operations.test.ts',
] as const;
info('Running test…');
try {
  const glob = new Bun.Glob('{src,tests}/**/*.test.ts');
  const testFiles = [];
  for await (const file of glob.scan('.')) {
    if (file.includes('/benchmarks/')) continue;
    if (LOAD_SENSITIVE_TEST_PATHS.includes(file as (typeof LOAD_SENSITIVE_TEST_PATHS)[number]))
      continue;
    testFiles.push(file);
  }
  await $`bun test --timeout 15000 ${testFiles}`;
  success('test passed');
} catch {
  error('test failed');
  ok = false;
}

// 5) JSDoc manifest audit (only when source/manifest/package.json changed)
const stagedTouchesPublicSurface = staged.some(
  (file) =>
    file.startsWith('src/') ||
    file === 'package.json' ||
    file === 'reference/jsdoc-manifest.json' ||
    file.startsWith('scripts/audit-jsdoc-manifest') ||
    file.startsWith('scripts/build-jsdoc-manifest') ||
    file.startsWith('scripts/check-declaration-jsdoc') ||
    file.startsWith('scripts/classify-jsdoc-manifest') ||
    file.startsWith('scripts/extract-doctests'),
);
if (stagedTouchesPublicSurface) {
  info('Running JSDoc audit…');
  try {
    await $`bun run scripts/audit-jsdoc-manifest.ts`;
    success('JSDoc audit passed');
  } catch {
    error(
      'JSDoc audit failed — see hint above. Run `bun run scripts/build-jsdoc-manifest.ts && bun run scripts/classify-jsdoc-manifest.ts` if a public export was added.',
    );
    ok = false;
  }
} else {
  info('Skipping JSDoc audit (no public surface changes staged)');
}

// 6) lint-staged (format staged files; always last)
info('Running lint-staged…');
try {
  await $`bunx lint-staged`;
  success('Lint-staged passed');
} catch {
  error('Lint-staged failed');
  ok = false;
}

if (!ok) {
  error('Pre-commit checks failed');
  process.exit(1);
}

success('All pre-commit checks passed');

process.exit(0);
