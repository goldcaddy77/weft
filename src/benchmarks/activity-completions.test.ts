import { describe, expect, it } from 'bun:test';

import { measureActivityCompletions } from './activity-completions-runner.ts';
import { isCoverageInstrumentationEnabled } from './coverage-mode.ts';

/**
 * K2b: Activity completion throughput benchmark.
 *
 * Registers a workflow that performs many trivial activity completions,
 * starts enough workflows to produce a fixed total number of completions,
 * waits for all of them to finish, and measures activity completions/sec.
 *
 * Architecture target: 30K/sec. The practical guardrail in this benchmark
 * is lower: re-measured on April 29, 2026, isolated direct runs on Apple
 * Silicon cluster around ~18K/sec, while the same workload under Bun's
 * default benchmark-suite concurrency clusters around ~14-16K/sec. The
 * threshold below is meant to catch real regressions in the current hot path,
 * not enforce the aspirational architecture target directly.
 *
 * Relative to the earlier ~9-10K/sec baseline, the completion state write and
 * attribute cleanup are now batched into a single storage transaction,
 * scheduler cancel is fire-and-forget for terminal workflows, and
 * `#cleanupWorkflowStorage` plus `#cleanupReviews` now use `deletePrefix`
 * instead of scan-then-delete loops. The remaining gap is still terminal
 * scratch cleanup on the hot path plus SQLite fsync cost.
 *
 * Coverage mode keeps a lower floor because instrumentation overhead changes
 * the absolute number materially. The non-coverage floor stays conservative so
 * default `bun test` parallelism does not turn the benchmark into noise.
 *
 * The harness intentionally amortizes workflow-start overhead by distributing
 * many activity completions across fewer workflows. It also aggregates several
 * fresh rounds per sample so each reported datapoint runs long enough to smooth
 * host noise without turning the measurement into a fundamentally different,
 * storage-growth-heavy workload.
 */

const SAMPLES = 5;
const BASELINE_TARGET_COMPLETIONS_PER_SECOND = 13_000;
const COVERAGE_TARGET_COMPLETIONS_PER_SECOND = process.env['CI'] ? 10_000 : 12_000;
const TOTAL_WORKFLOWS = 250;
const ACTIVITIES_PER_WORKFLOW = 30;
const MEASUREMENT_ROUNDS = 3;
const TOTAL_ACTIVITY_COMPLETIONS = TOTAL_WORKFLOWS * ACTIVITIES_PER_WORKFLOW * MEASUREMENT_ROUNDS;
const START_BATCH_SIZE = 250;

function percentile(sorted: number[], fraction: number): number {
  if (sorted.length === 0) {
    return 0;
  }

  const index = Math.min(sorted.length - 1, Math.floor(sorted.length * fraction));
  return sorted[index]!;
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
    // steady-state hot path instead of the first storage/statement warmup.
    await measureActivityCompletions(
      TOTAL_WORKFLOWS,
      ACTIVITIES_PER_WORKFLOW,
      START_BATCH_SIZE,
      MEASUREMENT_ROUNDS,
    );

    for (let sample = 0; sample < SAMPLES; sample += 1) {
      const measurement = await measureActivityCompletions(
        TOTAL_WORKFLOWS,
        ACTIVITIES_PER_WORKFLOW,
        START_BATCH_SIZE,
        MEASUREMENT_ROUNDS,
      );
      samples.push(measurement.completionsPerSecond);
    }

    samples.sort((left, right) => left - right);
    const medianCompletionsPerSecond = percentile(samples, 0.5);

    console.log(
      [
        `\n  Activity completion throughput benchmark:`,
        `    Total workflows: ${TOTAL_WORKFLOWS.toLocaleString()}`,
        `    Activities per workflow: ${ACTIVITIES_PER_WORKFLOW.toLocaleString()}`,
        `    Measurement rounds: ${MEASUREMENT_ROUNDS.toLocaleString()}`,
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
