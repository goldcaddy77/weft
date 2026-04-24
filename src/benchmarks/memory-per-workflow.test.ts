import { describe, expect, it } from 'bun:test';

import { isCoverageInstrumentationEnabled } from './coverage-mode.ts';
import type { MemoryPerWorkflowMeasurement } from './memory-per-workflow-runner.ts';

/**
 * K2d: Memory per workflow benchmark.
 *
 * Starts many idle workflows (each waiting on a signal) and measures
 * heap growth to calculate per-workflow memory overhead.
 *
 * The architecture spec target is ≤2KB. The current Track 3 milestone target
 * is ≤5KB on a synthetic population of 10K idle workflows. The benchmark runs
 * in a fresh Bun subprocess so it measures workflow overhead rather than heap
 * retained by unrelated benchmark files earlier in the full suite.
 */

const BASELINE_TARGET_BYTES_PER_WORKFLOW = 5 * 1024;
const COVERAGE_TARGET_BYTES_PER_WORKFLOW = 8 * 1024;

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
  it(`idle workflow memory ≤${(
    (isCoverageInstrumentationEnabled()
      ? COVERAGE_TARGET_BYTES_PER_WORKFLOW
      : BASELINE_TARGET_BYTES_PER_WORKFLOW) / 1024
  ).toFixed(0)}KB per workflow`, async () => {
    const targetBytesPerWorkflow = isCoverageInstrumentationEnabled()
      ? COVERAGE_TARGET_BYTES_PER_WORKFLOW
      : BASELINE_TARGET_BYTES_PER_WORKFLOW;
    const totalWorkflows = 10_000;
    const { heapBefore, heapAfter, heapGrowth, bytesPerWorkflow } =
      runMemoryPerWorkflowBenchmark(totalWorkflows);

    console.log(
      [
        `\n  Memory per workflow benchmark:`,
        `    Workflows:       ${totalWorkflows.toLocaleString()}`,
        `    Heap before:     ${(heapBefore / 1024 / 1024).toFixed(1)}MB`,
        `    Heap after:      ${(heapAfter / 1024 / 1024).toFixed(1)}MB`,
        `    Heap growth:     ${(heapGrowth / 1024 / 1024).toFixed(2)}MB`,
        `    Per workflow:    ${bytesPerWorkflow.toLocaleString()} bytes (${(bytesPerWorkflow / 1024).toFixed(2)}KB)`,
        `    Target:          ≤${(targetBytesPerWorkflow / 1024).toFixed(0)}KB`,
        `    Coverage mode:   ${isCoverageInstrumentationEnabled() ? 'yes' : 'no'}\n`,
      ].join('\n'),
    );

    expect(bytesPerWorkflow).toBeLessThanOrEqual(targetBytesPerWorkflow);
  }, 120_000);
});
