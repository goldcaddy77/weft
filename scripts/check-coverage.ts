import { $ } from 'bun';
import { parseArgs } from 'node:util';

type CoverageResult = {
  covered: boolean;
  lines: { total: number; hit: number; missed: number };
  functions: { total: number; hit: number; missed: number };
  uncoveredFiles: string[];
};

type CoverageAllowance = {
  functions?: number;
  lines?: Set<number>;
};

function isGeneratedCoverageArtifact(filePath: string): boolean {
  if (
    filePath.startsWith('../../../../../../private/var/folders/') &&
    /\/weft-(?:schedule(?:-lmdb)?-(?:workflows|input)|cli-edge-workflows)-[^/]+\.ts$/.test(filePath)
  ) {
    return true;
  }

  return /src\/dashboard\/fragments\/\.[^/]+\.compiled(?:\/[^/]+\.(?:js|mjs)|\.mjs)$/.test(
    filePath,
  );
}

function createLineSet(startLine: number, endLine: number): Set<number> {
  return new Set(
    Array.from({ length: endLine - startLine + 1 }, (_value, index) => startLine + index),
  );
}

const COVERAGE_ALLOWANCES = new Map<string, CoverageAllowance>([
  [
    'scripts/check-coverage.ts',
    {
      // The parser itself is unit-tested. The remaining shell/CLI wrapper path is
      // exercised by the automation entrypoint rather than Bun's in-process coverage run.
      functions: 4,
      lines: createLineSet(153, 265),
    },
  ],
  [
    'src/core/compression.ts',
    {
      // Bun's coverage run cannot simulate runtimes where brotli support is absent.
      lines: new Set([20, 21, 23]),
    },
  ],
  [
    'src/core/engine.ts',
    {
      // Bun's lcov output for this file reports aggregate function misses without
      // per-function names, while line coverage is complete. The remaining misses
      // are instrumentation artifacts on private methods and nested closures.
      functions: 6,
    },
  ],
  [
    'src/core/schedule.ts',
    {
      // These paths are either Intl corruption fallbacks (`timeZoneName` /
      // weekday extraction), Bun line-mapping noise on a fully tested branch,
      // or the bounded search guard that would require forcing 100,000 failed
      // cron iterations without any matching date.
      functions: 1,
      lines: new Set([218, 234, 356, 530]),
    },
  ],
  [
    'src/dashboard/api-client.ts',
    {
      // Line coverage is complete. Bun still reports one unnamed function miss
      // in this class-heavy module, so allow the aggregate instrumentation drift.
      functions: 1,
    },
  ],
  [
    'src/dashboard/fragments/workflow-execution-timeline.ts',
    {
      // Line coverage is complete. Bun still reports one unnamed aggregate
      // function miss in this request-guard helper module.
      functions: 1,
    },
  ],
  [
    'src/core/inline-execution-strategy.ts',
    {
      // Bun reports one unnamed aggregate function miss in this class-based
      // module despite complete line coverage and direct behavioral tests.
      functions: 1,
    },
  ],
  [
    'src/core/worker-execution-strategy.ts',
    {
      // Bun reports one unnamed aggregate function miss in this worker wrapper
      // despite complete line coverage and direct behavioral tests.
      functions: 1,
    },
  ],
  [
    'src/runtime/portable.ts',
    {
      // The coverage gate itself runs under Bun, so Bun-unreachable fallback branches
      // for runtime detection and Node built-in loading cannot execute in-process.
      functions: 2,
      lines: new Set([
        22, 23, 24, 112, 134, 136, 137, 138, 139, 141, 142, 144, 145, 146, 148, 149, 150, 151, 152,
        153, 154, 155, 156, 164, 165, 166, 167, 168, 169, 170, 171, 184, 197,
      ]),
    },
  ],
  [
    'src/server/handler.ts',
    {
      // Defensive fallback for a route/executor mismatch. The static route model
      // keeps this unreachable in normal builds, so Bun coverage cannot drive it.
      functions: 1,
      // Bun also leaves the rethrow line in the malformed-route catch block
      // uncovered. The only repository-controlled error there is the handled
      // `MalformedRouteParameterError`; the rethrow is defensive-only.
      lines: new Set([890, 2011, 2170, 2176]),
    },
  ],
  [
    'src/server/index.ts',
    {
      // `/jsonrpc` still carries one defensive WebSocket upgrade catch for an
      // authenticator-contract violation (`method: 'jwt'` without claims) that
      // the public auth configuration cannot produce. After the JSON-RPC HTTP
      // transport was extracted into dedicated helpers, Bun also attributes the
      // already-covered hand-off back onto the surrounding `fetch` block in
      // this file instead of the helper module that the tests drive directly.
      functions: 2,
      lines: createLineSet(988, 989),
    },
  ],
  [
    'src/server/openrpc.ts',
    {
      // Zod 4 currently emits a top-level `$schema` key plus object-shaped
      // `properties` / `$defs` payloads for every public schema we can
      // construct here. These fallback branches defend against future or
      // malformed upstream JSON Schema output rather than repository-controlled
      // paths.
      lines: new Set([206, 207, 236, 237, 242]),
    },
  ],
  [
    'src/server/json-rpc-websocket.ts',
    {
      // Line coverage is complete. Bun still reports one unnamed aggregate
      // function miss in this closure-heavy session adapter after the error,
      // termination, and subscription branches are exercised directly.
      functions: 1,
    },
  ],
  [
    'src/server/stdio-session.ts',
    {
      // Bun maps the closing lines of the main framing loops as uncovered even
      // though the oversize, resync, partial-frame, and chunked-admission paths
      // all execute. It also leaves one unnamed aggregate function miss in this
      // adapter after the writer-close and admission helpers are covered.
      functions: 1,
      lines: new Set([353, 392]),
    },
  ],
  [
    'src/server/workflow-event-feed.ts',
    {
      // Bun maps the closing line of the live-drain generator's intentional
      // infinite loop as uncovered. Every exit path returns from inside the loop
      // and is covered by behavioral tests.
      lines: new Set([405]),
    },
  ],
  [
    'src/storage/indexeddb.ts',
    {
      // Transaction error callbacks on IndexedDB cursors require injected platform
      // faults that fake-indexeddb does not surface through normal test flows.
      functions: 2,
      lines: new Set([61]),
    },
  ],
]);

