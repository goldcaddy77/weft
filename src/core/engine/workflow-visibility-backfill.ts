/**
 * Build, verify, and roll back the workflow visibility indexes that
 * `engine.list()` and `engine.aggregate()` consult once the
 * `wf-idx-meta:version` watermark is current.
 *
 * This module ships. It previously lived under `scripts/lib/`, which is
 * excluded from the published package, so the only way to act on
 * {@link WorkflowListScanCapExceededError}'s "run the visibility-index
 * backfill" instruction was to clone the repository and target a
 * `BunSQLiteStorage` file. Everything here takes a plain {@link Storage},
 * so any adapter that exposes `conditionalBatch` can be backfilled.
 *
 * The correctness rule that shapes every function below: a watermark that
 * claims `current` while some workflow lacks its index rows makes `list()`
 * silently OMIT that workflow instead of falling back to a scan. Under-
 * reporting an operator surface is far worse than scanning slowly, so the
 * watermark is written only after a complete pass proves coverage, and it
 * is removed before — never after — the rows it vouches for.
 *
 * @module core/engine/workflow-visibility-backfill
 */

import {
  KEYS,
  MAX_BATCH_OPERATIONS,
  storageConditionalBatch,
  tryDecodeStorageKeyComponent,
  type BatchOperation,
  type Storage,
} from '../../storage/interface.ts';
import { decode, encode } from '../codec.ts';
import type { WorkflowState } from '../types.ts';
import { decodeWorkflowState } from './validation.ts';
import {
  WORKFLOW_VISIBILITY_INDEX_VERSION,
  buildWorkflowVisibilityIndexOperations,
  decodeWorkflowVisibilityManifest,
  deriveWorkflowVisibilityIndexKeys,
  getWorkflowVisibilityWatermark,
  type WorkflowVisibilityManifest,
  type WorkflowVisibilityWatermark,
} from './workflow-indexes.ts';

/**
 * Every prefix the visibility index owns. `wf-idx-tenant:` is a retired
 * layout that some persisted stores still carry; the drop sweep removes it
 * so a rollback leaves nothing behind, but nothing writes it any more.
 */
const VISIBILITY_INDEX_PREFIXES = [
  'wf-idx-status:',
  'wf-idx-type:',
  'wf-idx-tenant:',
  'wf-idx-created:',
  'wf-idx-updated:',
  'wf-idx-deadline:',
  'wf-idx-manifest:',
] as const;

/** Default number of processed workflows between progress log lines. */
const DEFAULT_CHECKPOINT_EVERY = 500;

/** How many gap ids a coverage report retains for operator diagnosis. */
const MAX_REPORTED_GAP_IDS = 20;

/**
 * Receives every progress message the CLI would print. Defaults to a no-op
 * so library callers stay quiet.
 *
 * @example
 * ```ts
 * import { runWorkflowVisibilityBackfill, MemoryStorage, type WorkflowVisibilityBackfillLogger } from '@lostgradient/weft';
 * const logger: WorkflowVisibilityBackfillLogger = (msg) => console.log(msg);
 * const storage = new MemoryStorage();
 * await runWorkflowVisibilityBackfill(storage, { logger });
 * ```
 */
export type WorkflowVisibilityBackfillLogger = (message: string) => void;

/**
 * Why a workflow failed its coverage check. Surfaced on each
 * {@link WorkflowVisibilityGap} in a {@link WorkflowVisibilityCoverageReport}.
 *
 * @example
 * ```ts
 * import { verifyWorkflowVisibilityIndex, MemoryStorage, type WorkflowVisibilityGapReason } from '@lostgradient/weft';
 * const report = await verifyWorkflowVisibilityIndex(new MemoryStorage());
 * const reasons: WorkflowVisibilityGapReason[] = report.gaps.map((g) => g.reason);
 * ```
 */
export type WorkflowVisibilityGapReason =
  | 'missing-manifest'
  | 'stale-manifest-version'
  | 'manifest-key-drift'
  | 'missing-index-row'
  | 'oversized-manifest';

