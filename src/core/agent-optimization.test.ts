import { describe, expect, it } from 'bun:test';
import { sleepForTesting } from '../testing/fake-timers.ts';

import { defineAgent } from '../ai/declaration.ts';
import type { LLMProvider } from '../ai/providers/interface.ts';
import type { ChatResponse } from '../ai/providers/types.ts';
import { Context } from '../core/context.ts';
import type { WorkflowContext } from '../core/types.ts';
import { CompressedStorage } from '../storage/compressed-storage.ts';
import { MemoryStorage } from '../storage/memory.ts';
import { TestEngine } from '../testing/test-engine.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function flush(): Promise<void> {
  await sleepForTesting(10);
}

function createChatResponse(content: string): ChatResponse {
  return {
    content,
    toolCalls: [],
    usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
    model: 'test-model',
    stopReason: 'end_turn',
  };
}

function createMockProvider(responses: ChatResponse[]): LLMProvider {
  let callIndex = 0;
  return {
    name: 'mock',
    async chat(): Promise<ChatResponse> {
      return responses[callIndex++]!;
    },
    async stream() {
      return new ReadableStream();
    },
    async countTokens(): Promise<number> {
      return 100;
    },
  };
}

// ---------------------------------------------------------------------------
// Step 0: Agent detection infrastructure
// ---------------------------------------------------------------------------