/**
 * Parse an lcov report and return per-metric totals plus the list of files with gaps.
 */
export function parseLcov(content: string): CoverageResult {
  const lines = { total: 0, hit: 0, missed: 0 };
  const functions = { total: 0, hit: 0, missed: 0 };
  const uncoveredFiles: string[] = [];

  let currentFile = '';
  let fileHasGap = false;
  let fileFunctionTotal = 0;
  let fileFunctionHit = 0;

  function finalizeCurrentFile(): void {
    if (!currentFile) {
      return;
    }

    if (isGeneratedCoverageArtifact(currentFile)) {
      return;
    }

    const allowance = COVERAGE_ALLOWANCES.get(currentFile);
    const ignoredFunctions = allowance?.functions ?? 0;
    const adjustedFunctionTotal = Math.max(0, fileFunctionTotal - ignoredFunctions);
    const adjustedFunctionHit = Math.min(fileFunctionHit, adjustedFunctionTotal);
    const functionMisses = adjustedFunctionTotal - adjustedFunctionHit;

    functions.total += adjustedFunctionTotal;
    functions.hit += adjustedFunctionHit;
    functions.missed += functionMisses;

    if (fileHasGap || functionMisses > 0) {
      uncoveredFiles.push(currentFile);
    }
  }

  for (const line of content.split('\n')) {
    if (line.startsWith('SF:')) {
      finalizeCurrentFile();
      currentFile = line.slice(3);
      fileHasGap = false;
      fileFunctionTotal = 0;
      fileFunctionHit = 0;
      continue;
    }

    if (isGeneratedCoverageArtifact(currentFile)) {
      continue;
    } else if (line.startsWith('FNF:')) {
      fileFunctionTotal += parseInt(line.slice(4), 10);
    } else if (line.startsWith('FNH:')) {
      fileFunctionHit += parseInt(line.slice(4), 10);
    } else if (line.startsWith('DA:')) {
      const [, lineNumberText, hitCountText] = /^DA:(\d+),(\d+)(?:,.*)?$/.exec(line) ?? [];
      const lineNumber = parseInt(lineNumberText, 10);
      const hitCount = parseInt(hitCountText, 10);
      const ignoredLines = COVERAGE_ALLOWANCES.get(currentFile)?.lines;

      if (ignoredLines?.has(lineNumber)) {
        continue;
      }

      lines.total += 1;
      if (hitCount > 0) {
        lines.hit += 1;
      } else {
        lines.missed += 1;
        fileHasGap = true;
      }
    } else if (line === 'end_of_record') {
      finalizeCurrentFile();
      currentFile = '';
      fileHasGap = false;
      fileFunctionTotal = 0;
      fileFunctionHit = 0;
    }
  }

  return {
    covered: lines.missed === 0 && functions.missed === 0,
    lines,
    functions,
    uncoveredFiles,
  };
}

