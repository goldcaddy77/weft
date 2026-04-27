import { describe, expect, it } from 'bun:test';

import type { ActivityCompletionMeasurement } from './activity-completions-runner.ts';
import { isCoverageInstrumentationEnabled } from './coverage-mode.ts';

/**
 * K2b: Activity completion throughput benchmark.
 *
 * Registers a workflow that performs many trivial activity completions,
 * starts enough workflows to produce a fixed total number of completions,
 * waits for all of them to finish, and measures activity completions/sec.
 *
 * Architecture target: 30K/sec. Track 3 acceptance target: 20K/sec.
 * Measured 2026-04-11: ~10K/sec on Apple Silicon (up from ~9K/sec baseline).
 * Optimizations applied so far: completion state write and attribute cleanup
 * batched into a single storage transaction, scheduler cancel made
 * fire-and-forget for terminal workflows, `#cleanupWorkflowStorage` and
 * `#cleanupReviews` now use `deletePrefix` instead of scan-then-delete loops.
 * The remaining gap was terminal scratch cleanup still running on the hot
 * path. This benchmark now enforces the Track 3 threshold after deferring
 * that durable cleanup behind the scheduler.
 *
 * Coverage mode keeps a lower floor because instrumentation overhead changes
 * the absolute number materially. The non-coverage path enforces the Track 3
 * acceptance target.
 *
 * The harness intentionally amortizes workflow-start overhead by distributing
 * many activity completions across fewer workflows. This keeps the
 * benchmark focused on the completion path instead of mostly measuring
 * sequential `engine.start()` latency, which has a separate architecture
 * target.
 */

const SAMPLES = 5;
const BASELINE_TARGET_COMPLETIONS_PER_SECOND = 20_000;
const COVERAGE_TARGET_COMPLETIONS_PER_SECOND = process.env['CI'] ? 10_000 : 12_000;
const TOTAL_WORKFLOWS = 250;
const ACTIVITIES_PER_WORKFLOW = 30;
const TOTAL_ACTIVITY_COMPLETIONS = TOTAL_WORKFLOWS * ACTIVITIES_PER_WORKFLOW;
const START_BATCH_SIZE = 250;

function percentile(sorted: number[], fraction: number): number {
  if (sorted.length === 0) {
    return 0;
  }

  const index = Math.min(sorted.length - 1, Math.floor(sorted.length * fraction));
  return sorted[index]!;
}

function runActivityCompletionBenchmark(
  totalWorkflows: number,
  activitiesPerWorkflow: number,
  startBatchSize: number,
): ActivityCompletionMeasurement {
  const result = Bun.spawnSync(
    [
      'bun',
      'run',
      'src/benchmarks/activity-completions-runner.ts',
      String(totalWorkflows),
      String(activitiesPerWorkflow),
      String(startBatchSize),
    ],
    {
      cwd: process.cwd(),
      stdout: 'pipe',
      stderr: 'pipe',
      env: process.env,
    },
  );

  if (result.exitCode !== 0) {
    const errorOutput = new TextDecoder().decode(result.stderr).trim();
    throw new Error(`Activity completion benchmark subprocess failed: ${errorOutput}`);
  }

  return JSON.parse(new TextDecoder().decode(result.stdout)) as ActivityCompletionMeasurement;
}

describe('Activity completion throughput', () => {
  it(`completions exceed ${(isCoverageInstrumentationEnabled()
    ? COVERAGE_TARGET_COMPLETIONS_PER_SECOND
    : BASELINE_TARGET_COMPLETIONS_PER_SECOND
  ).toLocaleString()}/sec`, async () => {
    const targetCompletionsPerSecond = isCoverageInstrumentationEnabled()
      ? COVERAGE_TARGET_COMPLETIONS_PER_SECOND
      : BASELINE_TARGET_COMPLETIONS_PER_SECOND;
    const samples: number[] = [];

    // Warm the subprocess runner once so the sampled runs measure the engine's
    // steady-state hot path instead of Bun's first-run transpilation/cache
    // setup cost.
    runActivityCompletionBenchmark(TOTAL_WORKFLOWS, ACTIVITIES_PER_WORKFLOW, START_BATCH_SIZE);

    for (let sample = 0; sample < SAMPLES; sample += 1) {
      samples.push(
        runActivityCompletionBenchmark(TOTAL_WORKFLOWS, ACTIVITIES_PER_WORKFLOW, START_BATCH_SIZE)
          .completionsPerSecond,
      );
    }

    samples.sort((left, right) => left - right);
    const medianCompletionsPerSecond = percentile(samples, 0.5);

    console.log(
      [
        `\n  Activity completion throughput benchmark:`,
        `    Total workflows: ${TOTAL_WORKFLOWS.toLocaleString()}`,
        `    Activities per workflow: ${ACTIVITIES_PER_WORKFLOW.toLocaleString()}`,
        `    Total completions: ${TOTAL_ACTIVITY_COMPLETIONS.toLocaleString()}`,
        `    Start batch size: ${START_BATCH_SIZE.toLocaleString()}`,
        `    Samples:         ${samples.map((sample) => sample.toLocaleString()).join(', ')}`,
        `    Median/sec:      ${medianCompletionsPerSecond.toLocaleString()}`,
        `    Target:          ${targetCompletionsPerSecond.toLocaleString()}`,
        `    Coverage mode:   ${isCoverageInstrumentationEnabled() ? 'yes' : 'no'}`,
        `    Spec target:     30,000`,
        `    Headroom:        ${((medianCompletionsPerSecond / targetCompletionsPerSecond) * 100 - 100).toFixed(0)}%\n`,
      ].join('\n'),
    );

    expect(medianCompletionsPerSecond).toBeGreaterThanOrEqual(targetCompletionsPerSecond);
  }, 120_000);
});
