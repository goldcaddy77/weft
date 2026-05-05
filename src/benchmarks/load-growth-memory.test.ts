import { describe, expect, it } from 'bun:test';
import { fileURLToPath } from 'node:url';

import { isConstrainedCodexRunner } from './benchmark-environment.ts';
import { runBenchmarkSubprocess } from './benchmark-subprocess.ts';
import type { LoadGrowthMemoryMeasurement } from './load-growth-memory-runner.ts';

const IS_CONSTRAINED_CODEX_RUNNER = isConstrainedCodexRunner();
const TARGET_WORKFLOWS_PER_SECOND = IS_CONSTRAINED_CODEX_RUNNER ? 500 : 10_000;
const MAX_MEDIAN_RSS_GROWTH_BYTES_PER_SECOND = (IS_CONSTRAINED_CODEX_RUNNER ? 5 : 1) * 1024 * 1024;
const MAX_MEDIAN_POST_WARMUP_RSS_DELTA_BYTES = (IS_CONSTRAINED_CODEX_RUNNER ? 32 : 8) * 1024 * 1024;
const MAX_MEDIAN_POST_WARMUP_RSS_RANGE_BYTES = (IS_CONSTRAINED_CODEX_RUNNER ? 64 : 8) * 1024 * 1024;
const MAX_POST_WARMUP_RSS_DELTA_BYTES = 64 * 1024 * 1024;
const MAX_POST_WARMUP_RSS_RANGE_BYTES = 64 * 1024 * 1024;
const SAMPLE_INTERVAL_MILLISECONDS = 500;
const WARMUP_SAMPLES = 4;
const WORKFLOW_BATCH_SIZE = 500;
const RUN_DURATION_MILLISECONDS = 12_000;
const TRIAL_COUNT = 3;
const loadGrowthMemoryRunnerPath = fileURLToPath(
  new URL('./load-growth-memory-runner.ts', import.meta.url),
);

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function hasValidSampleCounts(candidate: Record<string, unknown>): boolean {
  return (
    isNonNegativeInteger(candidate['warmupSamples']) &&
    isNonNegativeInteger(candidate['samplesCollected']) &&
    isNonNegativeInteger(candidate['samplesAnalyzed']) &&
    candidate['samplesCollected'] > candidate['warmupSamples'] &&
    candidate['samplesAnalyzed'] === candidate['samplesCollected'] - candidate['warmupSamples']
  );
}

function hasExpectedConfiguration(candidate: Record<string, unknown>): boolean {
  return (
    isNonNegativeInteger(candidate['configuredDurationMilliseconds']) &&
    candidate['configuredDurationMilliseconds'] === RUN_DURATION_MILLISECONDS &&
    isNonNegativeInteger(candidate['measuredDurationMilliseconds']) &&
    candidate['measuredDurationMilliseconds'] >= candidate['configuredDurationMilliseconds'] &&
    isNonNegativeInteger(candidate['sampleIntervalMilliseconds']) &&
    candidate['sampleIntervalMilliseconds'] === SAMPLE_INTERVAL_MILLISECONDS &&
    isNonNegativeInteger(candidate['workflowBatchSize']) &&
    candidate['workflowBatchSize'] === WORKFLOW_BATCH_SIZE &&
    isNonNegativeInteger(candidate['warmupSamples']) &&
    candidate['warmupSamples'] === WARMUP_SAMPLES
  );
}

function hasValidMeasurementSummary(candidate: Record<string, unknown>): boolean {
  return (
    hasValidSampleCounts(candidate) &&
    isNonNegativeInteger(candidate['totalWorkflows']) &&
    isNonNegativeInteger(candidate['workflowsPerSecond']) &&
    typeof candidate['rssGrowthRatePerSecond'] === 'number' &&
    Number.isFinite(candidate['rssGrowthRatePerSecond']) &&
    typeof candidate['postWarmupRssDeltaBytes'] === 'number' &&
    Number.isFinite(candidate['postWarmupRssDeltaBytes']) &&
    isNonNegativeInteger(candidate['postWarmupRssRangeBytes']) &&
    isNonNegativeInteger(candidate['peakRss']) &&
    isNonNegativeInteger(candidate['averageRss'])
  );
}

function isLoadGrowthMemoryMeasurement(value: unknown): value is LoadGrowthMemoryMeasurement {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return hasExpectedConfiguration(candidate) && hasValidMeasurementSummary(candidate);
}

