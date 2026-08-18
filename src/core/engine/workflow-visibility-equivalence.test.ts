/**
 * The shippability bar for the visibility index: for every filter dimension
 * the index can narrow, `engine.list()` must return the SAME rows whether it
 * reads the index or falls back to the full keyspace scan.
 *
 * If those two paths can disagree, advancing the watermark converts a slow
 * listing into a silently under-reporting one, which is strictly worse. So
 * each case below builds one corpus, reads it twice — once with the
 * watermark dropped, once after a backfill — and asserts identical ids.
 */

import { describe, expect, it } from 'bun:test';

import { KEYS } from '../../storage/interface.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import { Engine } from '../engine.ts';
import type { ListFilter } from '../types.ts';
import { workflow } from '../types/workflow-function.ts';
import { getInternals } from './internals.ts';
import { getWorkflowVisibilityWatermark } from './workflow-indexes.ts';
import { verifyWorkflowVisibilityIndex } from './workflow-visibility-backfill.ts';

const completingWorkflow = workflow({ name: 'equivalence-complete' }).execute(async function* (
  _ctx,
  input: string,
) {
  return input;
});

const failingWorkflow = workflow({ name: 'equivalence-fail' }).execute(async function* () {
  throw new Error('equivalence failure');
});

const parkedWorkflow = workflow({ name: 'equivalence-parked' }).execute(async function* (ctx) {
  return yield* ctx.waitForSignal('release');
});

/**
 * A corpus deliberately mixed across every dimension the index narrows, and
 * mutated after creation so manifests must have been rewritten rather than
 * merely written once at start.
 */
async function buildCorpus(engine: Engine): Promise<void> {
  engine.register(completingWorkflow);
  engine.register(failingWorkflow);
  engine.register(parkedWorkflow);

  // Start every run before awaiting any of them. Awaiting a completed run
  // and only then starting the next one parks the inline launch queue in this
  // engine build, which has nothing to do with visibility indexes.
  const completed = await Promise.all([
    engine.start('equivalence-complete', 'a', { id: 'eq-complete-1' }),
    engine.start('equivalence-complete', 'b', { id: 'eq-complete-2' }),
    engine.start('equivalence-complete', 'c', { id: 'eq-complete-3' }),
  ]);
  const failed = await engine.start('equivalence-fail', null, { id: 'eq-fail-1' });

  // Running rows: started, left parked on a signal.
  await engine.start('equivalence-parked', null, { id: 'eq-running-1' });
  await engine.start('equivalence-parked', null, { id: 'eq-running-2' });

  for (const handle of completed) await handle.result();
  await expect(failed.result()).rejects.toThrow('equivalence failure');

  // Post-creation mutation: tags and attributes rewrite `updatedAt`, which
  // moves a row between `wf-idx-updated:` buckets. A backfill that only ever
  // added rows would leave the old bucket behind and the two paths would
  // disagree here.
  await engine.tagAll({ idPrefix: 'eq-complete-1' }, ['audited']);
  await engine.tagAll({ idPrefix: 'eq-running-1' }, ['audited', 'hot']);

  // A cancelled row, so the status dimension has a fourth value.
  await engine.start('equivalence-parked', null, { id: 'eq-cancelled-1' });
  await engine.cancel('eq-cancelled-1');
}

/**
 * Structural so the branded registry type returned by `Engine.create({ workflows })`
 * is accepted alongside a plain `new Engine()`.
 */
type ListableEngine = {
  list: (filter: ListFilter) => Promise<{ items: readonly { id: string }[] }>;
};

async function listIds(engine: ListableEngine, filter: ListFilter): Promise<string[]> {
  const result = await engine.list({ ...filter, limit: 200 });
  return result.items.map((item) => item.id).toSorted();
}

function expireWatermarkCache(engine: Engine): void {
  getInternals(engine).workflowVisibilityWatermark = undefined;
  getInternals(engine).workflowVisibilityWatermarkExpiresAt = undefined;
}

/** Read every filter twice — once scanning, once indexed — and compare. */
async function expectPathsAgree(
  engine: Engine,
  storage: MemoryStorage,
  filters: readonly ListFilter[],
): Promise<void> {
  await engine.dropWorkflowVisibilityIndex();
  expireWatermarkCache(engine);
  expect(await getWorkflowVisibilityWatermark(storage)).toBe('stale');
  const scanResults = await Promise.all(filters.map((filter) => listIds(engine, filter)));

  const report = await engine.backfillWorkflowVisibilityIndex();
  expect(report.watermarkWritten).toBe(true);
  expireWatermarkCache(engine);
  expect(await getWorkflowVisibilityWatermark(storage)).toBe('current');
  const indexResults = await Promise.all(filters.map((filter) => listIds(engine, filter)));

  for (const [index, filter] of filters.entries()) {
    expect({ filter, ids: indexResults[index] }).toEqual({ filter, ids: scanResults[index] });
  }
}

