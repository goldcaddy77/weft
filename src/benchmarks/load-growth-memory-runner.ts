import { Engine } from '../core/engine.ts';
import type { StepWorkflowContext } from '../core/types.ts';
import type { MemorySample } from '../diagnostics/memory-profiler.ts';
import { MemoryProfiler, linearRegression } from '../diagnostics/memory-profiler.ts';
import { BunSQLiteStorage } from '../storage/bun-sql.ts';

const DEFAULT_DURATION_MILLISECONDS = 12_000;
const DEFAULT_SAMPLE_INTERVAL_MILLISECONDS = 500;
const DEFAULT_WARMUP_SAMPLES = 4;
const DEFAULT_BATCH_SIZE = 500;
const DEFAULT_WARMUP_WORKFLOWS = 2_500;
const DEFAULT_RETENTION_DURATION_MILLISECONDS = 0;
const DEFAULT_RETENTION_SWEEP_INTERVAL = '25ms';
const DEFAULT_RETENTION_SWEEP_BATCH_SIZE = 10_000;

export type LoadGrowthMemoryMeasurement = {
  configuredDurationMilliseconds: number;
  measuredDurationMilliseconds: number;
  sampleIntervalMilliseconds: number;
  workflowBatchSize: number;
  warmupSamples: number;
  samplesAnalyzed: number;
  samplesCollected: number;
  totalWorkflows: number;
  workflowsPerSecond: number;
  rssGrowthRatePerSecond: number;
  peakRss: number;
  averageRss: number;
  postWarmupRssDeltaBytes: number;
  postWarmupRssRangeBytes: number;
};

type BenchmarkConfiguration = {
  durationMilliseconds: number;
};

function parsePositiveInteger(
  rawValue: string | undefined,
  fallback: number,
  label: string,
): number {
  if (rawValue === undefined) {
    return fallback;
  }

  const parsed = Number(rawValue);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }

  return parsed;
}

function loadConfiguration(argv: string[]): BenchmarkConfiguration {
  return {
    durationMilliseconds: parsePositiveInteger(
      argv[2],
      DEFAULT_DURATION_MILLISECONDS,
      'durationMilliseconds',
    ),
  };
}

async function completeWorkflowBatch(
  engine: Engine,
  workflowStartIndex: number,
  workflowBatchSize: number,
): Promise<void> {
  const startPromises = [];

  for (let index = 0; index < workflowBatchSize; index += 1) {
    startPromises.push(engine.start('noop', workflowStartIndex + index));
  }

  const handles = await Promise.all(startPromises);
  await Promise.all(handles.map((handle) => handle.result()));
}

async function runWarmup(engine: Engine): Promise<void> {
  for (
    let workflowStartIndex = 0;
    workflowStartIndex < DEFAULT_WARMUP_WORKFLOWS;
    workflowStartIndex += DEFAULT_BATCH_SIZE
  ) {
    const workflowBatchSize = Math.min(
      DEFAULT_BATCH_SIZE,
      DEFAULT_WARMUP_WORKFLOWS - workflowStartIndex,
    );
    await completeWorkflowBatch(engine, workflowStartIndex, workflowBatchSize);
  }

  if (typeof Bun.gc === 'function') {
    Bun.gc(true);
  }
}

function summarizeSamples(samples: MemorySample[]): {
  peakRss: number;
  averageRss: number;
  postWarmupRssDeltaBytes: number;
  postWarmupRssRangeBytes: number;
  samplesAnalyzed: number;
} {
  let peakRss = 0;
  let totalRss = 0;

  for (const sample of samples) {
    peakRss = Math.max(peakRss, sample.rss);
    totalRss += sample.rss;
  }

  const analyzedSamples = samples.slice(DEFAULT_WARMUP_SAMPLES);
  const analyzedRssValues = analyzedSamples.map((sample) => sample.rss);
  const firstRss = analyzedRssValues[0] ?? 0;
  const lastRss = analyzedRssValues.at(-1) ?? firstRss;

  return {
    peakRss,
    averageRss: samples.length === 0 ? 0 : Math.round(totalRss / samples.length),
    postWarmupRssDeltaBytes: lastRss - firstRss,
    postWarmupRssRangeBytes:
      analyzedRssValues.length === 0
        ? 0
        : Math.max(...analyzedRssValues) - Math.min(...analyzedRssValues),
    samplesAnalyzed: analyzedSamples.length,
  };
}

