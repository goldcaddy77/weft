import { Engine } from '../core/engine.ts';
import type { StepWorkflowContext } from '../core/types.ts';
import type { MemorySample } from '../diagnostics/memory-profiler.ts';
import { MemoryProfiler, analyzeStability } from '../diagnostics/memory-profiler.ts';
import { BunSQLiteStorage } from '../storage/bun-sql.ts';

const DEFAULT_DURATION_MILLISECONDS = 6_000;
const DEFAULT_TARGET_WORKFLOWS_PER_SECOND = 10_000;
const DEFAULT_SAMPLE_INTERVAL_MILLISECONDS = 250;
const DEFAULT_WARMUP_SAMPLES = 4;
const DEFAULT_MAX_RSS_GROWTH_BYTES_PER_SECOND = 256 * 1024;
const DEFAULT_BATCH_SIZE = 500;
const DEFAULT_GARBAGE_COLLECTION_INTERVAL_BATCHES = 3;
const DEFAULT_WARMUP_WORKFLOWS = 2_500;
const DEFAULT_RETENTION_DURATION_MILLISECONDS = 0;
const DEFAULT_RETENTION_SWEEP_INTERVAL = '1ms';
const DEFAULT_RETENTION_SWEEP_BATCH_SIZE = 10_000;

export type LoadGrowthMemoryMeasurement = {
  durationMilliseconds: number;
  sampleIntervalMilliseconds: number;
  warmupSamples: number;
  samplesCollected: number;
  totalWorkflows: number;
  workflowsPerSecond: number;
  stable: boolean;
  rssGrowthRatePerSecond: number;
  rssGrowthThresholdPerSecond: number;
  peakRss: number;
  averageRss: number;
};

type BenchmarkConfiguration = {
  durationMilliseconds: number;
  targetWorkflowsPerSecond: number;
  sampleIntervalMilliseconds: number;
  warmupSamples: number;
  maxRssGrowthBytesPerSecond: number;
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

function parseNonNegativeInteger(
  rawValue: string | undefined,
  fallback: number,
  label: string,
): number {
  if (rawValue === undefined) {
    return fallback;
  }

  const parsed = Number(rawValue);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${label} must be a non-negative integer`);
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
    targetWorkflowsPerSecond: parsePositiveInteger(
      argv[3],
      DEFAULT_TARGET_WORKFLOWS_PER_SECOND,
      'targetWorkflowsPerSecond',
    ),
    sampleIntervalMilliseconds: parsePositiveInteger(
      argv[4],
      DEFAULT_SAMPLE_INTERVAL_MILLISECONDS,
      'sampleIntervalMilliseconds',
    ),
    warmupSamples: parseNonNegativeInteger(argv[5], DEFAULT_WARMUP_SAMPLES, 'warmupSamples'),
    maxRssGrowthBytesPerSecond: parsePositiveInteger(
      argv[6],
      DEFAULT_MAX_RSS_GROWTH_BYTES_PER_SECOND,
      'maxRssGrowthBytesPerSecond',
    ),
  };
}

async function runWarmup(engine: Engine): Promise<void> {
  const handles = [];

  for (let index = 0; index < DEFAULT_WARMUP_WORKFLOWS; index += 1) {
    handles.push(await engine.start('noop', index));
  }

  await Promise.all(handles.map((handle) => handle.result()));
  Bun.gc(true);
}

function summarizeSamples(samples: MemorySample[]): { peakRss: number; averageRss: number } {
  let peakRss = 0;
  let totalRss = 0;

  for (const sample of samples) {
    peakRss = Math.max(peakRss, sample.rss);
    totalRss += sample.rss;
  }

  return {
    peakRss,
    averageRss: samples.length === 0 ? 0 : Math.round(totalRss / samples.length),
  };
}

async function runSustainedLoad(
  engine: Engine,
  profiler: MemoryProfiler,
  durationMilliseconds: number,
  targetWorkflowsPerSecond: number,
  sampleIntervalMilliseconds: number,
): Promise<{ elapsedMilliseconds: number; samples: MemorySample[]; totalWorkflows: number }> {
  const startedAt = performance.now();
  const deadline = startedAt + durationMilliseconds;
  const samples: MemorySample[] = [profiler.snapshot()];
  let lastSampleTimestamp = samples[0]!.timestamp;
  let totalWorkflows = 0;
  let batchCount = 0;
  const minimumBatchSize = Math.max(
    DEFAULT_BATCH_SIZE,
    Math.ceil((targetWorkflowsPerSecond * sampleIntervalMilliseconds) / 1000 / 2),
  );

  while (performance.now() < deadline) {
    const handles = [];

    for (let index = 0; index < minimumBatchSize; index += 1) {
      handles.push(await engine.start('noop', totalWorkflows + index));
    }

    totalWorkflows += minimumBatchSize;
    await Promise.all(handles.map((handle) => handle.result()));
    batchCount += 1;

    if (batchCount % DEFAULT_GARBAGE_COLLECTION_INTERVAL_BATCHES === 0) {
      Bun.gc(true);
    }

    const sample = profiler.snapshot();
    if (sample.timestamp - lastSampleTimestamp >= sampleIntervalMilliseconds) {
      samples.push(sample);
      lastSampleTimestamp = sample.timestamp;
    }

    await Bun.sleep(0);
  }

  Bun.gc(true);
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
      configuration.targetWorkflowsPerSecond,
      configuration.sampleIntervalMilliseconds,
    );

    const stability = analyzeStability(samples, {
      warmupSamples: configuration.warmupSamples,
      maxGrowthRatePerSecond: configuration.maxRssGrowthBytesPerSecond,
    });
    const summary = summarizeSamples(samples);

    return {
      durationMilliseconds: Math.max(
        configuration.durationMilliseconds,
        Math.round(elapsedMilliseconds),
      ),
      sampleIntervalMilliseconds: configuration.sampleIntervalMilliseconds,
      warmupSamples: configuration.warmupSamples,
      samplesCollected: samples.length,
      totalWorkflows,
      workflowsPerSecond: Math.round((totalWorkflows / elapsedMilliseconds) * 1000),
      stable: stability.stable,
      rssGrowthRatePerSecond: stability.rssGrowthRatePerSecond,
      rssGrowthThresholdPerSecond: stability.thresholdPerSecond,
      peakRss: summary.peakRss,
      averageRss: summary.averageRss,
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
