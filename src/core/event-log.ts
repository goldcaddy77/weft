/**
 * Hash-chained event log for durable workflow event sourcing.
 *
 * Each workflow accumulates an append-only log of `WorkflowLogEntry` records
 * stored under `ev:{workflowId}:{sequence}`. A separate head record at
 * `ev:{workflowId}:head` tracks the current sequence counter and the hash of
 * the most recently committed entry.
 *
 * Entries are chained by a `prevHash` field (wyhash of the previous entry's
 * encoded bytes), enabling tamper detection via {@link EventLog.verify}.
 *
 * Callers that hold a batch accumulator (e.g. the engine's checkpoint writer)
 * pass it to {@link EventLog.append} so that the event write is included in
 * the same atomic `storage.batch()` call as the checkpoint — the two can never
 * diverge.
 *
 * @module core/event-log
 */

import { hashBytes as portableHashBytes } from '../runtime/portable.ts';
import type { BatchOperation, Storage } from '../storage/interface.ts';
import { KEYS } from '../storage/interface.ts';
import { decode, encode } from './codec.ts';
import { type EventLogWatermark, readEventLogWatermark } from './engine/event-log-compaction.ts';
import type { WorkflowVersionTuple } from './workflow-version-tuple.ts';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Hash value used as `prevHash` for the very first entry in a log. */
const GENESIS_HASH = '0000000000000000';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single entry in the event log, as stored in the KV backend. */
export interface WorkflowLogEntry {
  /** Discriminates the entry type, e.g. `'workflow:checkpoint'`. */
  type: string;
  /** Workflow this entry belongs to. */
  workflowId: string;
  /** Zero-based monotonic sequence number. */
  sequence: number;
  /**
   * wyhash (16 hex chars) of the *encoded bytes* of the previous entry.
   * The first entry carries {@link GENESIS_HASH}.
   */
  prevHash: string;
  /** Arbitrary event payload. */
  payload: unknown;
  /** Unix timestamp (ms) at the time of the append. */
  timestamp: number;
  /**
   * Workflow, agent, and tool version tuple captured at the time of this
   * entry. Only present when the caller passes a `versionTuple` argument.
   * Absent for entries written by non-agent workflows or callers that opt out.
   */
  versionTuple?: WorkflowVersionTuple;
}

/**
 * The head record stored at `ev:{workflowId}:head`.
 * Tracks both the latest sequence number and the hash of the last committed
 * entry so that subsequent appends can chain without a second storage read.
 */
export interface EventHeadRecord {
  sequence: number;
  lastHash: string;
}

/**
 * The head state for a workflow with no committed entries.
 * Used as the starting point when appending the first event.
 * Frozen to prevent accidental mutation of the shared genesis sentinel.
 */
export const EMPTY_EVENT_HEAD: Readonly<EventHeadRecord> = Object.freeze({
  sequence: -1,
  lastHash: GENESIS_HASH,
});

/**
 * Result returned from `appendToBatch()`. Carries the updated head
 * record AND the entry's wall-clock `timestamp` so post-commit
 * listeners can emit the exact value written into the durable log
 * without reaching for `Date.now()` a second time (which could
 * produce a different value under a ticking `getNow` used in tests).
 */
export type AppendToBatchResult = {
  readonly newHead: EventHeadRecord;
  readonly timestamp: number;
};

/**
 * Result of {@link EventLog.verify}. The `indeterminate` variant keeps
 * `valid: false` so existing `if (result.valid)` callers never get a false
 * positive, but signals that verification could not complete because the log
 * was being compacted concurrently — it is NOT a corruption report (it carries
 * no `firstInvalidSequence`).
 */
export type VerifyResult =
  | { valid: true }
  | { valid: false; firstInvalidSequence: number }
  | { valid: false; indeterminate: true; reason: 'concurrent-compaction' };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Compute a 16-character hex hash of an arbitrary byte buffer. */
function hashBytes(bytes: Uint8Array): string {
  return portableHashBytes(bytes);
}

/** Narrow an unknown decoded value to {@link WorkflowLogEntry}. */
function isWorkflowLogEntry(value: unknown): value is WorkflowLogEntry {
  if (typeof value !== 'object' || value === null) return false;
  const obj = value as Record<string, unknown>;
  return (
    typeof obj['type'] === 'string' &&
    typeof obj['workflowId'] === 'string' &&
    typeof obj['sequence'] === 'number' &&
    typeof obj['prevHash'] === 'string' &&
    typeof obj['timestamp'] === 'number' &&
    'payload' in obj
  );
}

