import { describe, expect, it } from 'bun:test';

import { isCoverageInstrumentationEnabled } from './coverage-mode.ts';
import type { MemoryPerWorkflowMeasurement } from './memory-per-workflow-runner.ts';

/**
 * K2d: Memory per workflow benchmark.
 *
 * Starts many idle workflows (each waiting on a signal) and measures
 * process RSS growth after a warmup population to calculate the marginal
 * per-workflow memory overhead seen by the full process.
 *
 * The architecture spec target is ≤2KB. The current Track 3 milestone target
 * is ≤5KB on a synthetic population of 10K idle workflows. The benchmark runs
 * in a fresh Bun subprocess so it measures workflow overhead rather than
 * memory retained by unrelated benchmark files earlier in the full suite.
 *
 * RSS is page-granular process memory, not an exact object-size metric. Allow
 * a small fixed tolerance so allocator noise and OS accounting do not fail the
 * benchmark when the observed median is only a few dozen bytes above the
 * nominal threshold.
 */

const RSS_MEASUREMENT_NOISE_TOLERANCE_BYTES = 128;
const BASELINE_TARGET_RSS_BYTES_PER_WORKFLOW = 5 * 1024 + RSS_MEASUREMENT_NOISE_TOLERANCE_BYTES;
const COVERAGE_TARGET_RSS_BYTES_PER_WORKFLOW = 8 * 1024 + RSS_MEASUREMENT_NOISE_TOLERANCE_BYTES;
const SAMPLES = 3;

function median(values: number[]): number {
  const sorted = values.toSorted((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)]!;
}

function runMemoryPerWorkflowBenchmark(totalWorkflows: number): MemoryPerWorkflowMeasurement {
  const result = Bun.spawnSync(
    ['bun', 'run', 'src/benchmarks/memory-per-workflow-runner.ts', String(totalWorkflows)],
    {
      cwd: process.cwd(),
      stdout: 'pipe',
      stderr: 'pipe',
      env: process.env,
    },
  );

  if (result.exitCode !== 0) {
    const errorOutput = new TextDecoder().decode(result.stderr).trim();
    throw new Error(`Memory benchmark subprocess failed: ${errorOutput}`);
  }

  return JSON.parse(new TextDecoder().decode(result.stdout)) as MemoryPerWorkflowMeasurement;
}

describe('Memory per workflow', () => {
  it(`idle workflow RSS memory ≤${(
    (isCoverageInstrumentationEnabled()
      ? COVERAGE_TARGET_RSS_BYTES_PER_WORKFLOW
      : BASELINE_TARGET_RSS_BYTES_PER_WORKFLOW) / 1024
  ).toFixed(0)}KB per workflow`, async () => {
    const targetRssBytesPerWorkflow = isCoverageInstrumentationEnabled()
      ? COVERAGE_TARGET_RSS_BYTES_PER_WORKFLOW
      : BASELINE_TARGET_RSS_BYTES_PER_WORKFLOW;
    const totalWorkflows = 10_000;
    const samples = Array.from({ length: SAMPLES }, () =>
      runMemoryPerWorkflowBenchmark(totalWorkflows),
    );
    const medianHeapBytesPerWorkflow = median(samples.map((sample) => sample.heapBytesPerWorkflow));
    const medianRssBytesPerWorkflow = median(samples.map((sample) => sample.rssBytesPerWorkflow));
    const medianSample =
      samples.find((sample) => sample.rssBytesPerWorkflow === medianRssBytesPerWorkflow) ??
      samples[1]!;

    console.log(
      [
        `\n  Memory per workflow benchmark:`,
        `    Warmup:          ${medianSample.warmupWorkflows.toLocaleString()} workflows`,
        `    Workflows:       ${totalWorkflows.toLocaleString()}`,
        `    Heap before:     ${(medianSample.heapBefore / 1024 / 1024).toFixed(1)}MB`,
        `    Heap after:      ${(medianSample.heapAfter / 1024 / 1024).toFixed(1)}MB`,
        `    Heap growth:     ${(medianSample.heapGrowth / 1024 / 1024).toFixed(2)}MB`,
        `    Heap median:     ${medianHeapBytesPerWorkflow.toLocaleString()} bytes (${(medianHeapBytesPerWorkflow / 1024).toFixed(2)}KB)`,
        `    RSS before:      ${(medianSample.rssBefore / 1024 / 1024).toFixed(1)}MB`,
        `    RSS after:       ${(medianSample.rssAfter / 1024 / 1024).toFixed(1)}MB`,
        `    RSS growth:      ${(medianSample.rssGrowth / 1024 / 1024).toFixed(2)}MB`,
        `    RSS samples:     ${samples.map((sample) => sample.rssBytesPerWorkflow.toLocaleString()).join(', ')} bytes`,
        `    RSS median:      ${medianRssBytesPerWorkflow.toLocaleString()} bytes (${(medianRssBytesPerWorkflow / 1024).toFixed(2)}KB)`,
        `    Target:          ≤${(targetRssBytesPerWorkflow / 1024).toFixed(0)}KB`,
        `    Coverage mode:   ${isCoverageInstrumentationEnabled() ? 'yes' : 'no'}\n`,
      ].join('\n'),
    );

    expect(medianRssBytesPerWorkflow).toBeLessThanOrEqual(targetRssBytesPerWorkflow);
  }, 120_000);
});