const EQUIVALENCE_FILTERS: readonly ListFilter[] = [
  {},
  { status: 'completed' },
  { status: 'failed' },
  { status: 'running' },
  { status: 'cancelled' },
  { status: ['completed', 'failed'] },
  { type: 'equivalence-complete' },
  { type: 'equivalence-parked' },
  { type: 'equivalence-fail', status: 'failed' },
  { idPrefix: 'eq-complete' },
  { idPrefix: 'eq-', status: 'completed' },
  { tags: ['audited'] },
  { tags: ['audited'], status: 'running' },
  { type: 'equivalence-complete', tags: ['audited'] },
  { failureCategory: 'application' },
];

describe('visibility index vs full-scan equivalence', () => {
  it('returns identical results on both paths for every indexed dimension', async () => {
    const storage = new MemoryStorage();
    const engine = new Engine({ storage });
    try {
      await buildCorpus(engine);

      const now = Date.now();
      const timeFilters: readonly ListFilter[] = [
        { createdAt: { gte: 0 } },
        { createdAt: { lte: now + 60_000 } },
        { createdAt: { gte: 0, lte: now + 60_000 } },
        { createdAt: { gt: now + 60_000 } },
        { updatedAt: { gte: 0 } },
        { updatedAt: { gte: 0, lte: now + 60_000 }, status: 'completed' },
        { updatedAt: { lt: 1 } },
        { executionDeadline: { gte: 0 } },
      ];

      await expectPathsAgree(engine, storage, [...EQUIVALENCE_FILTERS, ...timeFilters]);
    } finally {
      engine[Symbol.dispose]();
    }
  }, 30_000);

  it('keeps both paths agreeing after a purge removes rows mid-corpus', async () => {
    const storage = new MemoryStorage();
    const engine = new Engine({ storage });
    try {
      await buildCorpus(engine);
      await engine.backfillWorkflowVisibilityIndex();

      // Purge after the index is current: the purge path must retract the
      // index rows too, or the indexed listing keeps reporting a row the
      // scanning listing no longer sees.
      const purged = await engine.purge({ idPrefix: 'eq-complete-3' });
      expect(purged.deleted).toBeGreaterThan(0);

      await expectPathsAgree(engine, storage, EQUIVALENCE_FILTERS);

      const afterPurge = await listIds(engine, { status: 'completed' });
      expect(afterPurge).not.toContain('eq-complete-3');
    } finally {
      engine[Symbol.dispose]();
    }
  }, 30_000);

  it('surfaces a workflow created after the backfill on the indexed path', async () => {
    const storage = new MemoryStorage();
    const engine = new Engine({ storage });
    try {
      await buildCorpus(engine);
      const report = await engine.backfillWorkflowVisibilityIndex();
      expect(report.watermarkWritten).toBe(true);
      expireWatermarkCache(engine);

      const handle = await engine.start('equivalence-complete', 'late', { id: 'eq-late-1' });
      await handle.result();

      // The runtime write path maintains the index itself, so a row created
      // after the watermark needs no second backfill to be listable.
      expect(await listIds(engine, { status: 'completed' })).toContain('eq-late-1');
      expect(await listIds(engine, { type: 'equivalence-complete' })).toContain('eq-late-1');

      const coverage = await verifyWorkflowVisibilityIndex(storage, { deep: true });
      expect(coverage.complete).toBe(true);
      expect(coverage.watermarkOverstated).toBe(false);
    } finally {
      engine[Symbol.dispose]();
    }
  }, 30_000);
});

