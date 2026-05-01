import { describe, expect, it } from 'bun:test';

import { isCoverageInstrumentationEnabled } from './coverage-mode.ts';
import type { WorkerSpawnMeasurement } from './worker-spawn-runner.ts';

/**
 * K2f: Worker spawn benchmark.
 *
 * Measures end-to-end worker spawn latency from `new Worker(...)` through the
 * first successful postMessage round-trip. The benchmark uses the existing
 * echo worker fixture so it measures an observable readiness boundary rather
 * than just constructor overhead.
 *
 * Architecture target: <5ms median on Bun.
 *
 * Runs in a fresh Bun subprocess so full-suite scheduler noise does not
 * inflate the measurement. That lets the default non-coverage gate enforce the
 * actual `<5ms` architecture target instead of a relaxed in-process floor.
 *
 * Coverage mode gets a slightly looser floor because instrumentation adds
 * measurable overhead to worker bootstrap and message dispatch.
 */

const BASELINE_TARGET_MILLISECONDS = 5;
const COVERAGE_TARGET_MILLISECONDS = 7;
const BENCHMARK_ENVIRONMENT_KEYS = [
  'HOME',
  'NODE_V8_COVERAGE',
  'TEMP',
  'TMP',
  'TMPDIR',
  'USERPROFILE',
  'WEFT_COVERAGE_MODE',
] as const;

function isWorkerSpawnMeasurement(value: unknown): value is WorkerSpawnMeasurement {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate['warmupSamples'] === 'number' &&
    Number.isInteger(candidate['warmupSamples']) &&
    candidate['warmupSamples'] >= 0 &&
    typeof candidate['measuredSamples'] === 'number' &&
    Number.isInteger(candidate['measuredSamples']) &&
    candidate['measuredSamples'] > 0 &&
    Array.isArray(candidate['samples']) &&
    candidate['samples'].every((sample) => typeof sample === 'number') &&
    typeof candidate['medianMilliseconds'] === 'number'
  );
}

function createBenchmarkEnvironment(): Record<string, string> {
  const environment: Record<string, string> = {};

  for (const key of BENCHMARK_ENVIRONMENT_KEYS) {
    const value = process.env[key];
    if (typeof value === 'string') {
      environment[key] = value;
    }
  }

  return environment;
}

function runWorkerSpawnBenchmark(): WorkerSpawnMeasurement {
  const result = Bun.spawnSync([process.execPath, 'run', 'src/benchmarks/worker-spawn-runner.ts'], {
    cwd: process.cwd(),
    stdout: 'pipe',
    stderr: 'pipe',
    env: createBenchmarkEnvironment(),
  });

  if (result.exitCode !== 0) {
    const errorOutput = new TextDecoder().decode(result.stderr).trim();
    throw new Error(`Worker spawn benchmark subprocess failed: ${errorOutput}`);
  }

  const parsed = JSON.parse(new TextDecoder().decode(result.stdout)) as unknown;
  if (!isWorkerSpawnMeasurement(parsed)) {
    throw new Error('Worker spawn benchmark subprocess returned an invalid measurement payload');
  }

  return parsed;
}

describe('Worker spawn latency', () => {
  it(`worker spawn median stays below ${(isCoverageInstrumentationEnabled()
    ? COVERAGE_TARGET_MILLISECONDS
    : BASELINE_TARGET_MILLISECONDS
  ).toFixed(0)}ms`, async () => {
    const measurement = runWorkerSpawnBenchmark();
    const targetMilliseconds = isCoverageInstrumentationEnabled()
      ? COVERAGE_TARGET_MILLISECONDS
      : BASELINE_TARGET_MILLISECONDS;

    console.log(
      [
        `\n  Worker spawn latency benchmark:`,
        `    Warmup samples:  ${measurement.warmupSamples.toLocaleString()}`,
        `    Measured:        ${measurement.measuredSamples.toLocaleString()}`,
        `    Samples (ms):    ${measurement.samples.map((sample) => sample.toFixed(2)).join(', ')}`,
        `    Median (ms):     ${measurement.medianMilliseconds.toFixed(2)}`,
        `    Target (ms):     <${targetMilliseconds.toFixed(2)}`,
        `    Coverage mode:   ${isCoverageInstrumentationEnabled() ? 'yes' : 'no'}\n`,
      ].join('\n'),
    );

    expect(measurement.medianMilliseconds).toBeLessThan(targetMilliseconds);
  }, 30_000);
});
