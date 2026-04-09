/**
 * Durable tool effect log for agent tool-call deduplication.
 *
 * When an agent is restored from a checkpoint mid-turn, the LLM will
 * re-synthesize tool calls that may differ semantically from the ones that
 * were in flight before the crash. Without a durability fence at the
 * tool-call boundary, non-idempotent tools (payments, state mutations,
 * single-use token presentations) can execute twice.
 *
 * This module solves the problem with an effect log keyed by a *semantic
 * hash* of each tool call's intent-critical fields. Before executing a
 * tool the agent loop consults the log:
 *
 * - **committed** → replay the stored result; skip the tool entirely.
 * - **in-flight** → the previous run crashed mid-execution; throw
 *   {@link ToolCallReplayConflictError} so the caller can escalate.
 * - **absent** → record as `in-flight`, execute the tool, then
 *   {@link ToolEffectLog.commit} or {@link ToolEffectLog.abort}.
 *
 * The log is backed by the {@link Storage} interface (any KV adapter).
 * Records are scoped to `(workflowId, agentId)` so parallel `ctx.all`
 * agent branches do not collide.
 *
 * @see arXiv 2603.20625 ("ACRFence") for the threat model and experimental
 *   evidence that motivated this design.
 *
 * @module ai/tool-effect-log
 */

import { decode, encode } from '../core/codec';
import type { Storage } from '../storage/interface';
import { KEYS } from '../storage/interface';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A tool-call effect record stored in the log. */
export type EffectRecord =
  | { status: 'in-flight'; toolName: string; recordedAt: number }
  | { status: 'committed'; toolName: string; output: string; completedAt: number }
  | { status: 'aborted'; toolName: string; reason: string; completedAt: number };

// ---------------------------------------------------------------------------
// ToolCallReplayConflictError
// ---------------------------------------------------------------------------

/**
 * Thrown when the agent loop detects a lingering `in-flight` record for a
 * tool call during a checkpoint-restore cycle. This indicates the process
 * crashed between recording the in-flight intent and receiving the tool
 * result — the outcome of the original call is unknown.
 *
 * Callers should escalate (e.g. human review) rather than silently
 * re-executing a potentially non-idempotent tool.
 */
export class ToolCallReplayConflictError extends Error {
  readonly toolName: string;
  readonly semanticHash: string;

  constructor(semanticHash: string, toolName: string) {
    super(
      `Tool call replay conflict: "${toolName}" (semantic hash ${semanticHash}) ` +
        `was in-flight when the process crashed. The outcome of the original call ` +
        `is unknown — re-executing a non-idempotent tool may cause duplicate effects. ` +
        `Inspect the effect log or route to human review before retrying.`,
    );
    this.name = 'ToolCallReplayConflictError';
    this.toolName = toolName;
    this.semanticHash = semanticHash;
  }
}

// ---------------------------------------------------------------------------
// Semantic hash
// ---------------------------------------------------------------------------

/**
 * Compute a stable 16-character hex semantic hash of an arbitrary input
 * value. Keys within objects are sorted recursively so that
 * `{a:1,b:2}` and `{b:2,a:1}` produce the same hash.
 *
 * Tool authors may override this default by supplying an `identity` function
 * on their {@link AgentToolDefinition} that extracts only the intent-critical
 * fields (e.g. payment recipient + amount) before hashing, ignoring fields
 * whose variance does not affect the tool's observable effect (retry counters,
 * timestamps, nonces).
 */
export function computeSemanticHash(input: unknown): string {
  const canonical = canonicalize(input);
  const raw = Bun.hash.wyhash(canonical);
  return raw.toString(16).padStart(16, '0');
}

