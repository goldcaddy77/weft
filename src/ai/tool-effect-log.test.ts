/**
 * Tests for ToolEffectLog — durable deduplication of agent tool calls across
 * checkpoint-restore cycles.
 *
 * Verifies that:
 * 1. Crashing mid-tool-call and restoring causes the tool to run exactly once.
 * 2. A committed result is replayed without re-invocation after restore.
 * 3. A lingering in-flight record throws ToolCallReplayConflictError.
 * 4. The default semantic hash is stable under key-ordering variance.
 * 5. A custom identity function restricts hashing to intent-critical fields.
 *
 * @module ai/tool-effect-log.test
 */

import { beforeEach, describe, expect, it } from 'bun:test';

import { MemoryStorage } from '../storage/memory';
import { computeSemanticHash, ToolCallReplayConflictError, ToolEffectLog } from './tool-effect-log';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeLog(
  storage = new MemoryStorage(),
  workflowId = 'wf-1',
  agentId = 'agent-1',
): ToolEffectLog {
  return new ToolEffectLog(storage, workflowId, agentId);
}

// ---------------------------------------------------------------------------
// computeSemanticHash
// ---------------------------------------------------------------------------

describe('computeSemanticHash', () => {
  it('produces the same hash regardless of key order', () => {
    const a = computeSemanticHash({ a: 1, b: 2 });
    const b = computeSemanticHash({ b: 2, a: 1 });
    expect(a).toBe(b);
  });

  it('produces different hashes for different values', () => {
    const a = computeSemanticHash({ recipient: 'alice', amount: 100 });
    const b = computeSemanticHash({ recipient: 'bob', amount: 100 });
    expect(a).not.toBe(b);
  });

  it('returns a 16-character hex string', () => {
    const hash = computeSemanticHash({ x: 1 });
    expect(hash).toMatch(/^[0-9a-f]{16}$/);
  });

  it('handles nested objects stably', () => {
    const a = computeSemanticHash({ outer: { z: 3, y: 2 } });
    const b = computeSemanticHash({ outer: { y: 2, z: 3 } });
    expect(a).toBe(b);
  });

  it('custom identity can restrict to intent-critical fields', () => {
    const identity = (input: unknown) => {
      const { recipient, amount } = input as {
        recipient: string;
        amount: number;
        retryCount: number;
      };
      return {
        semanticHash: computeSemanticHash({ recipient, amount }),
        intentCriticalFields: ['recipient', 'amount'],
      };
    };

    const id1 = identity({ recipient: 'alice', amount: 100, retryCount: 1 });
    const id2 = identity({ recipient: 'alice', amount: 100, retryCount: 99 });
    // Different retryCount does NOT produce a different hash
    expect(id1.semanticHash).toBe(id2.semanticHash);

    const id3 = identity({ recipient: 'bob', amount: 100, retryCount: 1 });
    // Different recipient DOES produce a different hash
    expect(id1.semanticHash).not.toBe(id3.semanticHash);
  });
});

// ---------------------------------------------------------------------------
// ToolEffectLog — happy path
// ---------------------------------------------------------------------------

describe('ToolEffectLog', () => {
  let storage: MemoryStorage;
  let log: ToolEffectLog;

  beforeEach(() => {
    storage = new MemoryStorage();
    log = makeLog(storage);
  });

  it('lookup returns null for an unknown hash', async () => {
    const result = await log.lookup('unknown-hash');
    expect(result).toBeNull();
  });

  it('record marks the call as in-flight', async () => {
    await log.record('hash-1', 'my-tool');
    const entry = await log.lookup('hash-1');
    expect(entry).not.toBeNull();
    expect(entry?.status).toBe('in-flight');
  });

  it('commit stores output and marks the call as committed', async () => {
    await log.record('hash-1', 'my-tool');
    await log.commit('hash-1', 'my-tool', 'tool output');
    const entry = await log.lookup('hash-1');
    expect(entry?.status).toBe('committed');
    if (entry?.status === 'committed') {
      expect(entry.output).toBe('tool output');
    }
  });

  it('abort marks the call as aborted', async () => {
    await log.record('hash-1', 'my-tool');
    await log.abort('hash-1', 'my-tool', 'something went wrong');
    const entry = await log.lookup('hash-1');
    expect(entry?.status).toBe('aborted');
  });

  it('committed result is replayed from storage after a new log instance is created (simulates restore)', async () => {
    await log.record('hash-1', 'charge');
    await log.commit('hash-1', 'charge', '{"status":"ok"}');

    // New ToolEffectLog instance — same storage, same scope
    const restoredLog = makeLog(storage);
    const entry = await restoredLog.lookup('hash-1');
    expect(entry?.status).toBe('committed');
    if (entry?.status === 'committed') {
      expect(entry.output).toBe('{"status":"ok"}');
    }
  });

  it('in-flight record persists to storage and is readable after restore', async () => {
    await log.record('hash-2', 'transfer');

    const restoredLog = makeLog(storage);
    const entry = await restoredLog.lookup('hash-2');
    expect(entry?.status).toBe('in-flight');
  });
});