/**
 * One workflow that is not correctly represented in the index.
 * Returned in `gaps` of a {@link WorkflowVisibilityCoverageReport}.
 *
 * @example
 * ```ts
 * import { verifyWorkflowVisibilityIndex, MemoryStorage, type WorkflowVisibilityGap } from '@lostgradient/weft';
 * const report = await verifyWorkflowVisibilityIndex(new MemoryStorage());
 * const gap: WorkflowVisibilityGap | undefined = report.gaps[0];
 * if (gap) console.log(gap.workflowId, gap.reason);
 * ```
 */
export type WorkflowVisibilityGap = {
  workflowId: string;
  reason: WorkflowVisibilityGapReason;
};

/**
 * Tuning knobs for {@link runWorkflowVisibilityBackfill}. All fields optional.
 *
 * @example
 * ```ts
 * import { runWorkflowVisibilityBackfill, MemoryStorage, type WorkflowVisibilityBackfillOptions } from '@lostgradient/weft';
 * const options: WorkflowVisibilityBackfillOptions = { logger: console.log, checkpointEvery: 100 };
 * const report = await runWorkflowVisibilityBackfill(new MemoryStorage(), options);
 * console.log(report.processed);
 * ```
 */
export type WorkflowVisibilityBackfillOptions = {
  logger?: WorkflowVisibilityBackfillLogger;
  /** Workflows processed between progress log lines. Default 500. */
  checkpointEvery?: number;
};

/**
 * Outcome of one {@link runWorkflowVisibilityBackfill} pass.
 * `watermarkWritten` is `true` only when the pass was gap-free.
 *
 * @example
 * ```ts
 * import { runWorkflowVisibilityBackfill, MemoryStorage, type WorkflowVisibilityBackfillReport } from '@lostgradient/weft';
 * const report: WorkflowVisibilityBackfillReport = await runWorkflowVisibilityBackfill(new MemoryStorage());
 * console.log(report.watermarkWritten, report.processed, report.conflicts);
 * ```
 */
export type WorkflowVisibilityBackfillReport = {
  /** Workflows whose index rows were committed by this pass. */
  processed: number;
  /** Workflows skipped because a racing write invalidated the read. */
  conflicts: number;
  /** Workflows skipped because their persisted manifest could not fit one batch. */
  oversized: number;
  /** True only when a complete, gap-free pass advanced the watermark. */
  watermarkWritten: boolean;
  /** The cursor this pass resumed from, when it resumed. */
  resumedFrom?: string;
};

/**
 * Tuning knobs for {@link verifyWorkflowVisibilityIndex}. All fields optional.
 *
 * @example
 * ```ts
 * import { verifyWorkflowVisibilityIndex, MemoryStorage, type WorkflowVisibilityVerifyOptions } from '@lostgradient/weft';
 * const options: WorkflowVisibilityVerifyOptions = { logger: console.log, deep: true };
 * const report = await verifyWorkflowVisibilityIndex(new MemoryStorage(), options);
 * console.log(report.complete);
 * ```
 */
export type WorkflowVisibilityVerifyOptions = {
  logger?: WorkflowVisibilityBackfillLogger;
  /**
   * Also `get()` every index row a manifest claims. Off by default: a
   * manifest and the rows it lists are written in one batch, so manifest
   * agreement already implies the rows exist for any adapter with atomic
   * batches. Turn it on to audit an adapter, at a cost of up to five extra
   * reads per workflow.
   */
  deep?: boolean;
};

/**
 * Read-only coverage answer produced by {@link verifyWorkflowVisibilityIndex}.
 * `watermarkOverstated` is the dangerous case — `list()` under-reports instead
 * of falling back to a scan.
 *
 * @example
 * ```ts
 * import { verifyWorkflowVisibilityIndex, MemoryStorage, type WorkflowVisibilityCoverageReport } from '@lostgradient/weft';
 * const report: WorkflowVisibilityCoverageReport = await verifyWorkflowVisibilityIndex(new MemoryStorage());
 * console.log(report.complete, report.watermarkOverstated);
 * ```
 */
