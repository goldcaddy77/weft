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
    const provider = makeMockProvider();

    // --- v1: register agent with tool@1.0.0 ---
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

    const engine1 = new Engine({ storage });
    engine1.register(agentV1, { provider });

    await engine1.start('versioned-agent', 'hello');
    await flush();

    // Workflow should have completed — agent returns immediately with mock provider.
    // We just need the state persisted. If it completed, that's fine for our test
    // since we can also test the resume path by forcing a "running" state.
    // Instead, let's test via a workflow that pauses, so we manually park it.
    engine1[Symbol.dispose]();

    // --- Approach: use a raw Engine and plain WorkflowRegistration with agentVersion/toolVersions ---
    // Since only AgentDefinition registrations populate agentVersion/toolVersions,
    // we verify the teaDiff via the public API.

    // Create a second engine with the same storage but tool bumped to 2.0.0, no migrate
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
      version: '2.0.0', // bumped workflow version triggers incompatibility
      tools: [toolV2],
    });

    const engine2 = new Engine({ storage });
    engine2.register(agentV2, { provider });

    // Find any running workflow — if the mock provider completes immediately the
    // workflow may be done. Re-run with a storage that has a running workflow.
    const storage2 = new MemoryStorage();
    const provider2 = makeMockProvider();

    // Workflow that blocks on sleep so it stays in running state
    const blockingProvider: LLMProvider = {
      name: 'blocking',
      chat: () =>
        new Promise<ChatResponse>(() => {
          /* never resolves */
        }),
      stream: async () => new ReadableStream(),
      countTokens: async () => 1,
    };

    const agentV1b = defineAgent({
      name: 'versioned-agent',
      model: 'test-model',
      version: '1.0.0',
      tools: [toolV1],
    });

    const engine3 = new Engine({ storage: storage2 });
    engine3.register(agentV1b, { provider: blockingProvider });

    // Start workflow — it will block forever waiting for LLM
    const startHandle = engine3.start('versioned-agent', 'hello', { id: 'wf-tea-test' });
    await flush();
    void startHandle; // fire-and-forget; workflow is now "running" and blocked

    engine3[Symbol.dispose]();

    // --- Resume with v2 (tool bumped, no migrate) ---
    const agentV2b = defineAgent({
      name: 'versioned-agent',
      model: 'test-model',
      version: '2.0.0',
      tools: [toolV2],
    });

    const engine4 = new Engine({ storage: storage2 });
    engine4.register(agentV2b, { provider: provider2 });

    await expect(engine4.resume('wf-tea-test')).rejects.toThrow(VersionMismatchError);

    try {
      await engine4.resume('wf-tea-test');
    } catch (error) {
      expect(error).toBeInstanceOf(VersionMismatchError);
      const vmError = error as VersionMismatchError;
      expect(vmError.teaDiff).toBeDefined();
      // The workflow version changed 1.0.0 → 2.0.0
      expect(vmError.teaDiff?.workflowVersion).toEqual(['1.0.0', '2.0.0']);
      // The tool version changed 1.0.0 → 2.0.0
      expect(vmError.teaDiff?.toolVersions).toBeDefined();
      const toolChange = vmError.teaDiff?.toolVersions?.find((c) => c.tool === 'my-tool');
      expect(toolChange).toBeDefined();
      expect(toolChange?.change).toBe('changed');
      expect(toolChange?.from).toBe('1.0.0');
      expect(toolChange?.to).toBe('2.0.0');
    }

    engine4[Symbol.dispose]();
  });

  it('resumes successfully when a migration hook is provided', async () => {
    const storage = new MemoryStorage();

    const blockingProvider: LLMProvider = {
      name: 'blocking',
      chat: () =>
        new Promise<ChatResponse>(() => {
          /* never resolves */
        }),
      stream: async () => new ReadableStream(),
      countTokens: async () => 1,
    };

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

    // Engine 1: start the workflow (will block on LLM call)
    const engine1 = new Engine({ storage });
    engine1.register(agentV1, { provider: blockingProvider });

    const startHandle = engine1.start('migration-agent', 'hello', { id: 'wf-migration-test' });
    await flush();
    void startHandle;

    engine1[Symbol.dispose]();

    // Engine 2: register v2 WITH a migration hook (plain handler, no agent definition needed)
    const engine2 = new Engine({ storage });
    // Register with a no-op migration hook — this allows resume despite version mismatch
    engine2.register('migration-agent', {
      handler: async function* () {
        return 'migrated';
      },
      version: '2.0.0',
      migrate: (checkpoint) => checkpoint,
    });

    const resumeHandle = await engine2.resume('wf-migration-test');
    expect(resumeHandle).toBeDefined();

    engine2[Symbol.dispose]();
  });
});