/** Recursively sort object keys to produce a canonical JSON representation. */
function canonicalize(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return '"undefined"';
  if (typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return '[' + value.map(canonicalize).join(',') + ']';
  }
  const record = value as Record<string, unknown>;
  const sorted = Object.keys(record)
    .toSorted()
    .map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`);
  return '{' + sorted.join(',') + '}';
}

// ---------------------------------------------------------------------------
// Runtime type guard
// ---------------------------------------------------------------------------

/** Narrow an unknown decoded value to `EffectRecord`. Used in {@link ToolEffectLog.lookup}. */
function isEffectRecord(value: unknown): value is EffectRecord {
  if (typeof value !== 'object' || value === null) return false;
  const obj = value as Record<string, unknown>;
  if (typeof obj['status'] !== 'string' || typeof obj['toolName'] !== 'string') return false;
  const status = obj['status'];
  if (status === 'in-flight') return typeof obj['recordedAt'] === 'number';
  if (status === 'committed')
    return typeof obj['output'] === 'string' && typeof obj['completedAt'] === 'number';
  if (status === 'aborted')
    return typeof obj['reason'] === 'string' && typeof obj['completedAt'] === 'number';
  return false;
}

// ---------------------------------------------------------------------------
// ToolEffectLog
// ---------------------------------------------------------------------------

/**
 * Per-agent-invocation effect log.
 *
 * Scoped to a `(workflowId, agentId)` pair so that concurrent agent branches
 * (e.g. from `ctx.all([agent(), agent()])`) do not share hash space.
 *
 * `agentId` is the `operationId` assigned at `ctx.agent()` call-time — it is
 * stable across checkpoint-restore cycles because the engine derives it from
 * the workflow step index, not from a random source.
 */
export class ToolEffectLog {
  readonly #storage: Storage;
  readonly #workflowId: string;
  readonly #agentId: string;
  #duplicatesPrevented = 0;

  constructor(storage: Storage, workflowId: string, agentId: string) {
    this.#storage = storage;
    this.#workflowId = workflowId;
    this.#agentId = agentId;
  }

  /** Number of committed-replay short-circuits recorded during this instance's lifetime. */
  get duplicatesPrevented(): number {
    return this.#duplicatesPrevented;
  }

  /**
   * Increment the duplicate-prevention counter.
   * Called by the agent loop each time a committed replay short-circuits a
   * tool invocation. Separated from {@link lookup} so callers control when
   * they count a replay.
   */
  recordReplay(): void {
    this.#duplicatesPrevented++;
  }

  /**
   * Look up the effect record for a given semantic hash.
   * Returns `null` when no record exists (tool has not been seen before).
   */
  async lookup(semanticHash: string): Promise<EffectRecord | null> {
    const key = KEYS.toolEffect(this.#workflowId, this.#agentId, semanticHash);
    const bytes = await this.#storage.get(key);
    if (!bytes) return null;
    const decoded = decode(bytes);
    if (!isEffectRecord(decoded)) return null;
    return decoded;
  }

  /**
   * Record a tool call as `in-flight`.
   *
   * Call this **before** invoking the tool so that a crash between this
   * write and the tool's response is detectable on restore.
   */
  async record(semanticHash: string, toolName: string): Promise<void> {
    const record: EffectRecord = {
      status: 'in-flight',
      toolName,
      recordedAt: Date.now(),
    };
    await this.#put(semanticHash, record);
  }

  /**
   * Mark the call as `committed` and store the tool output.
   *
   * Call this after the tool has returned successfully so that a subsequent
   * restore will replay this output instead of re-executing.
   */
  async commit(semanticHash: string, toolName: string, output: string): Promise<void> {
    const record: EffectRecord = {
      status: 'committed',
      toolName,
      output,
      completedAt: Date.now(),
    };
    await this.#put(semanticHash, record);
  }

  /**
   * Mark the call as `aborted` with a reason string.
   *
   * Call this when the tool fails and that failure should not be replayed
   * from the effect log. On restore the agent loop will re-execute the tool
   * rather than replaying the error, so only use this for failures where a
   * future retry is safe and desired.
   */
  async abort(semanticHash: string, toolName: string, reason: string): Promise<void> {
    const record: EffectRecord = {
      status: 'aborted',
      toolName,
      reason,
      completedAt: Date.now(),
    };
    await this.#put(semanticHash, record);
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  async #put(semanticHash: string, record: EffectRecord): Promise<void> {
    const key = KEYS.toolEffect(this.#workflowId, this.#agentId, semanticHash);
    await this.#storage.put(key, encode(record));
  }
}