export type WorkflowVisibilityCoverageReport = {
  /** Top-level workflow records examined. */
  scanned: number;
  /** Workflows correctly represented in the index. */
  covered: number;
  /** Workflows that are not. `complete` is `gaps === 0`. */
  gaps: readonly WorkflowVisibilityGap[];
  /** True when every scanned workflow is covered at the current version. */
  complete: boolean;
  /** What the engine would decide right now, before this report changed anything. */
  watermark: WorkflowVisibilityWatermark;
  /** True when the watermark claims coverage the index does not have. */
  watermarkOverstated: boolean;
};

/**
 * Tuning knobs for {@link runWorkflowVisibilityDrop}. All fields optional.
 *
 * @example
 * ```ts
 * import { runWorkflowVisibilityDrop, MemoryStorage, type WorkflowVisibilityDropOptions } from '@lostgradient/weft';
 * const options: WorkflowVisibilityDropOptions = { logger: console.log, fallbackBatchSize: 200 };
 * const report = await runWorkflowVisibilityDrop(new MemoryStorage(), options);
 * console.log(report.rowsDeleted);
 * ```
 */
export type WorkflowVisibilityDropOptions = {
  logger?: WorkflowVisibilityBackfillLogger;
  /** Deletes per batch on adapters without `deletePrefix`. Clamped to the batch cap. */
  fallbackBatchSize?: number;
};

/**
 * Outcome of one {@link runWorkflowVisibilityDrop} sweep.
 *
 * @example
 * ```ts
 * import { runWorkflowVisibilityDrop, MemoryStorage, type WorkflowVisibilityDropReport } from '@lostgradient/weft';
 * const report: WorkflowVisibilityDropReport = await runWorkflowVisibilityDrop(new MemoryStorage());
 * console.log(report.rowsDeleted);
 * ```
 */
export type WorkflowVisibilityDropReport = {
  rowsDeleted: number;
};

/**
 * Decode the workflow id from a top-level `wf:{id}` key, or `null` when the
 * key is a nested `wf:{id}:...` record or an unreadable id.
 */
function topLevelWorkflowId(key: string): string | null {
  if (!key.startsWith('wf:')) return null;
  const encodedId = key.slice(3);
  if (encodedId.includes(':')) return null;
  return tryDecodeStorageKeyComponent(encodedId);
}

/** What one workflow's index repair did. */
type IndexOneOutcome = 'committed' | 'conflict' | 'oversized';

/**
 * Repair one workflow's index rows and advance the cursor, in a single
 * conditional batch fenced on the workflow record's own bytes.
 */
async function indexOneWorkflow(
  storage: Storage,
  key: string,
  value: Uint8Array,
  workflowId: string,
  logger: WorkflowVisibilityBackfillLogger,
): Promise<IndexOneOutcome> {
  const state = decodeWorkflowState(value);
  const manifestBytes = await storage.get(KEYS.workflowVisibilityManifest(workflowId));
  const currentManifest = decodeWorkflowVisibilityManifest(manifestBytes);
  const { batchOps } = buildWorkflowVisibilityIndexOperations(workflowId, currentManifest, state);

  const operations: BatchOperation[] = [
    ...batchOps,
    { type: 'put', key: KEYS.workflowVisibilityMetaCursor(), value: encode(key) },
  ];

  // A corrupt manifest can name arbitrarily many keys. Splitting the repair
  // across batches would give up the atomicity that makes the manifest
  // trustworthy, so skip the workflow and refuse the watermark: a slow scan
  // is the safe failure, an overstated watermark is not.
  if (operations.length > MAX_BATCH_OPERATIONS) {
    logger(
      `Workflow ${workflowId} needs ${operations.length} operations, above the ${MAX_BATCH_OPERATIONS} batch cap. Drop the index, then back fill again.`,
    );
    return 'oversized';
  }

  const committed = await storageConditionalBatch(
    storage,
    [{ key, expectedValue: value }],
    operations,
  );
  if (committed) return 'committed';
  logger(`Conflict on workflow ${workflowId}; will retry on next pass.`);
  return 'conflict';
}

async function loadCursor(storage: Storage): Promise<string | undefined> {
  const bytes = await storage.get(KEYS.workflowVisibilityMetaCursor());
  if (!bytes) return undefined;
  try {
    const decoded = decode(bytes);
    return typeof decoded === 'string' ? decoded : undefined;
  } catch {
    return undefined;
  }
}

