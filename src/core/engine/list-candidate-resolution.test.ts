import { describe, expect, it } from 'bun:test';

import type { ScanOptions } from '../../storage/interface.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import { Engine } from '../engine.ts';

class ScanCountingStorage extends MemoryStorage {
  readonly scanCounts = new Map<string, number>();

  override async *scan(prefix: string, options?: ScanOptions): AsyncIterable<[string, Uint8Array]> {
    this.scanCounts.set(prefix, (this.scanCounts.get(prefix) ?? 0) + 1);
    yield* super.scan(prefix, options);
  }

  resetScanCounts(): void {
    this.scanCounts.clear();
  }

  countScans(prefix: string): number {
    return this.scanCounts.get(prefix) ?? 0;
  }
}

function resourceFailure(): Error {
  const error = new Error('quota exceeded');
  error.name = 'ResourceExhaustedError';
  return error;
}

function timeoutFailure(): Error {
  const error = new Error('timed out');
  error.name = 'TimeoutError';
  return error;
}

async function createFailedWorkflows(engine: Engine): Promise<void> {
  engine.register('application-failure', async function* () {
    throw new Error('application failed');
  });
  engine.register('resource-failure', async function* () {
    throw resourceFailure();
  });
  engine.register('timeout-failure', async function* () {
    throw timeoutFailure();
  });

  const applicationHandle = await engine.start('application-failure', null, {
    id: 'application-1',
  });
  await expect(applicationHandle.result()).rejects.toThrow('application failed');

  const resourceHandle = await engine.start('resource-failure', null, { id: 'resource-1' });
  await expect(resourceHandle.result()).rejects.toThrow('quota exceeded');

  const timeoutHandle = await engine.start('timeout-failure', null, { id: 'timeout-1' });
  await expect(timeoutHandle.result()).rejects.toThrow('timed out');
}

describe('resolveListCandidateIds', () => {
  it('uses the failureCategory search-attribute index for scalar list filters', async () => {
    const storage = new ScanCountingStorage();
    const engine = new Engine({ storage });
    await createFailedWorkflows(engine);
    storage.resetScanCounts();

    const result = await engine.list({ failureCategory: 'application' });

    expect(result.items.map((item) => item.id)).toEqual(['application-1']);
    expect(storage.countScans('wf:')).toBe(0);
    expect(storage.countScans('idx:failureCategory:s:application:')).toBe(1);
    engine[Symbol.dispose]();
  });

  it('unions failureCategory search-attribute candidates for array list filters', async () => {
    const storage = new ScanCountingStorage();
    const engine = new Engine({ storage });
    await createFailedWorkflows(engine);
    storage.resetScanCounts();

    const result = await engine.list({ failureCategory: ['application', 'resource'] });

    expect(new Set(result.items.map((item) => item.id))).toEqual(
      new Set(['application-1', 'resource-1']),
    );
    expect(storage.countScans('wf:')).toBe(0);
    expect(storage.countScans('idx:failureCategory:s:application:')).toBe(1);
    expect(storage.countScans('idx:failureCategory:s:resource:')).toBe(1);
    engine[Symbol.dispose]();
  });

  it('uses indexed failureCategory candidates for aggregate filters', async () => {
    const storage = new ScanCountingStorage();
    const engine = new Engine({ storage });
    await createFailedWorkflows(engine);
    storage.resetScanCounts();

    const result = await engine.aggregate(
      { failureCategory: ['application', 'resource'] },
      { groupBy: 'failureCategory' },
    );

    expect(result).toEqual({
      total: 2,
      groups: [
        { key: 'application', count: 1 },
        { key: 'resource', count: 1 },
      ],
      truncated: false,
    });
    expect(storage.countScans('wf:')).toBe(0);
    expect(storage.countScans('idx:failureCategory:s:application:')).toBe(1);
    expect(storage.countScans('idx:failureCategory:s:resource:')).toBe(1);
    engine[Symbol.dispose]();
  });
});
