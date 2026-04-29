import { afterEach, describe, expect, it } from 'bun:test';

import type { Context } from '../core/context.ts';
import { Engine } from '../core/engine.ts';
import { TokenEvent } from '../core/events.ts';
import type { WorkflowContext } from '../core/types.ts';
import type { WeftServer } from '../server/index.ts';
import { serve } from '../server/index.ts';
import { MemoryStorage } from '../storage/memory.ts';
import { isCoverageInstrumentationEnabled } from './coverage-mode.ts';

/**
 * K2g: token stream latency benchmark.
 *
 * Measures median latency from `engine.dispatchEvent(new TokenEvent(...))` to
 * receipt on a live WebSocket client connected to
 * `WS /v1/workflows/:id/stream`.
 *
 * Architecture target: <10ms median.
 *
 * Coverage mode gets a looser threshold because instrumentation affects event
 * dispatch, JSON serialization, and the local WebSocket path. The regular
 * `bun test` path keeps the architecture threshold.
 */

const WARMUP_SAMPLES = 5;
const MEASURED_SAMPLES = 20;
const BASELINE_TARGET_MILLISECONDS = 10;
const COVERAGE_TARGET_MILLISECONDS = 15;

function median(values: number[]): number {
  const sorted = values.toSorted((left, right) => left - right);
  const middleIndex = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[middleIndex - 1]! + sorted[middleIndex]!) / 2;
  }

  return sorted[middleIndex]!;
}

function createEngine(): Engine {
  const storage = new MemoryStorage();
  const engine = new Engine({ storage });

  engine.register('echo', async function* (_ctx: WorkflowContext, input: unknown) {
    return input;
  });
  engine.register('stream-target', async function* (ctx: WorkflowContext) {
    yield* (ctx as Context).sleep('1h');
    return 'done';
  });

  return engine;
}

async function connectStream(server: WeftServer, workflowId: string): Promise<WebSocket> {
  const wsUrl = server.url.replace('http://', 'ws://');
  const ws = new WebSocket(`${wsUrl}/v1/workflows/${encodeURIComponent(workflowId)}/stream`);

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      ws.close();
      reject(new Error('Timed out opening WebSocket connection'));
    }, 1_000);

    ws.addEventListener(
      'open',
      () => {
        clearTimeout(timeout);
        resolve();
      },
      { once: true },
    );
    ws.addEventListener(
      'error',
      () => {
        clearTimeout(timeout);
        reject(new Error('WebSocket connection failed'));
      },
      {
        once: true,
      },
    );
  });

  return ws;
}

function isTokenMessage(
  value: unknown,
  expectedToken: string,
): value is { type: typeof TokenEvent.type; data: { token: string } } {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const record = value as Record<string, unknown>;
  if (record['type'] !== TokenEvent.type) {
    return false;
  }

  const data = record['data'];
  if (typeof data !== 'object' || data === null) {
    return false;
  }

  return (data as Record<string, unknown>)['token'] === expectedToken;
}

async function measureTokenLatency(
  engine: Engine,
  workflowId: string,
  streamSocket: WebSocket,
  token: string,
): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const sentAt = performance.now();
    let settled = false;

    const cleanup = (): void => {
      streamSocket.removeEventListener('message', handleMessage as EventListener);
      clearTimeout(timeout);
    };

    const finish = (result: { ok: true; latency: number } | { ok: false; error: Error }): void => {
      if (settled) {
        return;
      }

      settled = true;
      cleanup();

      if (result.ok) {
        resolve(result.latency);
      } else {
        reject(result.error);
      }
    };

    const handleMessage = (event: MessageEvent): void => {
      let payload: unknown;
      try {
        payload = JSON.parse(String(event.data));
      } catch {
        return;
      }

      if (!isTokenMessage(payload, token)) {
        return;
      }

      finish({ ok: true, latency: performance.now() - sentAt });
    };

    const timeout = setTimeout(
      () =>
        finish({
          ok: false,
          error: new Error(`Timed out waiting for token stream delivery: ${token}`),
        }),
      1_000,
    );

    streamSocket.addEventListener('message', handleMessage as EventListener);
    engine.dispatchEvent(new TokenEvent(workflowId, token, 'gpt-4'));
  });
}

describe('Token stream latency', () => {
  let engine: Engine;
  let server: WeftServer;
  let streamSocket: WebSocket | undefined;

  afterEach(async () => {
    streamSocket?.close();
    streamSocket = undefined;
    if (server) {
      await server.stop();
    }
    engine?.[Symbol.dispose]();
  });

  it(`stream delivery median stays below ${(isCoverageInstrumentationEnabled()
    ? COVERAGE_TARGET_MILLISECONDS
    : BASELINE_TARGET_MILLISECONDS
  ).toFixed(0)}ms`, async () => {
    engine = createEngine();
    server = serve({ engine, port: 0 });

    const handle = await engine.start('stream-target', 'hello');
    streamSocket = await connectStream(server, handle.id);
    await measureTokenLatency(engine, handle.id, streamSocket, '__stream-ready__');

    for (let sample = 0; sample < WARMUP_SAMPLES; sample += 1) {
      await measureTokenLatency(engine, handle.id, streamSocket, `warmup-${String(sample)}`);
      await Bun.sleep(5);
    }

    const samples: number[] = [];
    for (let sample = 0; sample < MEASURED_SAMPLES; sample += 1) {
      samples.push(
        await measureTokenLatency(engine, handle.id, streamSocket, `token-${String(sample)}`),
      );
      await Bun.sleep(5);
    }

    streamSocket.close();
    const medianMilliseconds = median(samples);
    const targetMilliseconds = isCoverageInstrumentationEnabled()
      ? COVERAGE_TARGET_MILLISECONDS
      : BASELINE_TARGET_MILLISECONDS;

    console.log(
      [
        `\n  Token stream latency benchmark:`,
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