/**
 * Validate one entry's place in the hash chain during a verify pass.
 *
 * For the first surviving entry, its `sequence` must equal the expected start.
 * A mismatch means either a compaction raced the watermark read OR the expected
 * first record is genuinely missing; both report `invalid` at the *expected*
 * sequence, and `verify()` distinguishes a race (retry) from corruption (report)
 * by re-reading the watermark. The `prevHash` link must also match the seed.
 * For every subsequent entry, only the `prevHash` link is checked.
 */
function checkChainLink(
  entry: WorkflowLogEntry,
  previousHash: string,
  isFirst: boolean,
  expectedFirstSequence: number,
): { outcome: 'ok' } | { outcome: 'invalid'; firstInvalidSequence: number } {
  if (isFirst && entry.sequence !== expectedFirstSequence) {
    return { outcome: 'invalid', firstInvalidSequence: expectedFirstSequence };
  }
  if (entry.prevHash !== previousHash) {
    return { outcome: 'invalid', firstInvalidSequence: entry.sequence };
  }
  return { outcome: 'ok' };
}

/** Narrow an unknown decoded value to {@link EventHeadRecord}. */
function isEventHeadRecord(value: unknown): value is EventHeadRecord {
  if (typeof value !== 'object' || value === null) return false;
  const obj = value as Record<string, unknown>;
  return typeof obj['sequence'] === 'number' && typeof obj['lastHash'] === 'string';
}

// ---------------------------------------------------------------------------
// EventLog
// ---------------------------------------------------------------------------

/**
 * Append-only, hash-chained event log scoped to a single workflow.
 *
 * All reads and writes go through the {@link Storage} interface so the log
 * works with every backend (memory, SQLite, LMDB, Turso, IndexedDB).
 */
export class EventLog {
  readonly #storage: Storage;
  readonly #workflowId: string;

  constructor(storage: Storage, workflowId: string) {
    this.#storage = storage;
    this.#workflowId = workflowId;
  }

  // -------------------------------------------------------------------------
  // Public: appendToBatch (synchronous fast path)
  // -------------------------------------------------------------------------

