import { sleepForTesting } from '../../testing/fake-timers.ts';
/**
 * End-to-end tests for workflow, agent, and tool version tracking on resume.
 *
 * Verifies that when a workflow is resumed after an agent or tool change:
 * - Without a migration hook: throws VersionMismatchError with versionDiff
 * - With a migration hook: resumes normally
 * - Legacy agent workflows are upgraded with version metadata on resume
 */

import { describe, expect, it } from 'bun:test';

import type { ChatResponse, LLMProvider } from '../../ai/agent/index.ts';
import { agent as createAgentDefinition, type AgentToolDefinition } from '../../ai/declaration.ts';
import { KEYS } from '../../storage/interface.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import { decode, encode } from '../codec.ts';
import { Engine } from '../engine.ts';
import type { WorkflowState } from '../types.ts';
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
  };
}

/** Drain microtasks. */
async function flush(): Promise<void> {
  await sleepForTesting(20);
}

function createVersionedTool(name: string, version: string, output: string): AgentToolDefinition {
  return {
    name,
    description: 'A test tool',
    input: { type: 'object' as const, properties: {} },
    execute: async (_input: unknown) => output,
    version,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('workflow version resume checks', () => {
  it('throws VersionMismatchError with versionDiff when agent and tool versions change without a migration hook', async () => {
    const storage = new MemoryStorage();

    const toolV1 = createVersionedTool('my-tool', '1.0.0', 'tool-result');

    const agentV1 = createAgentDefinition({
      name: 'versioned-agent',
      model: 'test-model',
      version: '1.0.0',
      tools: [toolV1],
    });

    // Engine 1: start the workflow — it will block forever waiting for LLM
    const engine1 = new Engine({ storage });
    engine1.register(agentV1, { provider: makeBlockingProvider() });

    // Catch the rejection so it doesn't surface as an unhandled rejection.
    engine1.start('versioned-agent', 'hello', { id: 'wf-version-resume-test' }).catch(() => {
      /* expected: engine disposed before LLM resolves */
    });
    await flush();

    engine1[Symbol.dispose]();

    // Engine 2: same workflow name but bumped versions, no migration hook
    const toolV2 = createVersionedTool('my-tool', '2.0.0', 'tool-result-v2');

    const agentV2 = createAgentDefinition({
      name: 'versioned-agent',
      model: 'test-model',
      version: '2.0.0',
      tools: [toolV2],
    });

    const engine2 = new Engine({ storage });
    engine2.register(agentV2, { provider: makeMockProvider() });

    let caught: unknown;
    try {
      await engine2.resume('wf-version-resume-test');
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(VersionMismatchError);
    const vmError = caught as VersionMismatchError;
    expect(vmError.versionDiff).toBeDefined();
    expect(vmError.versionDiff?.workflowVersion).toBeUndefined();
    expect(vmError.versionDiff?.agentVersion).toEqual(['1.0.0', '2.0.0']);
    // The tool version changed 1.0.0 → 2.0.0
    const toolChange = vmError.versionDiff?.toolVersions?.find((c) => c.tool === 'my-tool');
    expect(toolChange).toBeDefined();
    expect(toolChange?.change).toBe('changed');
    if (toolChange?.change === 'changed') {
      expect(toolChange.from).toBe('1.0.0');
      expect(toolChange.to).toBe('2.0.0');
    }

    engine2[Symbol.dispose]();
  });

  it('throws VersionMismatchError when only the tool version drifts', async () => {
    const storage = new MemoryStorage();

    const toolV1 = createVersionedTool('same-workflow-tool', '1.0.0', 'tool-result');

    const agentV1 = createAgentDefinition({
      name: 'tool-drift-agent',
      model: 'test-model',
      version: '1.0.0',
      tools: [toolV1],
    });

    const engine1 = new Engine({ storage });
    engine1.register(agentV1, { provider: makeBlockingProvider() });
    engine1.start('tool-drift-agent', 'hello', { id: 'wf-tool-drift' }).catch(() => {
      /* expected: engine disposed before LLM resolves */
    });
    await flush();

    engine1[Symbol.dispose]();

    const toolV2 = createVersionedTool('same-workflow-tool', '2.0.0', 'tool-result-v2');

    const agentV2 = createAgentDefinition({
      name: 'tool-drift-agent',
      model: 'test-model',
      version: '1.0.0',
      tools: [toolV2],
    });

    const engine2 = new Engine({ storage });
    engine2.register(agentV2, { provider: makeMockProvider() });

    let caught: unknown;
    try {
      await engine2.resume('wf-tool-drift');
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(VersionMismatchError);
    const vmError = caught as VersionMismatchError;
    expect(vmError.versionDiff?.workflowVersion).toBeUndefined();
    const toolChange = vmError.versionDiff?.toolVersions?.find(
      (c) => c.tool === 'same-workflow-tool',
    );
    expect(toolChange).toBeDefined();
    expect(toolChange?.change).toBe('changed');

    engine2[Symbol.dispose]();
  });

  it('captures static agent tool versions in workflow state at start', async () => {
    const storage = new MemoryStorage();

    const proTool = createVersionedTool('pro-tool', '2.0.0', 'pro');

    const agent = createAgentDefinition({
      name: 'tenant-aware-agent',
      model: 'test-model',
      version: '1.0.0',
      tools: [proTool],
    });

    const engine = new Engine({
      storage,
      tenantResolver: {
        resolve: () => ({ id: 'pro' }),
      },
    });
    engine.register(agent, { provider: makeBlockingProvider() });
    engine.start('tenant-aware-agent', 'hello', { id: 'wf-tenant-tool-versions' }).catch(() => {
      /* expected: engine disposed before LLM resolves */
    });
    await flush();

    const state = await engine.get('wf-tenant-tool-versions');
    expect(state?.toolVersions).toEqual(['pro-tool@2.0.0']);

    engine[Symbol.dispose]();
  });

  it('resumes a legacy agent workflow and backfills version metadata', async () => {
    const storage = new MemoryStorage();

    const legacyTool = createVersionedTool('legacy-tool', '1.0.0', 'legacy-result');

    const agent = createAgentDefinition({
      name: 'legacy-agent',
      model: 'test-model',
      tools: [legacyTool],
    });

    const engine1 = new Engine({ storage });
    engine1.register(agent, { provider: makeBlockingProvider() });
    engine1.start('legacy-agent', 'hello', { id: 'wf-legacy-version-metadata' }).catch(() => {
      /* expected: engine disposed before LLM resolves */
    });
    await flush();

    const stateBytes = await storage.get(KEYS.workflow('wf-legacy-version-metadata'));
    expect(stateBytes).not.toBeNull();
    const state = decode(stateBytes!) as WorkflowState;
    const legacyState: WorkflowState = {
      ...state,
      version: '1',
    };
    delete legacyState.agentVersion;
    delete legacyState.toolVersions;
    await storage.put(KEYS.workflow('wf-legacy-version-metadata'), encode(legacyState));

    engine1[Symbol.dispose]();

    const engine2 = new Engine({ storage });
    engine2.register(agent, { provider: makeBlockingProvider() });
    await engine2.resume('wf-legacy-version-metadata');
    await flush();

    const upgradedState = await engine2.get('wf-legacy-version-metadata');
    expect(upgradedState?.version).toBe('1');
    expect(upgradedState?.agentVersion).toBe('0.0.0');
    expect(upgradedState?.toolVersions).toEqual(['legacy-tool@1.0.0']);

    engine2[Symbol.dispose]();
  });

  it('resumes successfully when a migration hook is provided', async () => {
    const storage = new MemoryStorage();

    const toolV1 = createVersionedTool('my-tool', '1.0.0', 'tool-result');

    const agentV1 = createAgentDefinition({
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
    await resumeHandle.result();

    const resumedState = await engine2.get('wf-migration-test');
    expect(resumedState?.version).toBe('2.0.0');

    engine2[Symbol.dispose]();
  });
});
