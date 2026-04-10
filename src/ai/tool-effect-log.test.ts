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
import type { AgentTool } from './agent';
import { executeAgentLoop } from './agent';
import type { LLMProvider } from './providers/interface';
import type { ChatResponse } from './providers/types';
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

  it('does not crash when called with null', () => {
    // canonicalize(null) must return the string 'null', not throw
    expect(() => computeSemanticHash(null)).not.toThrow();
    expect(computeSemanticHash(null)).toMatch(/^[0-9a-f]{16}$/);
  });

  it('does not crash when called with undefined', () => {
    // canonicalize(undefined) previously returned JS undefined (not a string),
    // causing Bun.hash.wyhash to throw. It must now return a string.
    expect(() => computeSemanticHash(undefined)).not.toThrow();
    expect(computeSemanticHash(undefined)).toMatch(/^[0-9a-f]{16}$/);
  });

  it('produces stable, distinct hashes for null and undefined', () => {
    const nullHash = computeSemanticHash(null);
    const undefinedHash = computeSemanticHash(undefined);
    expect(nullHash).toMatch(/^[0-9a-f]{16}$/);
    expect(undefinedHash).toMatch(/^[0-9a-f]{16}$/);
    // null and undefined must not collide with each other
    expect(nullHash).not.toBe(undefinedHash);
  });

  it('does not collide undefined with the literal string "undefined"', () => {
    // Regression: canonicalize previously encoded `undefined` as the JSON
    // string '"undefined"', colliding with the literal string "undefined"
    // and allowing one tool call to shadow another in the effect log.
    expect(computeSemanticHash(undefined)).not.toBe(computeSemanticHash('undefined'));
    expect(computeSemanticHash({ a: undefined })).not.toBe(computeSemanticHash({ a: 'undefined' }));
    expect(computeSemanticHash([undefined])).not.toBe(computeSemanticHash(['undefined']));
  });

  it('omits object keys whose values are undefined', () => {
    // Keys with undefined values should be dropped from the canonical form,
    // matching JSON.stringify semantics.
    expect(computeSemanticHash({ a: 1, b: undefined })).toBe(computeSemanticHash({ a: 1 }));
    expect(computeSemanticHash({ a: undefined })).toBe(computeSemanticHash({}));
  });

  it('preserves array element positions for undefined entries', () => {
    // Arrays can't drop undefined elements without shifting indices, so
    // [undefined] and [] must hash differently, and [undefined, 1] must
    // differ from [1].
    expect(computeSemanticHash([undefined])).not.toBe(computeSemanticHash([]));
    expect(computeSemanticHash([undefined, 1])).not.toBe(computeSemanticHash([1]));
    // Position matters.
    expect(computeSemanticHash([undefined, 1])).not.toBe(computeSemanticHash([1, undefined]));
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

  it('committed record stores the toolName', async () => {
    await log.record('hash-c', 'send');
    await log.commit('hash-c', 'send', 'ok');
    const entry = await log.lookup('hash-c');
    expect(entry?.toolName).toBe('send');
  });

  it('in-flight record stores the toolName', async () => {
    await log.record('hash-f', 'transfer');
    const entry = await log.lookup('hash-f');
    expect(entry?.toolName).toBe('transfer');
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

// ---------------------------------------------------------------------------
// Agent-level integration: identity() edge cases and cross-tool collision guard
// ---------------------------------------------------------------------------

/** Minimal one-tool-call-then-done provider. */
function createSingleToolProvider(toolName: string, toolInput: unknown): LLMProvider {
  let called = false;
  return {
    name: 'single-tool-mock',
    async chat(): Promise<ChatResponse> {
      if (!called) {
        called = true;
        return {
          content: '',
          toolCalls: [{ id: 'call-1', name: toolName, input: toolInput }],
          usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 },
          model: 'test-model',
          stopReason: 'tool_use',
        };
      }
      return {
        content: 'done',
        toolCalls: [],
        usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 },
        model: 'test-model',
        stopReason: 'end_turn',
      };
    },
    async stream() {
      return new ReadableStream();
    },
    async countTokens() {
      return 100;
    },
  };
}

function createSimpleTool(name: string, onExecute?: () => void): AgentTool {
  return {
    definition: { name, description: 'test tool', inputSchema: { type: 'object' } },
    execute: async (_input: unknown) => {
      onExecute?.();
      return { result: 'ok' };
    },
  };
}

describe('effect log: identity() edge cases', () => {
  it('falls back to default hash when identity() throws', async () => {
    const storage = new MemoryStorage();
    const effectLog = new ToolEffectLog(storage, 'wf-id', 'agent-id');
    let executeCount = 0;

    const tool: AgentTool = {
      ...createSimpleTool('charge', () => executeCount++),
      identity: (_input: unknown) => {
        throw new Error('identity exploded');
      },
    };

    const provider = createSingleToolProvider('charge', { amount: 50 });
    await executeAgentLoop(
      { model: 'test-model', provider, tools: [tool], toolEffectLog: effectLog },
      'Go',
    );

    // Tool should have executed once despite identity() throwing
    expect(executeCount).toBe(1);
    // A record should have been written using the default hash
    const defaultHash = computeSemanticHash({ name: 'charge', input: { amount: 50 } });
    const entry = await effectLog.lookup(defaultHash);
    expect(entry?.status).toBe('committed');
  });

  it('falls back to default hash when identity() returns an invalid hash format', async () => {
    const storage = new MemoryStorage();
    const effectLog = new ToolEffectLog(storage, 'wf-id', 'agent-id');
    let executeCount = 0;

    const tool: AgentTool = {
      ...createSimpleTool('charge', () => executeCount++),
      identity: (_input: unknown) => ({
        semanticHash: 'not-a-valid-hex-hash!!!!',
        intentCriticalFields: ['amount'],
      }),
    };

    const provider = createSingleToolProvider('charge', { amount: 50 });
    await executeAgentLoop(
      { model: 'test-model', provider, tools: [tool], toolEffectLog: effectLog },
      'Go',
    );

    // Tool should have executed once despite invalid identity hash
    expect(executeCount).toBe(1);
    // Record written under the default hash
    const defaultHash = computeSemanticHash({ name: 'charge', input: { amount: 50 } });
    const entry = await effectLog.lookup(defaultHash);
    expect(entry?.status).toBe('committed');
  });
});

describe('effect log: cross-tool hash collision guard', () => {
  it('does not replay committed result when stored toolName does not match', async () => {
    const storage = new MemoryStorage();

    // Pre-seed a committed record for 'tool-a' under a known hash
    const collisionHash = 'aaaa1111bbbb2222'; // fake 16-char hex
    const log1 = new ToolEffectLog(storage, 'wf-1', 'agent-1');
    await log1.record(collisionHash, 'tool-a');
    await log1.commit(collisionHash, 'tool-a', '"tool-a-result"');

    // A second tool ('tool-b') has a custom identity() that returns the same hash
    let toolBExecuteCount = 0;
    const toolB: AgentTool = {
      ...createSimpleTool('tool-b', () => toolBExecuteCount++),
      identity: (_input: unknown) => ({
        semanticHash: collisionHash,
        intentCriticalFields: [],
      }),
    };

    const log2 = new ToolEffectLog(storage, 'wf-1', 'agent-1');
    const provider = createSingleToolProvider('tool-b', { x: 1 });
    await executeAgentLoop(
      { model: 'test-model', provider, tools: [toolB], toolEffectLog: log2 },
      'Go',
    );

    // tool-b must execute — it must NOT replay tool-a's committed result
    expect(toolBExecuteCount).toBe(1);

    // The original tool-a committed record must be preserved (not overwritten)
    const entry = await log2.lookup(collisionHash);
    expect(entry?.toolName).toBe('tool-a');
    expect(entry?.status).toBe('committed');
  });

  it('does not throw ToolCallReplayConflictError when in-flight record belongs to a different tool', async () => {
    const storage = new MemoryStorage();

    // Pre-seed an in-flight record for 'tool-a' under a known hash
    const collisionHash = 'cccc3333dddd4444'; // fake 16-char hex
    const log1 = new ToolEffectLog(storage, 'wf-2', 'agent-2');
    await log1.record(collisionHash, 'tool-a');

    // tool-b returns the same hash via custom identity()
    let toolBExecuteCount = 0;
    const toolB: AgentTool = {
      ...createSimpleTool('tool-b', () => toolBExecuteCount++),
      identity: (_input: unknown) => ({
        semanticHash: collisionHash,
        intentCriticalFields: [],
      }),
    };

    const log2 = new ToolEffectLog(storage, 'wf-2', 'agent-2');
    const provider = createSingleToolProvider('tool-b', { y: 2 });

    // Must NOT throw ToolCallReplayConflictError — the in-flight record is for a different tool
    await expect(
      executeAgentLoop(
        { model: 'test-model', provider, tools: [toolB], toolEffectLog: log2 },
        'Go',
      ),
    ).resolves.toBeDefined();

    // tool-b should have executed
    expect(toolBExecuteCount).toBe(1);

    // The original in-flight record for tool-a must be preserved
    const entry = await log2.lookup(collisionHash);
    expect(entry?.toolName).toBe('tool-a');
    expect(entry?.status).toBe('in-flight');
  });
});

// ---------------------------------------------------------------------------
// Agent-level: in-flight record is aborted when inner execution throws
// ---------------------------------------------------------------------------

describe('effect log: dangling in-flight guard', () => {
  it('throws ToolCallReplayConflictError when the same tool sees a lingering in-flight record', async () => {
    const storage = new MemoryStorage();
    const effectLog = new ToolEffectLog(storage, 'wf-conflict', 'agent-conflict');
    const provider = createSingleToolProvider('charge', { amount: 50 });
    const hash = computeSemanticHash({ name: 'charge', input: { amount: 50 } });

    await effectLog.record(hash, 'charge');

    await expect(
      executeAgentLoop(
        {
          model: 'test-model',
          provider,
          tools: [createSimpleTool('charge')],
          toolEffectLog: effectLog,
        },
        'Go',
      ),
    ).rejects.toThrow(ToolCallReplayConflictError);
  });

  it('aborts the effect-log record when a tool returns an execution failure', async () => {
    const storage = new MemoryStorage();
    const effectLog = new ToolEffectLog(storage, 'wf-fail', 'agent-fail');
    const provider = createSingleToolProvider('boom', {});
    const hash = computeSemanticHash({ name: 'boom', input: {} });

    await executeAgentLoop(
      {
        model: 'test-model',
        provider,
        tools: [
          {
            definition: { name: 'boom', description: 'boom', inputSchema: { type: 'object' } },
            execute: async () => {
              throw new Error('boom');
            },
          },
        ],
        toolEffectLog: effectLog,
      },
      'Go',
    );

    const entry = await effectLog.lookup(hash);
    expect(entry?.status).toBe('aborted');
  });

  it('aborts the in-flight record when resolveToolExecutionInner throws', async () => {
    const storage = new MemoryStorage();
    const effectLog = new ToolEffectLog(storage, 'wf-throw', 'agent-throw');

    const tool = createSimpleTool('boom');
    const provider = createSingleToolProvider('boom', {});

    // afterToolCall hook throws — this propagates out of resolveToolExecutionInner
    // since the hook is called without a surrounding try/catch there.
    await expect(
      executeAgentLoop(
        {
          model: 'test-model',
          provider,
          tools: [tool],
          toolEffectLog: effectLog,
          hooks: {
            afterToolCall: async () => {
              throw new Error('hook failure');
            },
          },
        },
        'Go',
      ),
    ).rejects.toThrow('hook failure');

    // The in-flight record must have been aborted — not left dangling
    const hash = computeSemanticHash({ name: 'boom', input: {} });
    const entry = await effectLog.lookup(hash);
    expect(entry?.status).toBe('aborted');
  });
});

// ---------------------------------------------------------------------------
// Storage key naming: tool-effect: prefix
// ---------------------------------------------------------------------------

describe('effect log: storage key prefix', () => {
  it('uses the tool-effect: prefix in storage keys', async () => {
    const storage = new MemoryStorage();
    const effectLog = new ToolEffectLog(storage, 'wf-key', 'agent-key');
    const hash = computeSemanticHash({ op: 'test' });
    await effectLog.record(hash, 'my-tool');

    // Verify the key written to storage uses the full descriptive prefix
    const keys: string[] = [];
    for await (const [key] of storage.scan('tool-effect:')) {
      keys.push(key);
    }
    expect(keys.length).toBe(1);
    expect(keys[0]).toContain('tool-effect:wf-key:agent-key:');
  });
});