function calculateRssGrowthRatePerSecond(samples: MemorySample[]): number {
  const analyzedSamples = samples.slice(DEFAULT_WARMUP_SAMPLES);
  if (analyzedSamples.length <= 1) {
    return 0;
  }

  const baselineTimestamp = analyzedSamples[0]!.timestamp;
  const points: [number, number][] = [];

  for (const sample of analyzedSamples) {
    points.push([(sample.timestamp - baselineTimestamp) / 1000, sample.rss]);
  }

  return linearRegression(points).slope;
}

async function runSustainedLoad(
  engine: Engine,
  profiler: MemoryProfiler,
  durationMilliseconds: number,
  sampleIntervalMilliseconds: number,
): Promise<{ elapsedMilliseconds: number; samples: MemorySample[]; totalWorkflows: number }> {
  const startedAt = performance.now();
  const deadline = startedAt + durationMilliseconds;
  const samples: MemorySample[] = [profiler.snapshot()];
  let lastSampleTimestamp = samples[0]!.timestamp;
  let totalWorkflows = 0;

  while (performance.now() < deadline) {
    await completeWorkflowBatch(engine, totalWorkflows, DEFAULT_BATCH_SIZE);
    totalWorkflows += DEFAULT_BATCH_SIZE;

    if (Date.now() - lastSampleTimestamp >= sampleIntervalMilliseconds) {
      const sample = profiler.snapshot();
      samples.push(sample);
      lastSampleTimestamp = sample.timestamp;
    }

    await Bun.sleep(0);
  }

  samples.push(profiler.snapshot());

  const elapsedMilliseconds = Math.max(1, performance.now() - startedAt);

  return { totalWorkflows, elapsedMilliseconds, samples };
}

export async function measureLoadGrowthMemory(
  configuration: BenchmarkConfiguration,
): Promise<LoadGrowthMemoryMeasurement> {
  const storage = new BunSQLiteStorage(':memory:');
  const engine = new Engine({
    storage,
    retention: {
      cancelled: DEFAULT_RETENTION_DURATION_MILLISECONDS,
      completed: DEFAULT_RETENTION_DURATION_MILLISECONDS,
      failed: DEFAULT_RETENTION_DURATION_MILLISECONDS,
      timedOut: DEFAULT_RETENTION_DURATION_MILLISECONDS,
    },
    retentionSweepBatchSize: DEFAULT_RETENTION_SWEEP_BATCH_SIZE,
    retentionSweepInterval: DEFAULT_RETENTION_SWEEP_INTERVAL,
  });

  try {
    engine.register('noop', async (_context: StepWorkflowContext, input: unknown) => {
      return input;
    });

    await runWarmup(engine);

    const profiler = new MemoryProfiler();
    const { totalWorkflows, elapsedMilliseconds, samples } = await runSustainedLoad(
      engine,
      profiler,
      configuration.durationMilliseconds,
      DEFAULT_SAMPLE_INTERVAL_MILLISECONDS,
    );
    const summary = summarizeSamples(samples);
    const rssGrowthRatePerSecond = calculateRssGrowthRatePerSecond(samples);

    return {
      configuredDurationMilliseconds: configuration.durationMilliseconds,
      measuredDurationMilliseconds: Math.max(
        configuration.durationMilliseconds,
        Math.round(elapsedMilliseconds),
      ),
      sampleIntervalMilliseconds: DEFAULT_SAMPLE_INTERVAL_MILLISECONDS,
      workflowBatchSize: DEFAULT_BATCH_SIZE,
      warmupSamples: DEFAULT_WARMUP_SAMPLES,
      samplesAnalyzed: summary.samplesAnalyzed,
      samplesCollected: samples.length,
      totalWorkflows,
      workflowsPerSecond: Math.round((totalWorkflows / elapsedMilliseconds) * 1000),
      rssGrowthRatePerSecond,
      peakRss: summary.peakRss,
      averageRss: summary.averageRss,
      postWarmupRssDeltaBytes: summary.postWarmupRssDeltaBytes,
      postWarmupRssRangeBytes: summary.postWarmupRssRangeBytes,
    };
  } finally {
    engine[Symbol.dispose]();
    storage[Symbol.dispose]();
  }
}

if (import.meta.main) {
  const measurement = await measureLoadGrowthMemory(loadConfiguration(Bun.argv));
  console.log(JSON.stringify(measurement));
}