function requireConditionalBatch(storage: Storage): void {
  if (storage.conditionalBatch === undefined) {
    throw new Error(
      'Storage backend does not expose conditionalBatch(); backfill requires it to avoid racing the engine.',
    );
  }
}

/**
 * Build the workflow visibility indexes for every workflow in `storage` and,
 * only if the pass completes with no skipped workflows, advance the
 * watermark.
 *
 * Each workflow commits through a `conditionalBatch` keyed on the workflow
 * record's own bytes, so a racing runtime write loses the precondition
 * rather than being clobbered with a stale manifest. A lost precondition is
 * recorded as a conflict, and any conflict leaves the watermark stale —
 * re-running converges because an unchanged workflow re-commits identical
 * operations.
 *
 * The cursor at `wf-idx-meta:cursor` is written inside the same conditional
 * batch, so it never runs ahead of committed work. An interrupted pass
 * therefore resumes from a position at or behind the last success and, with
 * the watermark untouched, leaves the engine on the correct full-scan path.
 *
 * @example
 * ```ts
 * import { runWorkflowVisibilityBackfill, MemoryStorage } from '@lostgradient/weft';
 * const report = await runWorkflowVisibilityBackfill(new MemoryStorage(), { logger: console.log });
 * console.log(report.watermarkWritten, report.processed, report.conflicts);
 * ```
 */
export async function runWorkflowVisibilityBackfill(
  storage: Storage,
  options: WorkflowVisibilityBackfillOptions = {},
): Promise<WorkflowVisibilityBackfillReport> {
  const logger = options.logger ?? ((): void => undefined);
  const checkpointEvery = Math.max(1, options.checkpointEvery ?? DEFAULT_CHECKPOINT_EVERY);

  requireConditionalBatch(storage);

  const startCursor = await loadCursor(storage);
  if (startCursor !== undefined) logger(`Resuming backfill from cursor ${startCursor}`);

  const tally = await indexEveryWorkflow(storage, startCursor, checkpointEvery, logger);
  const base = {
    ...tally,
    ...(startCursor === undefined ? {} : { resumedFrom: startCursor }),
  };

  if (tally.conflicts > 0 || tally.oversized > 0) {
    logger(
      `Backfill skipped ${tally.conflicts} racing and ${tally.oversized} oversized workflows. Watermark left stale; re-run to converge.`,
    );
    return { ...base, watermarkWritten: false };
  }

  await commitWorkflowVisibilityWatermark(storage);
  return { ...base, watermarkWritten: true };
}

type BackfillTally = { processed: number; conflicts: number; oversized: number };

/** Walk every top-level workflow record from `startCursor` and repair it. */
async function indexEveryWorkflow(
  storage: Storage,
  startCursor: string | undefined,
  checkpointEvery: number,
  logger: WorkflowVisibilityBackfillLogger,
): Promise<BackfillTally> {
  const tally: BackfillTally = { processed: 0, conflicts: 0, oversized: 0 };
  const scanOptions = startCursor === undefined ? undefined : { gt: startCursor };

  for await (const [key, value] of storage.scan('wf:', scanOptions)) {
    const workflowId = topLevelWorkflowId(key);
    if (workflowId === null) continue;

    const outcome = await indexOneWorkflow(storage, key, value, workflowId, logger);
    if (outcome !== 'committed') {
      tally[outcome === 'conflict' ? 'conflicts' : 'oversized'] += 1;
      continue;
    }

    tally.processed += 1;
    if (tally.processed % checkpointEvery === 0) {
      logger(`Processed ${tally.processed} workflows (last: ${workflowId})`);
    }
  }

  return tally;
}

/**
 * Write the watermark and clear the cursor in one batch, so the engine sees
 * either a current index with no in-progress marker or neither.
 */