function median(values: number[]): number {
  const sortedValues = values.toSorted((left, right) => left - right);
  const middleIndex = Math.floor(sortedValues.length / 2);
  if (sortedValues.length % 2 === 0) {
    return (sortedValues[middleIndex - 1]! + sortedValues[middleIndex]!) / 2;
  }

  return sortedValues[middleIndex]!;
}

function runLoadGrowthMemoryBenchmark(): LoadGrowthMemoryMeasurement {
  return runBenchmarkSubprocess({
    benchmarkName: 'Load-growth memory benchmark',
    runnerArguments: [String(RUN_DURATION_MILLISECONDS)],
    runnerPath: loadGrowthMemoryRunnerPath,
    validateMeasurement: isLoadGrowthMemoryMeasurement,
  });
}

describe('Load-growth memory stability', () => {
  it(`acceptance criterion: No unbounded growth under load. Short sustained-load regression benchmark keeps post-warmup RSS within a bounded band while sustaining ${TARGET_WORKFLOWS_PER_SECOND.toLocaleString()} workflows/sec.`, async () => {
    const measurements = Array.from({ length: TRIAL_COUNT }, () => runLoadGrowthMemoryBenchmark());
    const medianThroughput = median(
      measurements.map((measurement) => measurement.workflowsPerSecond),
    );
    const medianAbsoluteRssGrowthRatePerSecond = median(
      measurements.map((measurement) => Math.abs(measurement.rssGrowthRatePerSecond)),
    );
    const medianPostWarmupRssDeltaBytes = median(
      measurements.map((measurement) => Math.abs(measurement.postWarmupRssDeltaBytes)),
    );
    const medianPostWarmupRssRangeBytes = median(
      measurements.map((measurement) => measurement.postWarmupRssRangeBytes),
    );
    const maximumPostWarmupRssDeltaBytes = Math.max(
      ...measurements.map((measurement) => Math.abs(measurement.postWarmupRssDeltaBytes)),
    );
    const maximumPostWarmupRssRangeBytes = Math.max(
      ...measurements.map((measurement) => measurement.postWarmupRssRangeBytes),
    );

    console.log(
      [
        `\n  Load-growth memory benchmark:`,
        ...measurements.map(
          (measurement, index) =>
            `    Trial ${String(index + 1).padStart(2, ' ')}: ${measurement.workflowsPerSecond.toLocaleString()} workflows/sec, ` +
            `RSS slope ${Math.abs(measurement.rssGrowthRatePerSecond).toFixed(0)} bytes/sec, ` +
            `RSS delta ${Math.abs(measurement.postWarmupRssDeltaBytes).toLocaleString()} bytes, ` +
            `RSS band ${measurement.postWarmupRssRangeBytes.toLocaleString()} bytes`,
        ),
        `    Median throughput: ${medianThroughput.toLocaleString()} workflows/sec`,
        `    Median RSS slope:  ${medianAbsoluteRssGrowthRatePerSecond.toFixed(0)} bytes/sec`,
        `    Median RSS delta:  ${medianPostWarmupRssDeltaBytes.toLocaleString()} bytes`,
        `    Median RSS band:   ${medianPostWarmupRssRangeBytes.toLocaleString()} bytes`,
        `    Max RSS delta:     ${maximumPostWarmupRssDeltaBytes.toLocaleString()} bytes`,
        `    Max RSS band:      ${maximumPostWarmupRssRangeBytes.toLocaleString()} bytes\n`,
      ].join('\n'),
    );

    expect(medianThroughput).toBeGreaterThanOrEqual(TARGET_WORKFLOWS_PER_SECOND);
    expect(medianAbsoluteRssGrowthRatePerSecond).toBeLessThanOrEqual(
      MAX_MEDIAN_RSS_GROWTH_BYTES_PER_SECOND,
    );
    expect(medianPostWarmupRssDeltaBytes).toBeLessThanOrEqual(
      MAX_MEDIAN_POST_WARMUP_RSS_DELTA_BYTES,
    );
    expect(medianPostWarmupRssRangeBytes).toBeLessThanOrEqual(
      MAX_MEDIAN_POST_WARMUP_RSS_RANGE_BYTES,
    );
    expect(maximumPostWarmupRssDeltaBytes).toBeLessThanOrEqual(MAX_POST_WARMUP_RSS_DELTA_BYTES);
    expect(maximumPostWarmupRssRangeBytes).toBeLessThanOrEqual(MAX_POST_WARMUP_RSS_RANGE_BYTES);
  }, 120_000);
});
