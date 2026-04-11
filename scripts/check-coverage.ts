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

const COVERAGE_ALLOWANCES = new Map<string, CoverageAllowance>([
  [
    'src/core/compression.ts',
    {
      // Bun's coverage run cannot simulate runtimes where brotli support is absent.
      lines: new Set([20, 21, 23]),
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
      lines: new Set([891]),
    },
  ],
]);

/**
 * Parse an lcov report and return per-metric totals plus the list of files with gaps.
 */
function parseLcov(content: string): CoverageResult {
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
    } else if (line.startsWith('FNF:')) {
      fileFunctionTotal += parseInt(line.slice(4), 10);
    } else if (line.startsWith('FNH:')) {
      fileFunctionHit += parseInt(line.slice(4), 10);
    } else if (line.startsWith('DA:')) {
      const [, lineNumberText, hitCountText] = /^DA:(\d+),(\d+)$/.exec(line) ?? [];
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