  /**
   * Synchronously build the batch operations for a new event entry and push
   * them onto `batchOperations`.
   *
   * This is the fast path used by the engine: no storage reads occur.
   * The caller is responsible for supplying the current `head` (from an
   * in-memory cache) and storing the returned `newHead` back into that cache
   * after the batch is committed.
   *
   * @returns The updated head record to cache for the next call.
   */
  appendToBatch(
    event: { type: string; payload: unknown },
    batchOperations: BatchOperation[],
    head: Readonly<EventHeadRecord>,
    versionTuple?: WorkflowVersionTuple,
  ): AppendToBatchResult {
    const { entry, encoded, newHead } = this.#buildEntry(event, head, versionTuple);

    batchOperations.push(
      { type: 'put', key: KEYS.event(this.#workflowId, newHead.sequence), value: encoded },
      { type: 'put', key: KEYS.eventHead(this.#workflowId), value: encode(newHead) },
    );

    return { newHead, timestamp: entry.timestamp };
  }

  // -------------------------------------------------------------------------
  // Public: append (async general-purpose path)
  // -------------------------------------------------------------------------

  /**
   * Append a new event entry to the log.
   *
   * When `batchOperations` is supplied the writes are pushed onto it instead
   * of being flushed immediately, enabling the caller to include them in the
   * same atomic `storage.batch()` call as a checkpoint write.
   *
   * @returns The new sequence number, the hash of the appended entry, and the
   *   updated head record that the caller should cache for the next append.
   */
  async append(
    event: { type: string; payload: unknown },
    batchOperations?: BatchOperation[],
    versionTuple?: WorkflowVersionTuple,
  ): Promise<{ sequence: number; hash: string; newHead: EventHeadRecord }> {
    const head = await this.#readHead();
    const { encoded, hash, newHead } = this.#buildEntry(event, head, versionTuple);

    const entryPut: BatchOperation = {
      type: 'put',
      key: KEYS.event(this.#workflowId, newHead.sequence),
      value: encoded,
    };

    const headPut: BatchOperation = {
      type: 'put',
      key: KEYS.eventHead(this.#workflowId),
      value: encode(newHead),
    };

    if (batchOperations) {
      batchOperations.push(entryPut, headPut);
    } else {
      await this.#storage.batch([entryPut, headPut]);
    }

    return { sequence: newHead.sequence, hash, newHead };
  }

  // -------------------------------------------------------------------------
  // Public: scan
  // -------------------------------------------------------------------------

  /**
   * Iterate over all log entries in ascending sequence order.
   *
   * @param options.fromSequence  Start at this sequence number (inclusive). Defaults to 0.
   */
  async *scan(options?: { fromSequence?: number }): AsyncIterable<WorkflowLogEntry> {
    const from = options?.fromSequence ?? 0;
    const prefix = KEYS.eventPrefix(this.#workflowId);
    const gte = KEYS.event(this.#workflowId, from);

    for await (const [, bytes] of this.#storage.scan(prefix, { gte })) {
      const decoded = decode(bytes);
      if (isWorkflowLogEntry(decoded)) {
        yield decoded;
      }
    }
  }

  // -------------------------------------------------------------------------
  // Public: replay
  // -------------------------------------------------------------------------

  /**
   * Return all entries up to and including `toStep`.
   *
   * "Step" here is the `sequence` field. Entries with `sequence > toStep`
   * are excluded, so callers can reconstruct state as it was at any point.
   */
  async replay(toStep: number): Promise<WorkflowLogEntry[]> {
    const results: WorkflowLogEntry[] = [];
    for await (const entry of this.scan()) {
      if (entry.sequence > toStep) break;
      results.push(entry);
    }
    return results;
  }

  // -------------------------------------------------------------------------
  // Public: verify
  // -------------------------------------------------------------------------

  /**
   * Walk the log and verify hash-chain integrity.
   *
   * When event-log compaction has truncated the early records, a
   * {@link EventLogWatermark} at `ev:{id}:watermark` marks where the surviving
   * chain begins; `verify()` seeds its walk from the watermark's `prevHash`
   * instead of {@link GENESIS_HASH} so a compacted log does not look broken.
   *
   * A compaction can commit concurrently (before or during the scan); to avoid
   * reporting a *false* chain break, `verify()` re-reads the watermark on any
   * break and, if the watermark now explains it, restarts — up to a small bound.
   * If it never stabilizes, the result is flagged `indeterminate` (still
   * `valid: false`, but distinct from genuine corruption — it carries no
   * `firstInvalidSequence`).
   *
   * Two corruption cases worth calling out: a watermark that points at a first
   * surviving record which is no longer present (empty or higher-starting scan)
   * is reported as `{ valid: false, firstInvalidSequence: watermark.sequence }`;
   * and a compacted log whose watermark has been removed (e.g. a code rollback
   * that ignores it) is reported broken at the expected genesis sequence rather
   * than silently passing — compaction is one-way.
   */
  async verify(): Promise<VerifyResult> {
    // A single workflow has at most one in-flight checkpoint/compaction at a
    // time, so one retry is enough to converge in practice; 5 is generous
    // headroom before declaring the log too volatile to verify deterministically.
    const MAX_ATTEMPTS = 5;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      const watermark = await this.#readWatermark();
      const usedSequence = watermark?.sequence ?? -1;
      const result = await this.#verifyFromWatermark(watermark);

      if (result.outcome === 'ok') return { valid: true };

      // A failing pass is only "explained by a concurrent compaction" if the
      // watermark ADVANCED since the snapshot this pass used — records were
      // truncated out from under the scan mid-flight. Re-read once; if it moved,
      // retry against the newer boundary. Otherwise the failure is stable, so it
      // is genuine corruption — never a false `indeterminate`. (A `raced` outcome
      // with no advancing watermark, e.g. a genuinely missing first record,
      // resolves to corruption at the expected first sequence.)
      const latest = await this.#readWatermark();
      if (latest !== null && latest.sequence > usedSequence) {
        continue;
      }
      return { valid: false, firstInvalidSequence: result.firstInvalidSequence };
    }
    return { valid: false, indeterminate: true, reason: 'concurrent-compaction' };
  }

  /**
   * One verification pass against a fixed watermark snapshot. A failing pass
   * always carries the `firstInvalidSequence`: a broken hash link reports the
   * offending entry, and a first-surviving-sequence mismatch (a compaction may
   * have raced, or the first record is genuinely missing) reports the expected
   * first sequence. The caller decides retry-vs-corruption by re-reading the
   * watermark.
   */
  async #verifyFromWatermark(
    watermark: EventLogWatermark | null,
  ): Promise<{ outcome: 'ok' } | { outcome: 'invalid'; firstInvalidSequence: number }> {
    const seed = watermark?.prevHash ?? GENESIS_HASH;
    const expectedFirstSequence = watermark?.sequence ?? 0;

    const prefix = KEYS.eventPrefix(this.#workflowId);
    const options = watermark
      ? { gte: KEYS.event(this.#workflowId, watermark.sequence) }
      : undefined;

    const scan = await this.#scanChain(prefix, options, seed, expectedFirstSequence);
    if (scan.outcome === 'invalid') return scan;

    // An empty scan while a watermark expects a surviving entry is corruption:
    // the first surviving record was deleted out from under the watermark.
    if (scan.entriesSeen === 0 && watermark !== null) {
      return { outcome: 'invalid', firstInvalidSequence: watermark.sequence };
    }
    return { outcome: 'ok' };
  }

  /**
   * Walk the surviving entries once, validating each chain link. Returns the
   * first failing pass, or `{ outcome: 'ok', entriesSeen }` after a clean walk.
   */
  async #scanChain(
    prefix: string,
    options: { gte: string } | undefined,
    seed: string,
    expectedFirstSequence: number,
  ): Promise<
    | { outcome: 'invalid'; firstInvalidSequence: number }
    | { outcome: 'scanned'; entriesSeen: number }
  > {
    let previousHash = seed;
    let entriesSeen = 0;

    for await (const [, bytes] of this.#storage.scan(prefix, options)) {
      const decoded = decode(bytes);
      // The head and watermark records are not WorkflowLogEntries; the guard skips them.
      if (!isWorkflowLogEntry(decoded)) continue;

      const link = checkChainLink(decoded, previousHash, entriesSeen === 0, expectedFirstSequence);
      if (link.outcome === 'invalid') return link;
      entriesSeen += 1;
      previousHash = hashBytes(bytes);
    }

    return { outcome: 'scanned', entriesSeen };
  }

  /** Read and decode the compaction watermark, or `null` when absent/invalid. */
  async #readWatermark(): Promise<EventLogWatermark | null> {
    return readEventLogWatermark(this.#storage, this.#workflowId);
  }

  // -------------------------------------------------------------------------
  // Public: loadHead
  // -------------------------------------------------------------------------

  /**
   * Read the current head record from storage and return it.
   *
   * This is the async counterpart to the synchronous cache lookup in the
   * engine. Call it when resuming a workflow after an engine restart so that
   * the in-memory `#eventLogHeads` cache can be re-seeded before the next
   * {@link appendToBatch} call.
   *
   * Returns `EMPTY_EVENT_HEAD` (sequence -1) when no head record exists
   * (i.e., the log is empty or this workflow has never written an event).
   */
  async loadHead(): Promise<EventHeadRecord> {
    return this.#readHead();
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Construct a new log entry from an event and the current head state.
   *
   * Returns the encoded bytes, the hash of those bytes, and the updated head
   * record. Both {@link appendToBatch} and {@link append} delegate here to
   * avoid duplicating the entry-construction logic.
   */
  #buildEntry(
    event: { type: string; payload: unknown },
    head: Readonly<EventHeadRecord>,
    versionTuple?: WorkflowVersionTuple,
  ): { entry: WorkflowLogEntry; encoded: Uint8Array; hash: string; newHead: EventHeadRecord } {
    const sequence = head.sequence + 1;
    const prevHash = head.lastHash;

    const entry: WorkflowLogEntry = {
      type: event.type,
      workflowId: this.#workflowId,
      sequence,
      prevHash,
      payload: event.payload,
      timestamp: Date.now(),
    };

    if (versionTuple !== undefined) {
      entry.versionTuple = versionTuple;
    }

    const encoded = encode(entry);
    const hash = hashBytes(encoded);
    const newHead: EventHeadRecord = { sequence, lastHash: hash };

    return { entry, encoded, hash, newHead };
  }

  /**
   * Read the current head record from storage.
   *
   * Returns `{ sequence: -1, lastHash: GENESIS_HASH }` when no head record
   * exists (i.e., the log is empty). This lets {@link append} compute
   * `sequence = 0` and `prevHash = GENESIS_HASH` for the first entry.
   */
  async #readHead(): Promise<EventHeadRecord> {
    const headKey = KEYS.eventHead(this.#workflowId);
    const bytes = await this.#storage.get(headKey);
    if (bytes === null) {
      return { sequence: -1, lastHash: GENESIS_HASH };
    }
    const decoded = decode(bytes);
    if (isEventHeadRecord(decoded)) {
      return decoded;
    }
    return { sequence: -1, lastHash: GENESIS_HASH };
  }
}
