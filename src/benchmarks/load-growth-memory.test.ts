import { describe, expect, it } from 'bun:test';
import { fileURLToPath } from 'node:url';

import type { LoadGrowthMemoryMeasurement } from './load-growth-memory-runner.ts';

const TARGET_WORKFLOWS_PER_SECOND = 10_000;
const MAX_RSS_GROWTH_BYTES_PER_SECOND = 256 * 1024;
const SAMPLE_INTERVAL_MILLISECONDS = 250;
const WARMUP_SAMPLES = 4;
const RUN_DURATION_MILLISECONDS = 6_000;
const BENCHMARK_ENVIRONMENT_KEYS = [
  'HOME',
  'NODE_V8_COVERAGE',
  'TEMP',
  'TMP',
  'TMPDIR',
  'USERPROFILE',
  'WEFT_COVERAGE_MODE',
] as const;
const loadGrowthMemoryRunnerPath = fileURLToPath(
  new URL('./load-growth-memory-runner.ts', import.meta.url),
);

function isPositiveFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function hasValidSampleCounts(candidate: Record<string, unknown>): boolean {
  return (
    isNonNegativeInteger(candidate['warmupSamples']) &&
    isPositiveFiniteNumber(candidate['samplesCollected']) &&
    candidate['samplesCollected'] > candidate['warmupSamples']
  );
}

function isLoadGrowthMemoryMeasurement(value: unknown): value is LoadGrowthMemoryMeasurement {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return (
    isPositiveFiniteNumber(candidate['durationMilliseconds']) &&
    isPositiveFiniteNumber(candidate['sampleIntervalMilliseconds']) &&
    hasValidSampleCounts(candidate) &&
    isPositiveFiniteNumber(candidate['totalWorkflows']) &&
    isPositiveFiniteNumber(candidate['workflowsPerSecond']) &&
    typeof candidate['stable'] === 'boolean' &&
    typeof candidate['rssGrowthRatePerSecond'] === 'number' &&
    Number.isFinite(candidate['rssGrowthRatePerSecond']) &&
    isPositiveFiniteNumber(candidate['rssGrowthThresholdPerSecond']) &&
    isPositiveFiniteNumber(candidate['peakRss']) &&
    isPositiveFiniteNumber(candidate['averageRss'])
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

function runLoadGrowthMemoryBenchmark(): LoadGrowthMemoryMeasurement {
  const result = Bun.spawnSync(
    [
      process.execPath,
      'run',
      loadGrowthMemoryRunnerPath,
      String(RUN_DURATION_MILLISECONDS),
      String(TARGET_WORKFLOWS_PER_SECOND),
      String(SAMPLE_INTERVAL_MILLISECONDS),
      String(WARMUP_SAMPLES),
      String(MAX_RSS_GROWTH_BYTES_PER_SECOND),
    ],
    {
      cwd: process.cwd(),
      stdout: 'pipe',
      stderr: 'pipe',
      env: createBenchmarkEnvironment(),
    },
  );

  if (result.exitCode !== 0) {
    const errorOutput = new TextDecoder().decode(result.stderr).trim();
    throw new Error(`Load-growth memory benchmark subprocess failed: ${errorOutput}`);
  }

  const outputLines = new TextDecoder()
    .decode(result.stdout)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const lastOutputLine = outputLines.at(-1);
  if (lastOutputLine === undefined) {
    throw new Error('Load-growth memory benchmark subprocess produced no measurement output');
  }

  const parsed = JSON.parse(lastOutputLine) as unknown;
  if (!isLoadGrowthMemoryMeasurement(parsed)) {
    throw new Error('Load-growth memory benchmark subprocess returned an invalid payload');
  }

  return parsed;
}

describe('Load-growth memory stability', () => {
  it('acceptance criterion: No unbounded growth under load. Memory profiling over 1 hour of sustained 10K workflows/sec shows stable RSS.', async () => {
    const measurement = runLoadGrowthMemoryBenchmark();

    console.log(
      [
        `\n  Load-growth memory benchmark:`,
        `    Duration (ms):   ${measurement.durationMilliseconds.toLocaleString()}`,
        `    Sample interval: ${measurement.sampleIntervalMilliseconds.toLocaleString()}`,
        `    Warmup samples:  ${measurement.warmupSamples.toLocaleString()}`,
        `    Samples kept:    ${measurement.samplesCollected.toLocaleString()}`,
        `    Workflows:       ${measurement.totalWorkflows.toLocaleString()}`,
        `    Throughput/sec:  ${measurement.workflowsPerSecond.toLocaleString()}`,
        `    RSS growth/sec:  ${measurement.rssGrowthRatePerSecond.toFixed(0)} bytes`,
        `    RSS threshold:   ${measurement.rssGrowthThresholdPerSecond.toLocaleString()} bytes`,
        `    Peak RSS:        ${measurement.peakRss.toLocaleString()} bytes`,
        `    Average RSS:     ${measurement.averageRss.toLocaleString()} bytes`,
        `    Stable RSS:      ${measurement.stable ? 'yes' : 'no'}\n`,
      ].join('\n'),
    );

    expect(measurement.workflowsPerSecond).toBeGreaterThanOrEqual(TARGET_WORKFLOWS_PER_SECOND);
    expect(measurement.stable).toBe(true);
    expect(Math.abs(measurement.rssGrowthRatePerSecond)).toBeLessThanOrEqual(
      measurement.rssGrowthThresholdPerSecond,
    );
  }, 60_000);
});