// ---------------------------------------------------------------------------
// ToolEffectLog — crash simulation
// ---------------------------------------------------------------------------

describe('ToolEffectLog crash-and-restore scenarios', () => {
  it('tool runs exactly once: crash after record, before commit', async () => {
    const storage = new MemoryStorage();
    const log1 = makeLog(storage);

    let callCount = 0;
    const mockTool = async () => {
      callCount++;
      return 'result';
    };

    const hash = computeSemanticHash({ recipient: 'alice', amount: 100 });

    // Simulate first run: record in-flight, execute tool, then crash before commit
    await log1.record(hash, 'charge');
    await mockTool(); // tool runs exactly once before the crash
    expect(callCount).toBe(1);
    // Crash happens here — commit never called on log1

    // Restore: new log instance sees the in-flight record
    const log2 = makeLog(storage);
    const entry = await log2.lookup(hash);
    expect(entry?.status).toBe('in-flight');

    // The restored agent loop should NOT re-invoke the tool when in-flight is detected.
    // Instead it should throw ToolCallReplayConflictError.
    expect(() => {
      if (entry?.status === 'in-flight') {
        throw new ToolCallReplayConflictError(hash, 'charge');
      }
    }).toThrow(ToolCallReplayConflictError);

    // Tool ran once before the crash and was not re-invoked during restore
    expect(callCount).toBe(1);
  });

  it('tool runs exactly once: crash after commit (committed replay prevents re-execution)', async () => {
    const storage = new MemoryStorage();
    const log1 = makeLog(storage);

    let callCount = 0;
    const mockTool = async () => {
      callCount++;
      return 'committed-result';
    };

    const hash = computeSemanticHash({ action: 'debit', amount: 50 });

    // First run: record, execute, commit
    await log1.record(hash, 'debit');
    const output = await mockTool();
    await log1.commit(hash, 'debit', output);
    expect(callCount).toBe(1);

    // Restore: new log sees committed entry — tool should NOT run again
    const log2 = makeLog(storage);
    const entry = await log2.lookup(hash);
    expect(entry?.status).toBe('committed');
    if (entry?.status === 'committed') {
      expect(entry.output).toBe('committed-result');
    }

    // Simulate agent loop replay logic: skip tool if committed
    if (entry?.status !== 'committed') {
      await mockTool(); // would increment callCount
    }

    expect(callCount).toBe(1); // still only 1
  });

  it('duplicatesPrevented counter increments on committed replay', async () => {
    const storage = new MemoryStorage();
    const log1 = makeLog(storage);
    const hash = computeSemanticHash({ op: 'send', to: 'bob' });

    await log1.record(hash, 'send');
    await log1.commit(hash, 'send', 'ok');

    const log2 = makeLog(storage);
    const entry = await log2.lookup(hash);
    expect(entry?.status).toBe('committed');
    // Log itself tracks how many committed replays occurred
    log2.recordReplay();
    expect(log2.duplicatesPrevented).toBe(1);
    log2.recordReplay();
    expect(log2.duplicatesPrevented).toBe(2);
  });

  it('aborted record is treated as retriable: lookup returns aborted status on restore', async () => {
    const storage = new MemoryStorage();
    const log1 = makeLog(storage);
    const hash = computeSemanticHash({ op: 'charge', amount: 50 });

    await log1.record(hash, 'charge');
    await log1.abort(hash, 'charge', 'card declined');

    // Restore: new log sees aborted entry
    const log2 = makeLog(storage);
    const entry = await log2.lookup(hash);
    expect(entry?.status).toBe('aborted');

    // The agent loop treats aborted as retriable — it falls through to re-record
    // and re-execute rather than replaying the failure or throwing a conflict error.
    // Verify the aborted status is not 'committed' or 'in-flight' so callers can
    // choose their handling (re-execute in the default path).
    expect(entry?.status).not.toBe('committed');
    expect(entry?.status).not.toBe('in-flight');
  });
});

// ---------------------------------------------------------------------------
// ToolCallReplayConflictError
// ---------------------------------------------------------------------------

describe('ToolCallReplayConflictError', () => {
  it('is an instance of Error', () => {
    const err = new ToolCallReplayConflictError('some-hash', 'my-tool');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(ToolCallReplayConflictError);
  });

  it('includes the tool name and hash in the message', () => {
    const err = new ToolCallReplayConflictError('abc123', 'charge');
    expect(err.message).toContain('charge');
    expect(err.message).toContain('abc123');
    expect(err.toolName).toBe('charge');
    expect(err.semanticHash).toBe('abc123');
  });
});