async function commitWorkflowVisibilityWatermark(storage: Storage): Promise<void> {
  await storage.batch([
    {
      type: 'put',
      key: KEYS.workflowVisibilityMetaVersion(),
      value: encode(WORKFLOW_VISIBILITY_INDEX_VERSION),
    },
    { type: 'put', key: KEYS.workflowVisibilityMetaBuiltAt(), value: encode(Date.now()) },
    { type: 'delete', key: KEYS.workflowVisibilityMetaCursor() },
  ]);
}

function classifyManifest(
  manifest: WorkflowVisibilityManifest | null,
  state: WorkflowState,
): WorkflowVisibilityGapReason | null {
  if (manifest === null) return 'missing-manifest';
  if (manifest.version !== WORKFLOW_VISIBILITY_INDEX_VERSION) return 'stale-manifest-version';
  if (manifest.keys.length > MAX_BATCH_OPERATIONS) return 'oversized-manifest';

  const expected = deriveWorkflowVisibilityIndexKeys(state);
  if (expected.length !== manifest.keys.length) return 'manifest-key-drift';
  const recorded = new Set(manifest.keys);
  for (const key of expected) {
    if (!recorded.has(key)) return 'manifest-key-drift';
  }
  return null;
}

/**
 * Report visibility-index coverage without writing anything at all — not the
 * watermark, not the cursor, not a single index row.
 *
 * This is the check an operator runs before trusting `list()`, and the check
 * that answers the one question the watermark alone cannot: does the
 * watermark's claim match reality? `watermarkOverstated` is the dangerous
 * combination — a `current` watermark over an incomplete index, which makes
 * filtered listings under-report instead of falling back to a scan.
 *
 * @example
 * ```ts
 * import { verifyWorkflowVisibilityIndex, MemoryStorage } from '@lostgradient/weft';
 * const report = await verifyWorkflowVisibilityIndex(new MemoryStorage(), { deep: true });
 * console.log(report.complete, report.scanned, report.covered);
 * ```
 */
export async function verifyWorkflowVisibilityIndex(
  storage: Storage,
  options: WorkflowVisibilityVerifyOptions = {},
): Promise<WorkflowVisibilityCoverageReport> {
  const logger = options.logger ?? ((): void => undefined);
  const deep = options.deep ?? false;

  const watermark = await getWorkflowVisibilityWatermark(storage);

  let scanned = 0;
  let covered = 0;
  const gaps: WorkflowVisibilityGap[] = [];
  let gapCount = 0;

  const recordGap = (workflowId: string, reason: WorkflowVisibilityGapReason): void => {
    gapCount += 1;
    if (gaps.length < MAX_REPORTED_GAP_IDS) gaps.push({ workflowId, reason });
    logger(`Gap: workflow ${workflowId} (${reason})`);
  };

  for await (const [key, value] of storage.scan('wf:')) {
    const workflowId = topLevelWorkflowId(key);
    if (workflowId === null) continue;

    scanned += 1;
    const reason = await classifyWorkflowCoverage(storage, workflowId, value, deep);
    if (reason === null) {
      covered += 1;
      continue;
    }
    recordGap(workflowId, reason);
  }

  const complete = gapCount === 0;
  return {
    scanned,
    covered,
    gaps,
    complete,
    watermark,
    watermarkOverstated: watermark === 'current' && !complete,
  };
}

/**
 * Decide whether one workflow is correctly represented in the index.
 * Returns `null` when it is, or the reason it is not.
 */
async function classifyWorkflowCoverage(
  storage: Storage,
  workflowId: string,
  stateBytes: Uint8Array,
  deep: boolean,
): Promise<WorkflowVisibilityGapReason | null> {
  const state = decodeWorkflowState(stateBytes);
  const manifestBytes = await storage.get(KEYS.workflowVisibilityManifest(workflowId));
  const manifest = decodeWorkflowVisibilityManifest(manifestBytes);
  const reason = classifyManifest(manifest, state);
  if (reason !== null || manifest === null) return reason;
  if (!deep) return null;
  return (await findMissingIndexRow(storage, manifest.keys)) === null ? null : 'missing-index-row';
}

async function findMissingIndexRow(
  storage: Storage,
  keys: readonly string[],
): Promise<string | null> {
  for (const key of keys) {
    // Index rows are presence-only zero-byte values, so `null` — not
    // falsiness — is the absence test.
    if ((await storage.get(key)) === null) return key;
  }
  return null;
}

