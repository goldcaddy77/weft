import { describe, expect, it } from 'bun:test';
import { fileURLToPath } from 'node:url';
import type { WorkflowStartMeasurement } from './workflow-starts-runner.ts';

/**
 * K2a: Workflow start throughput benchmark.
 *
 * Measures aggregate start throughput for trivial workflows against the real
 * architecture target using a fresh Bun subprocess.
 *
 * The subprocess uses batched concurrent callers because the acceptance
 * criterion is single-node throughput, not single-caller latency. Coverage
 * instrumentation from `bun test --coverage` does not propagate into
 * `bun run`, so the child measurement path is the same in covered and
 * non-covered parent runs.
 */

const TARGET_STARTS_PER_SECOND = 50_000;
const TOTAL_STARTS = 10_000;
const START_BATCH_SIZE = 100;
const WARMUP_STARTS = 50;
const BENCHMARK_ENVIRONMENT_KEYS = [
  'HOME',
  'NODE_OPTIONS',
  'NODE_V8_COVERAGE',
  'PATH',
  'TEMP',
  'TMP',
  'TMPDIR',
  'USERPROFILE',
] as const;
const workflowStartsRunnerPath = fileURLToPath(
  new URL('./workflow-starts-runner.ts', import.meta.url),
);

function isWorkflowStartMeasurement(value: unknown): value is WorkflowStartMeasurement {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate['batchSize'] === 'number' &&
    Number.isInteger(candidate['batchSize']) &&
    candidate['batchSize'] > 0 &&
    typeof candidate['warmupStarts'] === 'number' &&
    Number.isInteger(candidate['warmupStarts']) &&
    candidate['warmupStarts'] >= 0 &&
    typeof candidate['measuredStarts'] === 'number' &&
    Number.isInteger(candidate['measuredStarts']) &&
    candidate['measuredStarts'] > 0 &&
    typeof candidate['startsPerSecond'] === 'number' &&
    Number.isFinite(candidate['startsPerSecond']) &&
    candidate['startsPerSecond'] > 0
  );
}

function runWorkflowStartBenchmark(): WorkflowStartMeasurement {
  const environment: Record<string, string> = {};
  for (const key of BENCHMARK_ENVIRONMENT_KEYS) {
    const value = process.env[key];
    if (typeof value === 'string') {
      environment[key] = value;
    }
  }

  const result = Bun.spawnSync(
    [
      process.execPath,
      'run',
      workflowStartsRunnerPath,
      String(TOTAL_STARTS),
      String(START_BATCH_SIZE),
      String(WARMUP_STARTS),
    ],
    {
      cwd: process.cwd(),
      stdout: 'pipe',
      stderr: 'pipe',
      env: environment,
    },
  );

  if (result.exitCode !== 0) {
    const errorOutput = new TextDecoder().decode(result.stderr).trim();
    throw new Error(`Workflow start benchmark subprocess failed: ${errorOutput}`);
  }

  const parsed = JSON.parse(new TextDecoder().decode(result.stdout)) as unknown;
  if (!isWorkflowStartMeasurement(parsed)) {
    throw new Error('Workflow start benchmark subprocess returned an invalid measurement payload');
  }

  return parsed;
}

describe('Workflow start throughput', () => {
  it(`starts exceed ${TARGET_STARTS_PER_SECOND.toLocaleString()} workflows/sec`, async () => {
    const measurement = runWorkflowStartBenchmark();

    console.log(
      [
        `\n  Workflow start throughput benchmark:`,
        `    Total starts:    ${measurement.measuredStarts.toLocaleString()}`,
        `    Start batch size:${measurement.batchSize.toLocaleString()}`,
        `    Warmup starts:   ${measurement.warmupStarts.toLocaleString()}`,
        `    Throughput:      ${measurement.startsPerSecond.toLocaleString()}/sec`,
        `    Target:          ${TARGET_STARTS_PER_SECOND.toLocaleString()}`,
        `    Child coverage:  no (Bun does not cover \`bun run\` subprocesses)\n`,
      ].join('\n'),
    );

    expect(measurement.startsPerSecond).toBeGreaterThanOrEqual(TARGET_STARTS_PER_SECOND);
  }, 120_000);
});
