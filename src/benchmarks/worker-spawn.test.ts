import { describe, expect, it } from 'bun:test';

import { isCoverageInstrumentationEnabled } from './coverage-mode.ts';

/**
 * K2f: Worker spawn benchmark.
 *
 * Measures end-to-end worker spawn latency from `new Worker(...)` through the
 * first successful postMessage round-trip. The benchmark uses the existing
 * echo worker fixture so it measures an observable readiness boundary rather
 * than just constructor overhead.
 *
 * Architecture target: <5ms median on Bun in isolated direct runs.
 *
 * Re-measured on April 29, 2026, isolated direct runs cluster around ~3ms,
 * while default full-suite `bun test` concurrency can push the same
 * round-trip into the mid-5ms range on this machine. The regression floor
 * below is calibrated to the verification environment rather than the
 * aspirational architecture target.
 *
 * Coverage mode gets a slightly looser floor because instrumentation adds
 * measurable overhead to worker bootstrap and message dispatch.
 */

const workerUrl = new URL('../workers/test-worker.ts', import.meta.url);
const WARMUP_SAMPLES = 5;
const MEASURED_SAMPLES = 20;
const BASELINE_TARGET_MILLISECONDS = 7;
const COVERAGE_TARGET_MILLISECONDS = 9;

function median(values: number[]): number {
  const sorted = values.toSorted((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)]!;
}

async function measureWorkerSpawnRoundTrip(): Promise<number> {
  const worker = new Worker(workerUrl);

  try {
    const start = performance.now();

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error('Worker spawn benchmark timed out')),
        1_000,
      );

      const handleMessage = (): void => {
        clearTimeout(timeout);
        resolve();
      };

      const handleError = (): void => {
        clearTimeout(timeout);
        reject(new Error('Worker spawn benchmark worker error'));
      };

      worker.addEventListener('message', handleMessage, { once: true });
      worker.addEventListener('error', handleError, { once: true });
      worker.postMessage('ready');
    });

    return performance.now() - start;
  } finally {
    worker.terminate();
  }
}

describe('Worker spawn latency', () => {
  it(`worker spawn median stays below ${(isCoverageInstrumentationEnabled()
    ? COVERAGE_TARGET_MILLISECONDS
    : BASELINE_TARGET_MILLISECONDS
  ).toFixed(0)}ms`, async () => {
    for (let sample = 0; sample < WARMUP_SAMPLES; sample += 1) {
      await measureWorkerSpawnRoundTrip();
    }

    const samples: number[] = [];
    for (let sample = 0; sample < MEASURED_SAMPLES; sample += 1) {
      samples.push(await measureWorkerSpawnRoundTrip());
    }

    const medianMilliseconds = median(samples);
    const targetMilliseconds = isCoverageInstrumentationEnabled()
      ? COVERAGE_TARGET_MILLISECONDS
      : BASELINE_TARGET_MILLISECONDS;

    console.log(
      [
        `\n  Worker spawn latency benchmark:`,
        `    Warmup samples:  ${WARMUP_SAMPLES.toLocaleString()}`,
        `    Measured:        ${MEASURED_SAMPLES.toLocaleString()}`,
        `    Samples (ms):    ${samples.map((sample) => sample.toFixed(2)).join(', ')}`,
        `    Median (ms):     ${medianMilliseconds.toFixed(2)}`,
        `    Target (ms):     <${targetMilliseconds.toFixed(2)}`,
        `    Coverage mode:   ${isCoverageInstrumentationEnabled() ? 'yes' : 'no'}\n`,
      ].join('\n'),
    );

    expect(medianMilliseconds).toBeLessThan(targetMilliseconds);
  }, 30_000);
});
