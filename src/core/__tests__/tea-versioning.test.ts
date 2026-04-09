/**
 * End-to-end tests for TEA (Tool/Environment/Agent) versioning.
 *
 * Verifies that when a workflow is resumed after a tool/agent version change:
 * - Without a migration hook: throws VersionMismatchError with teaDiff
 * - With a migration hook: resumes normally
 */

import { describe, expect, it } from 'bun:test';

import { defineAgent } from '../../ai/declaration.ts';
import type { LLMProvider } from '../../ai/providers/interface.ts';
import type { ChatResponse } from '../../ai/providers/types.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import { Engine } from '../engine.ts';
import { VersionMismatchError } from '../versioning.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** An LLM provider whose chat call never resolves — keeps the workflow running. */
function makeBlockingProvider(): LLMProvider {
  return {
    name: 'blocking',
    chat: () =>
      new Promise<ChatResponse>(() => {
        /* never resolves */
      }),
    stream: async () => new ReadableStream(),
    countTokens: async () => 1,
  };
}

/** A minimal LLM provider that immediately returns a fixed response. */
function makeMockProvider(): LLMProvider {
  return {
    name: 'mock',
    async chat(): Promise<ChatResponse> {
      return {
        content: 'done',
        toolCalls: [],
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        model: 'test-model',
        stopReason: 'end_turn',
      };
    },
    async stream() {
      return new ReadableStream();
    },
    async countTokens(): Promise<number> {
      return 1;
    },
  };
}

/** Drain microtasks. */
async function flush(): Promise<void> {
  await Bun.sleep(20);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TEA versioning', () => {
  it('throws VersionMismatchError with teaDiff when tool version changes without a migration hook', async () => {
    const storage = new MemoryStorage();

    const toolV1 = {
      definition: {
        name: 'my-tool',
        description: 'A test tool',
        inputSchema: { type: 'object' as const, properties: {} },
      },
      execute: async (_input: unknown) => 'tool-result',
      version: '1.0.0',
    };

    const agentV1 = defineAgent({
      name: 'versioned-agent',
      model: 'test-model',
      version: '1.0.0',
      tools: [toolV1],
    });

    // Engine 1: start the workflow — it will block forever waiting for LLM
    const engine1 = new Engine({ storage });
    engine1.register(agentV1, { provider: makeBlockingProvider() });

    // Catch the rejection so it doesn't surface as an unhandled rejection.
    engine1.start('versioned-agent', 'hello', { id: 'wf-tea-test' }).catch(() => {
      /* expected: engine disposed before LLM resolves */
    });
    await flush();

    engine1[Symbol.dispose]();

    // Engine 2: same workflow name but bumped versions, no migration hook
    const toolV2 = {
      definition: {
        name: 'my-tool',
        description: 'A test tool',
        inputSchema: { type: 'object' as const, properties: {} },
      },
      execute: async (_input: unknown) => 'tool-result-v2',
      version: '2.0.0',
    };

    const agentV2 = defineAgent({
      name: 'versioned-agent',
      model: 'test-model',
      version: '2.0.0',
      tools: [toolV2],
    });

    const engine2 = new Engine({ storage });
    engine2.register(agentV2, { provider: makeMockProvider() });

    let caught: unknown;
    try {
      await engine2.resume('wf-tea-test');
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(VersionMismatchError);
    const vmError = caught as VersionMismatchError;
    expect(vmError.teaDiff).toBeDefined();
    // The workflow version changed 1.0.0 → 2.0.0
    expect(vmError.teaDiff?.workflowVersion).toEqual(['1.0.0', '2.0.0']);
    // The tool version changed 1.0.0 → 2.0.0
    const toolChange = vmError.teaDiff?.toolVersions?.find((c) => c.tool === 'my-tool');
    expect(toolChange).toBeDefined();
    expect(toolChange?.change).toBe('changed');
    if (toolChange?.change === 'changed') {
      expect(toolChange.from).toBe('1.0.0');
      expect(toolChange.to).toBe('2.0.0');
    }

    engine2[Symbol.dispose]();
  });

  it('resumes successfully when a migration hook is provided', async () => {
    const storage = new MemoryStorage();

    const toolV1 = {
      definition: {
        name: 'my-tool',
        description: 'A test tool',
        inputSchema: { type: 'object' as const, properties: {} },
      },
      execute: async (_input: unknown) => 'tool-result',
      version: '1.0.0',
    };

    const agentV1 = defineAgent({
      name: 'migration-agent',
      model: 'test-model',
      version: '1.0.0',
      tools: [toolV1],
    });

    // Engine 1: start the workflow — it will block forever waiting for LLM
    const engine1 = new Engine({ storage });
    engine1.register(agentV1, { provider: makeBlockingProvider() });

    engine1.start('migration-agent', 'hello', { id: 'wf-migration-test' }).catch(() => {
      /* expected: engine disposed before LLM resolves */
    });
    await flush();

    engine1[Symbol.dispose]();

    // Engine 2: register v2 WITH a migration hook — allows resume despite version mismatch
    const engine2 = new Engine({ storage });
    engine2.register('migration-agent', {
      handler: async function* () {
        return 'migrated';
      },
      version: '2.0.0',
      migrate: (checkpoint) => checkpoint,
    });

    const resumeHandle = await engine2.resume('wf-migration-test');
    // Resume returns a WorkflowHandle with the correct id
    expect(resumeHandle.id).toBe('wf-migration-test');

    engine2[Symbol.dispose]();
  });
});