/**
 * Establish the watermark on a store that provably has full coverage
 * because it holds no workflows at all.
 *
 * Every workflow written by a current engine maintains its own index rows
 * on the write path, so a store that has never held a workflow is trivially
 * complete and every workflow added after this point indexes itself. Without
 * this, a brand-new deployment stays on the full-scan path permanently — it
 * has nothing to back fill, and nothing else ever writes the watermark.
 *
 * Returns `true` when it established the watermark. Cheap enough for a boot
 * path: one `get`, plus a single-row scan only when the watermark is absent.
 *
 * @example
 * ```ts
 * import { establishWorkflowVisibilityWatermarkIfEmpty, MemoryStorage } from '@lostgradient/weft';
 * const storage = new MemoryStorage();
 * console.log(await establishWorkflowVisibilityWatermarkIfEmpty(storage)); // true — empty store
 * console.log(await establishWorkflowVisibilityWatermarkIfEmpty(storage)); // false — already current
 * ```
 */
export async function establishWorkflowVisibilityWatermarkIfEmpty(
  storage: Storage,
): Promise<boolean> {
  if ((await getWorkflowVisibilityWatermark(storage)) === 'current') return false;

  for await (const [key] of storage.scan('wf:', { limit: 1 })) {
    // Any `wf:` row at all — even a checkpoint under a workflow — means this
    // store has held workflows, so coverage is not provable from emptiness.
    if (key.startsWith('wf:')) return false;
  }

  // A partially-completed backfill left a cursor behind. It is meaningless
  // over an empty store, but clearing it keeps the meta rows consistent.
  await commitWorkflowVisibilityWatermark(storage);
  return true;
}

/**
 * Drop every visibility-index row plus the watermark.
 *
 * Order is load-bearing: the watermark goes first so the engine immediately
 * falls back to the correct slow path, then the rows are swept, then the
 * cursor is cleared. Reversing it would leave a window where the engine
 * trusts a watermark for rows that are already gone — the exact
 * under-reporting failure this module exists to prevent.
 *
 * Use this before running {@link runWorkflowVisibilityBackfill} when a clean
 * rebuild is needed — for example after an adapter migration or version downgrade.
 *
 * @example
 * ```ts
 * import { runWorkflowVisibilityDrop, MemoryStorage } from '@lostgradient/weft';
 * const report = await runWorkflowVisibilityDrop(new MemoryStorage(), { logger: console.log });
 * console.log(report.rowsDeleted);
 * ```
 */
export async function runWorkflowVisibilityDrop(
  storage: Storage,
  options: WorkflowVisibilityDropOptions = {},
): Promise<WorkflowVisibilityDropReport> {
  const logger = options.logger ?? ((): void => undefined);
  const fallbackBatchSize = Math.max(
    1,
    Math.min(options.fallbackBatchSize ?? DEFAULT_CHECKPOINT_EVERY, MAX_BATCH_OPERATIONS),
  );

  await storage.delete(KEYS.workflowVisibilityMetaVersion());
  await storage.delete(KEYS.workflowVisibilityMetaBuiltAt());

  let rowsDeleted = 0;
  for (const prefix of VISIBILITY_INDEX_PREFIXES) {
    if (storage.deletePrefix !== undefined) {
      const removed = await storage.deletePrefix(prefix);
      rowsDeleted += removed;
      logger(`Dropped prefix ${prefix} (${removed} rows)`);
      continue;
    }
    const toDelete: BatchOperation[] = [];
    for await (const [key] of storage.scan(prefix)) {
      toDelete.push({ type: 'delete', key });
      if (toDelete.length >= fallbackBatchSize) {
        await storage.batch(toDelete);
        rowsDeleted += toDelete.length;
        toDelete.length = 0;
      }
    }
    if (toDelete.length > 0) {
      await storage.batch(toDelete);
      rowsDeleted += toDelete.length;
    }
  }

  await storage.delete(KEYS.workflowVisibilityMetaCursor());
  return { rowsDeleted };
}