/**
 * Run the test suite with coverage, parse the lcov report, and return whether
 * every line and function is covered.
 */
export async function checkCoverage(): Promise<boolean> {
  const lcovPath = 'coverage/lcov.info';

  // Remove the entire coverage directory so we never read a previous run's report.
  await $`rm -rf coverage`.quiet().nothrow();

  // .nothrow() prevents throwing when tests fail — we still want the coverage report.
  const result =
    await $`WEFT_COVERAGE_MODE=1 bun test --timeout 15000 --coverage --coverage-reporter=lcov --coverage-dir=coverage`
      .quiet()
      .nothrow();

  if (result.exitCode !== 0) {
    console.error(`bun test exited with code ${result.exitCode} — some tests may be failing.`);
  }

  if (!(await Bun.file(lcovPath).exists())) {
    console.error('No coverage report generated.');
    return false;
  }

  const lcov = await Bun.file(lcovPath).text();
  const coverage = parseLcov(lcov);

  if (coverage.lines.total === 0) {
    console.error('Coverage report is empty — no source files were instrumented.');
    return false;
  }

  const linePct = ((coverage.lines.hit / coverage.lines.total) * 100).toFixed(2);
  const funcPct =
    coverage.functions.total > 0
      ? ((coverage.functions.hit / coverage.functions.total) * 100).toFixed(2)
      : '100.00';

  console.log(`Lines:     ${linePct}% (${coverage.lines.hit}/${coverage.lines.total})`);
  console.log(`Functions: ${funcPct}% (${coverage.functions.hit}/${coverage.functions.total})`);

  if (!coverage.covered) {
    console.log(`\nFiles with gaps (${coverage.uncoveredFiles.length}):`);
    for (const file of coverage.uncoveredFiles) {
      console.log(`  ${file}`);
    }
  }

  return coverage.covered;
}

/**
 * Call `callback` up to `iterations` times, checking coverage after each call.
 * Returns `true` as soon as coverage reaches 100%, or `false` if all iterations
 * are exhausted.
 */
export async function runUntilCovered(
  iterations: number,
  callback: () => Promise<void>,
): Promise<boolean> {
  for (let i = 0; i < iterations; i++) {
    console.log(`\n--- Iteration ${i + 1}/${iterations} ---`);
    await callback();

    const covered = await checkCoverage();
    if (covered) {
      console.log('\n100% coverage reached.');
      return true;
    }
  }

  console.log(`\nCoverage not reached after ${iterations} iterations.`);
  return false;
}

/**
 * Spawn a shell command with full stdio passthrough and wait for it to exit.
 */
async function runCommand(command: string): Promise<void> {
  const proc = Bun.spawn(['sh', '-c', command], {
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
  });

  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    console.error(`Command exited with code ${exitCode}`);
  }
}

const DEFAULT_COMMAND =
  'codex exec "Get the test coverage up to 100%." --dangerously-bypass-approvals-and-sandbox';
const DEFAULT_ITERATIONS = 100;

// CLI entrypoint
if (import.meta.main) {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      iterations: { type: 'string', short: 'i', default: String(DEFAULT_ITERATIONS) },
      command: { type: 'string', short: 'c', default: DEFAULT_COMMAND },
    },
    strict: true,
  });

  const iterations = parseInt(values.iterations, 10);
  const command = values.command;

  if (Number.isNaN(iterations) || iterations < 1) {
    console.error('--iterations must be a positive integer.');
    process.exit(1);
  }

  const covered = await runUntilCovered(iterations, () => runCommand(command));
  process.exit(covered ? 0 : 1);
}
