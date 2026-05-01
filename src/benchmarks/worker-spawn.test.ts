import { describe, expect, it } from 'bun:test';
import { fileURLToPath } from 'node:url';
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
 * inflate the measurement. Bun does not propagate `bun test --coverage`
 * instrumentation into `bun run`, so the child measurement path is the same in
 * covered and non-covered parent runs. This benchmark therefore enforces the
 * same `<5ms` architecture target in both modes instead of pretending the child
 * is running with extra coverage overhead.
 */

const TARGET_MILLISECONDS = 5;
const BENCHMARK_ENVIRONMENT_KEYS = [
  'HOME',
  'NODE_V8_COVERAGE',
  'TEMP',
  'TMP',
  'TMPDIR',
  'USERPROFILE',
  'WEFT_COVERAGE_MODE',
] as const;
const workerSpawnRunnerPath = fileURLToPath(new URL('./worker-spawn-runner.ts', import.meta.url));

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
    candidate['samples'].length === candidate['measuredSamples'] &&
    candidate['samples'].every((sample) => typeof sample === 'number' && Number.isFinite(sample)) &&
    typeof candidate['medianMilliseconds'] === 'number' &&
    Number.isFinite(candidate['medianMilliseconds'])
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
  const result = Bun.spawnSync([process.execPath, 'run', workerSpawnRunnerPath], {
    cwd: process.cwd(),
    stdout: 'pipe',
    stderr: 'pipe',
    env: createBenchmarkEnvironment(),
  });

  if (result.exitCode !== 0) {
    const errorOutput = new TextDecoder().decode(result.stderr).trim();
    throw new Error(`Worker spawn benchmark subprocess failed: ${errorOutput}`);
  }

  const outputLines = new TextDecoder()
    .decode(result.stdout)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const lastOutputLine = outputLines.at(-1);
  if (lastOutputLine === undefined) {
    throw new Error('Worker spawn benchmark subprocess produced no measurement output');
  }

  const parsed = JSON.parse(lastOutputLine) as unknown;
  if (!isWorkerSpawnMeasurement(parsed)) {
    throw new Error('Worker spawn benchmark subprocess returned an invalid measurement payload');
  }

  return parsed;
}

describe('Worker spawn latency', () => {
  it(`worker spawn median stays below ${TARGET_MILLISECONDS.toFixed(0)}ms`, async () => {
    const measurement = runWorkerSpawnBenchmark();

    console.log(
      [
        `\n  Worker spawn latency benchmark:`,
        `    Warmup samples:  ${measurement.warmupSamples.toLocaleString()}`,
        `    Measured:        ${measurement.measuredSamples.toLocaleString()}`,
        `    Samples (ms):    ${measurement.samples.map((sample) => sample.toFixed(2)).join(', ')}`,
        `    Median (ms):     ${measurement.medianMilliseconds.toFixed(2)}`,
        `    Target (ms):     <${TARGET_MILLISECONDS.toFixed(2)}`,
        `    Child coverage:  no (Bun does not cover \`bun run\` subprocesses)\n`,
      ].join('\n'),
    );

    expect(measurement.medianMilliseconds).toBeLessThan(TARGET_MILLISECONDS);
  }, 30_000);
});