describe('watermark safety', () => {
  it('leaves the watermark stale when a pass is interrupted', async () => {
    const storage = new MemoryStorage();
    const engine = new Engine({ storage });
    try {
      await buildCorpus(engine);
      await engine.dropWorkflowVisibilityIndex();

      // Simulate a killed process: run a pass that throws partway through by
      // making the scan fail after the first workflow commits.
      let yielded = 0;
      const originalScan = storage.scan.bind(storage);
      storage.scan = async function* (prefix, options) {
        if (prefix !== 'wf:') {
          yield* originalScan(prefix, options);
          return;
        }
        for await (const entry of originalScan(prefix, options)) {
          yielded += 1;
          if (yielded > 1) throw new Error('simulated interruption');
          yield entry;
        }
      } as typeof storage.scan;

      await expect(engine.backfillWorkflowVisibilityIndex()).rejects.toThrow(
        'simulated interruption',
      );
      storage.scan = originalScan;

      // The interrupted pass committed real index rows but must NOT have
      // claimed coverage — a partial "current" is the failure mode that makes
      // list() omit rows instead of scanning.
      expect(await getWorkflowVisibilityWatermark(storage)).toBe('stale');
      expect(await storage.get(KEYS.workflowVisibilityMetaCursor())).not.toBeNull();

      // Resuming converges and only then advances the watermark.
      const report = await engine.backfillWorkflowVisibilityIndex();
      expect(report.watermarkWritten).toBe(true);
      expect(report.resumedFrom).toBeDefined();
      const resumedCoverage = await verifyWorkflowVisibilityIndex(storage, { deep: true });
      expect(resumedCoverage.complete).toBe(true);
    } finally {
      engine[Symbol.dispose]();
    }
  }, 30_000);

  it('is idempotent across repeated backfills', async () => {
    const storage = new MemoryStorage();
    const engine = new Engine({ storage });
    try {
      await buildCorpus(engine);
      await engine.backfillWorkflowVisibilityIndex();

      const keysAfterFirst = await collectKeys(storage, 'wf-idx-');
      const second = await engine.backfillWorkflowVisibilityIndex();
      expect(second.watermarkWritten).toBe(true);
      const keysAfterSecond = await collectKeys(storage, 'wf-idx-');

      expect(keysAfterSecond).toEqual(keysAfterFirst);
    } finally {
      engine[Symbol.dispose]();
    }
  }, 30_000);

  it('reports an overstated watermark rather than trusting it', async () => {
    const storage = new MemoryStorage();
    const engine = new Engine({ storage });
    try {
      await buildCorpus(engine);
      await engine.backfillWorkflowVisibilityIndex();
      const beforeTamper = await verifyWorkflowVisibilityIndex(storage);
      expect(beforeTamper.watermarkOverstated).toBe(false);

      // Forge exactly the dangerous state: a current watermark over a
      // workflow whose manifest is gone. Verify must call it out; nothing
      // else in the system can.
      await storage.delete(KEYS.workflowVisibilityManifest('eq-complete-1'));

      const report = await verifyWorkflowVisibilityIndex(storage);
      expect(report.watermark).toBe('current');
      expect(report.complete).toBe(false);
      expect(report.watermarkOverstated).toBe(true);
      expect(report.gaps).toContainEqual({
        workflowId: 'eq-complete-1',
        reason: 'missing-manifest',
      });
    } finally {
      engine[Symbol.dispose]();
    }
  }, 30_000);

  it('detects an index row deleted underneath a valid manifest only in deep mode', async () => {
    const storage = new MemoryStorage();
    const engine = new Engine({ storage });
    try {
      await buildCorpus(engine);
      await engine.backfillWorkflowVisibilityIndex();

      await storage.delete(KEYS.workflowVisibilityStatus('completed', 'eq-complete-2'));

      const shallow = await verifyWorkflowVisibilityIndex(storage);
      expect(shallow.complete).toBe(true);
      const deep = await verifyWorkflowVisibilityIndex(storage, { deep: true });
      expect(deep.complete).toBe(false);
      expect(deep.gaps).toContainEqual({
        workflowId: 'eq-complete-2',
        reason: 'missing-index-row',
      });
    } finally {
      engine[Symbol.dispose]();
    }
  }, 30_000);
});

describe('fresh-store watermark', () => {
  it('is established by recovery so a new deployment never full-scans', async () => {
    const storage = new MemoryStorage();
    expect(await getWorkflowVisibilityWatermark(storage)).toBe('stale');

    await using engine = await Engine.create({
      storage,
      workflows: { 'equivalence-complete': completingWorkflow },
    });

    expect(await getWorkflowVisibilityWatermark(storage)).toBe('current');

    const handle = await engine.start('equivalence-complete', 'first', { id: 'fresh-1' });
    await handle.result();

    expect(await listIds(engine, { status: 'completed' })).toEqual(['fresh-1']);
    const freshCoverage = await verifyWorkflowVisibilityIndex(storage, { deep: true });
    expect(freshCoverage.complete).toBe(true);
  }, 30_000);

  it('refuses to claim coverage on a store that already holds workflows', async () => {
    const storage = new MemoryStorage();
    {
      // Stamp the persisted-data version through Engine.create so the second
      // create below sees a legitimately populated store rather than one that
      // looks pre-versioned.
      await using seedEngine = await Engine.create({
        storage,
        workflows: { 'equivalence-complete': completingWorkflow },
      });
      const handle = await seedEngine.start('equivalence-complete', 'seed', { id: 'seed-1' });
      await handle.result();
      // Strip the index the write path laid down, leaving a populated but
      // un-indexed store — exactly the pre-existing-database case.
      await seedEngine.dropWorkflowVisibilityIndex();
    }

    await using engine = await Engine.create({
      storage,
      workflows: { 'equivalence-complete': completingWorkflow },
    });

    expect(await getWorkflowVisibilityWatermark(storage)).toBe('stale');
    // Still correct, because a stale watermark scans rather than omits.
    expect(await listIds(engine, { status: 'completed' })).toEqual(['seed-1']);
  }, 30_000);
});

async function collectKeys(storage: MemoryStorage, prefix: string): Promise<string[]> {
  const keys: string[] = [];
  for await (const [key] of storage.scan(prefix)) keys.push(key);
  return keys.toSorted();
}
