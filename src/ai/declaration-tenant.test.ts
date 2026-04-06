import { describe, expect, it } from 'bun:test';

import { Engine } from '../core/engine.ts';
import type { TenantContext } from '../core/tenant.ts';
import type { WorkflowContext } from '../core/types.ts';
import { defineAgent, type AgentToolDefinition } from './declaration.ts';
import type { LLMProvider } from './providers/interface.ts';
import type { ChatResponse } from './providers/types.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createChatResponse(content: string): ChatResponse {
  return {
    content,
    toolCalls: [],
    usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
    model: 'test-model',
    stopReason: 'end_turn',
  };
}

/** Provider that remembers the tool definitions it saw on each call. */
function createToolCapturingProvider(responses: ChatResponse[]): LLMProvider & {
  seenTools: Array<string[]>;
} {
  let index = 0;
  const seenTools: Array<string[]> = [];
  return {
    name: 'mock',
    seenTools,
    async chat(_input, options): Promise<ChatResponse> {
      const toolNames = (options?.tools ?? []).map((tool) => tool.name);
      seenTools.push(toolNames);
      return responses[index++]!;
    },
    async stream() {
      return new ReadableStream();
    },
    async countTokens(): Promise<number> {
      return 100;
    },
  };
}

function makeTool(name: string): AgentToolDefinition {
  return {
    definition: {
      name,
      description: `Tool ${name}`,
      inputSchema: { type: 'object', properties: {} },
    },
    execute: async () => ({ ok: true }),
  };
}

async function flush(): Promise<void> {
  await Bun.sleep(10);
}

// ---------------------------------------------------------------------------
// Per-tenant agent customization
// ---------------------------------------------------------------------------

describe('defineAgent with per-tenant customization', () => {
  it('toolsForTenant overrides static tools for each invocation', async () => {
    const freeTool = makeTool('basic-search');
    const proTool = makeTool('advanced-search');

    const provider = createToolCapturingProvider([createChatResponse('result')]);

    const agent = defineAgent({
      name: 'tenant-scoped-agent',
      model: 'test-model',
      tools: [freeTool], // fallback / "default" set
      toolsForTenant(tenant: TenantContext | undefined): AgentToolDefinition[] {
        if (tenant?.attributes?.['tier'] === 'pro') return [freeTool, proTool];
        return [freeTool];
      },
    });

    const engine = new Engine({
      tenantResolver: {
        resolve(_id, input) {
          if (input === null || typeof input !== 'object') return undefined;
          const tier = (input as Record<string, unknown>)['tier'];
          return { id: 'customer-1', attributes: { tier } };
        },
      },
    });

    engine.register(agent, { provider });

    const handle = await engine.start('tenant-scoped-agent', { tier: 'pro' });
    await flush();
    await handle.result();

    expect(provider.seenTools.length).toBeGreaterThan(0);
    expect(provider.seenTools[0]).toContain('basic-search');
    expect(provider.seenTools[0]).toContain('advanced-search');
  });

  it('toolsForTenant returns the free set for the free tier', async () => {
    const freeTool = makeTool('basic-search');
    const proTool = makeTool('advanced-search');

    const provider = createToolCapturingProvider([createChatResponse('result')]);

    const agent = defineAgent({
      name: 'tenant-scoped-agent-free',
      model: 'test-model',
      toolsForTenant(tenant) {
        if (tenant?.attributes?.['tier'] === 'pro') return [freeTool, proTool];
        return [freeTool];
      },
    });

    const engine = new Engine({
      tenantResolver: {
        resolve: () => ({ id: 'customer-2', attributes: { tier: 'free' } }),
      },
    });
    engine.register(agent, { provider });

    const handle = await engine.start('tenant-scoped-agent-free', {});
    await flush();
    await handle.result();

    expect(provider.seenTools[0]).toEqual(['basic-search']);
  });

  it('toolsForTenant receives undefined when no resolver is configured', async () => {
    const freeTool = makeTool('basic-search');
    const proTool = makeTool('advanced-search');

    const provider = createToolCapturingProvider([createChatResponse('result')]);

    const agent = defineAgent({
      name: 'no-resolver-agent',
      model: 'test-model',
      toolsForTenant(tenant) {
        // This is the most common deployment path — no resolver wired on the
        // engine, so tenant is undefined and the fallback branch runs.
        return tenant?.attributes?.['tier'] === 'pro' ? [freeTool, proTool] : [freeTool];
      },
    });

    const engine = new Engine(); // no tenantResolver
    engine.register(agent, { provider });

    const handle = await engine.start('no-resolver-agent', {});
    await flush();
    await handle.result();

    expect(provider.seenTools[0]).toEqual(['basic-search']);
  });

  it('validateInput runs before the agent loop and can fail the workflow', async () => {
    const provider = createToolCapturingProvider([createChatResponse('unreachable')]);

    const agent = defineAgent({
      name: 'validated-agent',
      model: 'test-model',
      validateInput(input: unknown, tenant) {
        if (tenant?.id !== 'trusted') {
          throw new Error('untrusted tenant');
        }
        if (typeof input !== 'object' || input === null || !('prompt' in input)) {
          throw new Error('missing prompt');
        }
      },
    });

    const engine = new Engine({
      tenantResolver: {
        resolve: () => ({ id: 'hostile' }),
      },
    });
    engine.register(agent, { provider });

    const handle = await engine.start('validated-agent', { prompt: 'go' });
    // Attach the rejection handler *synchronously* so the Bun test runner
    // never sees an unhandled rejection, then await the typed error.
    const resultPromise = handle.result().catch((error: unknown) => error);
    const caught = await resultPromise;
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain('untrusted tenant');
    // Provider should never have been called because validation failed first.
    expect(provider.seenTools.length).toBe(0);
  });

  it('validateInput succeeds when the tenant is trusted', async () => {
    const provider = createToolCapturingProvider([createChatResponse('ok')]);

    const agent = defineAgent({
      name: 'validated-agent-happy',
      model: 'test-model',
      validateInput(input: unknown, tenant) {
        if (tenant?.id !== 'trusted') throw new Error('untrusted');
        if (typeof input !== 'object' || input === null || !('prompt' in input)) {
          throw new Error('missing prompt');
        }
      },
    });

    const engine = new Engine({
      tenantResolver: { resolve: () => ({ id: 'trusted' }) },
    });
    engine.register(agent, { provider });

    const handle = await engine.start('validated-agent-happy', { prompt: 'go' });
    await flush();
    const result = await handle.result();
    expect(result).toBe('ok');
  });
});

// ---------------------------------------------------------------------------
// ctx.tenant plumbing through an imperative workflow
// ---------------------------------------------------------------------------

describe('ctx.tenant inside an imperative workflow', () => {
  it('workflow code can branch on ctx.tenant', async () => {
    const captured: Array<string | undefined> = [];
    const engine = new Engine({
      tenantResolver: {
        resolve: (_id, input) => {
          if (input && typeof input === 'object' && 'tenantId' in input) {
            return { id: String((input as Record<string, unknown>)['tenantId']) };
          }
          return undefined;
        },
      },
    });

    engine.register('branch', async function* (ctx: WorkflowContext) {
      captured.push(ctx.tenant?.id);
      return ctx.tenant?.id ?? 'anonymous';
    });

    const anonHandle = await engine.start('branch', {});
    const anonResult = await anonHandle.result();
    const acmeHandle = await engine.start('branch', { tenantId: 'acme' });
    const acmeResult = await acmeHandle.result();

    expect(anonResult).toBe('anonymous');
    expect(acmeResult).toBe('acme');
    expect(captured).toEqual([undefined, 'acme']);
  });
});