describe('Agent detection infrastructure', () => {
  it('isAgentWorkflow returns true for agent-registered workflows', async () => {
    const engine = new TestEngine();
    const provider = createMockProvider([createChatResponse('done')]);

    const agent = defineAgent({ name: 'detector-agent', model: 'test-model' });
    engine.register(agent, { provider });

    const handle = await engine.start('detector-agent', 'hello');
    expect(engine.isAgentWorkflow(handle.id)).toBe(true);

    await flush();
    await handle.result();
  });

  it('isAgentWorkflow returns false for normal workflows', async () => {
    const engine = new TestEngine();
    engine.register('normal-wf', async function* () {
      return 'done';
    });

    const handle = await engine.start('normal-wf', {});
    expect(engine.isAgentWorkflow(handle.id)).toBe(false);

    await flush();
    await handle.result();
  });

  it('agent tracking cleaned up on workflow completion', async () => {
    const engine = new TestEngine();
    const provider = createMockProvider([createChatResponse('done')]);

    const agent = defineAgent({ name: 'cleanup-agent', model: 'test-model' });
    engine.register(agent, { provider });

    const handle = await engine.start('cleanup-agent', 'test');
    expect(engine.isAgentWorkflow(handle.id)).toBe(true);

    await flush();
    await handle.result();

    // After completion, the tracking should be cleaned up
    expect(engine.isAgentWorkflow(handle.id)).toBe(false);
  });

  it('agent tracking cleaned up on workflow failure', async () => {
    const engine = new TestEngine();

    const failProvider: LLMProvider = {
      name: 'fail',
      async chat(): Promise<ChatResponse> {
        throw new Error('provider error');
      },
      async stream() {
        return new ReadableStream();
      },
      async countTokens(): Promise<number> {
        return 100;
      },
    };

    const agent = defineAgent({ name: 'fail-agent', model: 'test-model' });
    engine.register(agent, { provider: failProvider });

    const handle = await engine.start('fail-agent', 'test');
    // Suppress unhandled rejection — we expect this to fail
    const resultPromise = handle.result().catch(() => {});
    expect(engine.isAgentWorkflow(handle.id)).toBe(true);

    await flush();
    await resultPromise;
    await flush();

    expect(engine.isAgentWorkflow(handle.id)).toBe(false);
  });

  it('agent tracking cleaned up on workflow cancellation', async () => {
    const engine = new TestEngine();

    // Use a workflow that sleeps so we have time to cancel it
    engine.register('cancel-wf', async function* (ctx: WorkflowContext) {
      yield* (ctx as Context).sleep('1 hour');
      return 'done';
    });

    const handle = await engine.start('cancel-wf', {});
    // Suppress unhandled rejection from the cancelled workflow
    handle.result().catch(() => {});
    await flush();
    await handle.cancel();
    await flush();

    // Verify cancellation works for non-agent workflows (baseline)
    expect(engine.isAgentWorkflow(handle.id)).toBe(false);

    // Now test with an actual agent workflow using a separate engine
    const engine2 = new TestEngine();
    const hangProvider: LLMProvider = {
      name: 'hang',
      async chat(_messages, options): Promise<ChatResponse> {
        // Wait until aborted
        return new Promise((_resolve, reject) => {
          if (options?.signal) {
            options.signal.addEventListener('abort', () => reject(new Error('aborted')));
          }
        });
      },
      async stream() {
        return new ReadableStream();
      },
      async countTokens(): Promise<number> {
        return 100;
      },
    };

    const agent = defineAgent({ name: 'cancel-agent', model: 'test-model' });
    engine2.register(agent, { provider: hangProvider });

    const agentHandle = await engine2.start('cancel-agent', 'test');
    // Suppress unhandled rejection from the cancelled workflow
    agentHandle.result().catch(() => {});
    expect(engine2.isAgentWorkflow(agentHandle.id)).toBe(true);

    await flush();
    await agentHandle.cancel();
    await flush();

    expect(engine2.isAgentWorkflow(agentHandle.id)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Step 2: LLM connection pre-warming
// ---------------------------------------------------------------------------

describe('LLM connection pre-warming', () => {
  it('calls warmup on provider when agent workflow starts', async () => {
    const warmupCalls: string[] = [];
    const provider: LLMProvider = {
      name: 'warmup-provider',
      async chat(): Promise<ChatResponse> {
        return createChatResponse('done');
      },
      async stream() {
        return new ReadableStream();
      },
      async countTokens(): Promise<number> {
        return 100;
      },
      async warmup() {
        warmupCalls.push('warmed');
      },
    };

    const engine = new TestEngine();
    const agent = defineAgent({ name: 'warm-agent', model: 'test-model' });
    engine.register(agent, { provider });

    await engine.start('warm-agent', 'test');
    await flush();

    expect(warmupCalls).toEqual(['warmed']);
  });

  it('does NOT call warmup for normal workflows', async () => {
    const warmupCalls: string[] = [];
    const engine = new TestEngine();

    // Register an agent with a warmup-capable provider on the same engine
    const agent = defineAgent({ name: 'agent-with-warmup', model: 'test-model' });
    engine.register(agent, {
      provider: {
        name: 'with-warmup',
        async chat(): Promise<ChatResponse> {
          return createChatResponse('done');
        },
        async stream() {
          return new ReadableStream();
        },
        async countTokens(): Promise<number> {
          return 100;
        },
        async warmup() {
          warmupCalls.push('warmed');
        },
      },
    });

    // Register and start a normal (non-agent) workflow
    engine.register('normal', async function* () {
      return 'done';
    });

    const handle = await engine.start('normal', {});
    await flush();
    await handle.result();

    // The agent's warmup should NOT have been triggered by the normal workflow start
    expect(warmupCalls).toEqual([]);
  });

  it('warmup failure does not affect workflow execution', async () => {
    const provider: LLMProvider = {
      name: 'fail-warmup',
      async chat(): Promise<ChatResponse> {
        return createChatResponse('still works');
      },
      async stream() {
        return new ReadableStream();
      },
      async countTokens(): Promise<number> {
        return 100;
      },
      async warmup() {
        throw new Error('warmup failed');
      },
    };

    const engine = new TestEngine();
    const agent = defineAgent({ name: 'resilient-agent', model: 'test-model' });
    engine.register(agent, { provider });

    const handle = await engine.start('resilient-agent', 'test');
    await flush();
    const result = await handle.result();

    expect(result).toBe('still works');
  });

  it('skips warmup when provider does not implement it', async () => {
    const provider = createMockProvider([createChatResponse('done')]);
    // provider has no warmup method

    const engine = new TestEngine();
    const agent = defineAgent({ name: 'no-warmup-agent', model: 'test-model' });
    engine.register(agent, { provider });

    const handle = await engine.start('no-warmup-agent', 'test');
    await flush();
    const result = await handle.result();

    expect(result).toBe('done');
  });
});

// ---------------------------------------------------------------------------
// Step 3: Checkpoint compression for conversation-heavy state
// ---------------------------------------------------------------------------

describe('Agent-aware checkpoint compression', () => {
  it('uses brotli for agent workflow checkpoints', async () => {
    const inner = new MemoryStorage();
    const agentWorkflowIds = new Set<string>();
    const storage = new CompressedStorage(inner, {
      threshold: 64,
      agentWorkflowIds: () => agentWorkflowIds,
      agentAlgorithm: 'brotli',
      agentThreshold: 32,
    });

    const workflowId = 'agent-wf-123';
    agentWorkflowIds.add(workflowId);

    // Write a payload large enough to trigger compression
    const conversationData = new TextEncoder().encode(
      JSON.stringify({ messages: Array.from({ length: 20 }, (_, i) => `message ${i}`) }),
    );

    await storage.put(`wf:${workflowId}:ckpt`, conversationData);

    // Read back — should decompress correctly regardless of algorithm
    const result = await storage.get(`wf:${workflowId}:ckpt`);
    expect(result).not.toBeNull();
    expect(new TextDecoder().decode(result!)).toBe(new TextDecoder().decode(conversationData));

    // Verify the raw stored data uses brotli (algorithm byte 0x02)
    const raw = await inner.get(`wf:${workflowId}:ckpt`);
    expect(raw).not.toBeNull();
    expect(raw![0]).toBe(0xc1); // magic byte
    expect(raw![1]).toBe(0x02); // brotli
  });

  it('uses default gzip for non-agent workflows', async () => {
    const inner = new MemoryStorage();
    const agentWorkflowIds = new Set<string>();
    const storage = new CompressedStorage(inner, {
      threshold: 64,
      agentWorkflowIds: () => agentWorkflowIds,
    });

    const workflowId = 'normal-wf-456';
    // NOT in agentWorkflowIds

    const data = new TextEncoder().encode(
      JSON.stringify({ state: Array.from({ length: 20 }, (_, i) => `item ${i}`) }),
    );

    await storage.put(`wf:${workflowId}:ckpt`, data);

    // Read back
    const result = await storage.get(`wf:${workflowId}:ckpt`);
    expect(result).not.toBeNull();
    expect(new TextDecoder().decode(result!)).toBe(new TextDecoder().decode(data));

    // Verify the raw stored data uses gzip (algorithm byte 0x01)
    const raw = await inner.get(`wf:${workflowId}:ckpt`);
    expect(raw).not.toBeNull();
    expect(raw![0]).toBe(0xc1); // magic byte
    expect(raw![1]).toBe(0x01); // gzip
  });

  it('mixed reads work correctly (brotli + gzip in same storage)', async () => {
    const inner = new MemoryStorage();
    const agentWorkflowIds = new Set(['agent-wf']);
    const storage = new CompressedStorage(inner, {
      threshold: 64,
      agentWorkflowIds: () => agentWorkflowIds,
      agentAlgorithm: 'brotli',
      agentThreshold: 32,
    });

    const agentData = new TextEncoder().encode(
      JSON.stringify({ messages: Array.from({ length: 20 }, (_, i) => `agent msg ${i}`) }),
    );
    const normalData = new TextEncoder().encode(
      JSON.stringify({ state: Array.from({ length: 20 }, (_, i) => `normal state ${i}`) }),
    );

    await storage.put('wf:agent-wf:ckpt', agentData);
    await storage.put('wf:normal-wf:ckpt', normalData);

    // Both should read back correctly
    const agentResult = await storage.get('wf:agent-wf:ckpt');
    const normalResult = await storage.get('wf:normal-wf:ckpt');

    expect(new TextDecoder().decode(agentResult!)).toBe(new TextDecoder().decode(agentData));
    expect(new TextDecoder().decode(normalResult!)).toBe(new TextDecoder().decode(normalData));
  });

  it('zero overhead when no agent workflows registered', async () => {
    const inner = new MemoryStorage();
    const emptySet = new Set<string>();
    const storage = new CompressedStorage(inner, {
      threshold: 64,
      agentWorkflowIds: () => emptySet,
      agentAlgorithm: 'brotli',
      agentThreshold: 32,
    });

    const data = new TextEncoder().encode(
      JSON.stringify({ state: Array.from({ length: 20 }, (_, i) => `item ${i}`) }),
    );

    await storage.put('wf:any-wf:ckpt', data);

    // Should use default gzip, not brotli
    const raw = await inner.get('wf:any-wf:ckpt');
    expect(raw![0]).toBe(0xc1);
    expect(raw![1]).toBe(0x01); // gzip
  });

  it('batch operations respect agent-aware compression', async () => {
    const inner = new MemoryStorage();
    const agentWorkflowIds = new Set(['agent-batch-wf']);
    const storage = new CompressedStorage(inner, {
      threshold: 64,
      agentWorkflowIds: () => agentWorkflowIds,
      agentAlgorithm: 'brotli',
      agentThreshold: 32,
    });

    const agentData = new TextEncoder().encode(
      JSON.stringify({ messages: Array.from({ length: 20 }, (_, i) => `batch msg ${i}`) }),
    );
    const normalData = new TextEncoder().encode(
      JSON.stringify({ state: Array.from({ length: 20 }, (_, i) => `batch state ${i}`) }),
    );

    await storage.batch([
      { type: 'put', key: 'wf:agent-batch-wf:ckpt', value: agentData },
      { type: 'put', key: 'wf:normal-batch-wf:ckpt', value: normalData },
    ]);

    // Agent checkpoint should use brotli
    const rawAgent = await inner.get('wf:agent-batch-wf:ckpt');
    expect(rawAgent![1]).toBe(0x02); // brotli

    // Normal checkpoint should use gzip
    const rawNormal = await inner.get('wf:normal-batch-wf:ckpt');
    expect(rawNormal![1]).toBe(0x01); // gzip
  });
});
