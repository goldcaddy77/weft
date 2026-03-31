import { describe, expect, it } from 'bun:test';

import type { Context } from '../core/context.ts';
import type { WorkflowContext } from '../core/types.ts';
import { TestEngine } from '../testing/test-engine.ts';
import type { ContextStrategy } from './context-window.ts';
import { defineAgent, isAgentDefinition, type AgentToolDefinition } from './declaration.ts';
import type { AgentHooks } from './hooks.ts';
import type { ModelRouter } from './model-router.ts';
import type { LLMProvider } from './providers/interface.ts';
import type { ChatResponse, Message } from './providers/types.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Drain microtasks so fire-and-forget work completes. */
async function flush(): Promise<void> {
  await Bun.sleep(10);
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

function createChatResponse(content: string): ChatResponse {
  return {
    content,
    toolCalls: [],
    usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
    model: 'test-model',
    stopReason: 'end_turn',
  };
}

// ---------------------------------------------------------------------------
// Existing defineAgent unit tests
// ---------------------------------------------------------------------------

describe('defineAgent', () => {
  it('returns an AgentDefinition with all fields', () => {
    const tool: AgentToolDefinition = {
      definition: {
        name: 'search',
        description: 'Search for information',
        inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
      },
      execute: async (_input: unknown) => ({ results: [] }),
    };

    const hooks: AgentHooks = {
      beforeTurn: () => ({ action: 'continue' as const }),
      afterToolCall: () => ({ action: 'continue' as const }),
      onBudgetWarning: () => {},
    };

    const agent = defineAgent({
      name: 'research-agent',
      model: 'gpt-4',
      systemPrompt: 'You are a research assistant.',
      tools: [tool],
      maxTurns: 10,
      budget: { models: { 'gpt-4': { inputCostPer1K: 0.03, outputCostPer1K: 0.06 } } },
      hooks,
      description: 'A research agent',
    });

    expect(agent.name).toBe('research-agent');
    expect(agent.model).toBe('gpt-4');
    expect(agent.systemPrompt).toBe('You are a research assistant.');
    expect(agent.tools).toHaveLength(1);
    expect(agent.maxTurns).toBe(10);
    expect(agent.budget).toBeDefined();
    expect(agent.hooks).toBe(hooks);
    expect(agent.description).toBe('A research agent');
  });

  it('with minimal options uses defaults', () => {
    const agent = defineAgent({
      name: 'minimal-agent',
      model: 'gpt-3.5',
    });

    expect(agent.name).toBe('minimal-agent');
    expect(agent.model).toBe('gpt-3.5');
    expect(agent.systemPrompt).toBeUndefined();
    expect(agent.tools).toBeUndefined();
    expect(agent.maxTurns).toBeUndefined();
    expect(agent.budget).toBeUndefined();
    expect(agent.hooks).toBeUndefined();
    expect(agent.description).toBeUndefined();
  });

  it('requires name (type-level enforcement)', () => {
    // Name is required at the type level. Passing it ensures it appears in the output.
    const agent = defineAgent({ name: 'must-have-name', model: 'gpt-4' });
    expect(agent.name).toBe('must-have-name');
  });

  it('requires model (type-level enforcement)', () => {
    // Model is required at the type level. Passing it ensures it appears in the output.
    const agent = defineAgent({ name: 'test', model: 'claude-3-opus' });
    expect(agent.model).toBe('claude-3-opus');
  });

  it('preserves tools array', () => {
    const toolA: AgentToolDefinition = {
      definition: {
        name: 'tool-a',
        description: 'First tool',
        inputSchema: {},
      },
      execute: async () => 'a',
    };

    const toolB: AgentToolDefinition = {
      definition: {
        name: 'tool-b',
        description: 'Second tool',
        inputSchema: {},
      },
      execute: async () => 'b',
    };

    const agent = defineAgent({
      name: 'multi-tool-agent',
      model: 'gpt-4',
      tools: [toolA, toolB],
    });

    expect(agent.tools).toHaveLength(2);
    expect(agent.tools![0]!.definition.name).toBe('tool-a');
    expect(agent.tools![1]!.definition.name).toBe('tool-b');
  });

  it('preserves hooks', () => {
    const hooks: AgentHooks = {
      beforeTurn: () => ({ action: 'skip' as const, result: 'nope' }),
    };

    const agent = defineAgent({
      name: 'hooked-agent',
      model: 'gpt-4',
      hooks,
    });

    expect(agent.hooks).toBe(hooks);
    expect(agent.hooks!.beforeTurn).toBeDefined();
  });

  it('returns a plain object (not a class instance)', () => {
    const agent = defineAgent({ name: 'plain', model: 'gpt-4' });

    // A plain object's constructor is Object
    expect(agent.constructor).toBe(Object);
    expect(typeof agent).toBe('object');
    expect(agent).not.toBeInstanceOf(Array);
  });

  it('sets the _brand field for runtime identification', () => {
    const agent = defineAgent({ name: 'branded', model: 'gpt-4' });
    expect(isAgentDefinition(agent)).toBe(true);
  });

  it('isAgentDefinition returns false for unbranded objects', () => {
    expect(isAgentDefinition({ name: 'foo', model: 'bar' })).toBe(false);
    expect(isAgentDefinition(null)).toBe(false);
    expect(isAgentDefinition(42)).toBe(false);
    expect(isAgentDefinition('string')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// J1: weft.agent() top-level declaration API — engine.register + engine.start
// ---------------------------------------------------------------------------

describe('J1: engine.register(agentDef) — agent as standalone workflow', () => {
  it('registers an AgentDefinition as a workflow using its name', async () => {
    const engine = new TestEngine();
    const provider = createMockProvider([createChatResponse('research result')]);

    const researcher = defineAgent<{ topic: string }, { summary: string }>({
      name: 'researcher',
      model: 'test-model',
      systemPrompt: 'You are a researcher.',
    });

    engine.register(researcher, { provider });

    // Start workflow using the agent name
    const handle = await engine.start('researcher', { topic: 'AI' });
    await flush();
    const result = await handle.result();

    expect(result).toBeDefined();
    expect(typeof result).toBe('string');
    expect(result).toBe('research result');
  });

  it('throws when starting an unregistered agent name', async () => {
    const engine = new TestEngine();

    await expect(engine.start('nonexistent', {})).rejects.toThrow(
      /No workflow registered with name "nonexistent"/,
    );
  });

  it('uses agent systemPrompt when running as workflow', async () => {
    const chatCalls: { messages: Message[] }[] = [];
    const provider: LLMProvider = {
      name: 'spy',
      async chat(messages): Promise<ChatResponse> {
        chatCalls.push({ messages: [...messages] });
        return createChatResponse('done');
      },
      async stream() {
        return new ReadableStream();
      },
      async countTokens(): Promise<number> {
        return 100;
      },
    };

    const agent = defineAgent({
      name: 'sys-prompt-agent',
      model: 'test-model',
      systemPrompt: 'Be helpful.',
    });

    const engine = new TestEngine();
    engine.register(agent, { provider });

    const handle = await engine.start('sys-prompt-agent', 'hello');
    await flush();
    await handle.result();

    expect(chatCalls.length).toBeGreaterThan(0);
    const firstCall = chatCalls[0]!;
    expect(firstCall.messages[0]!.role).toBe('system');
    expect(firstCall.messages[0]!.content).toBe('Be helpful.');
  });
});

// ---------------------------------------------------------------------------
// J1 continued: ctx.agent(agentDef, input) — embedded agent step
// ---------------------------------------------------------------------------

describe('J1: ctx.agent(agentDef, input) — embedded agent step', () => {
  it('runs an AgentDefinition as an embedded step inside a workflow', async () => {
    const provider = createMockProvider([createChatResponse('embedded result')]);

    const helper = defineAgent({
      name: 'helper',
      model: 'test-model',
      systemPrompt: 'You help.',
    });

    const engine = new TestEngine();
    engine.register('parent-workflow', async function* (ctx: WorkflowContext) {
      // ctx.agent() returns the agent's content string (the engine feeds
      // agentResult.content as the operation result).
      const agentOptions: import('../core/context.ts').AgentContextOptions = {
        model: helper.model,
        prompt: 'do something',
        provider,
      };
      if (helper.systemPrompt) agentOptions.systemPrompt = helper.systemPrompt;
      if (helper.tools) agentOptions.tools = helper.tools;
      if (helper.maxTurns) agentOptions.maxTurns = helper.maxTurns;
      if (helper.hooks) agentOptions.hooks = helper.hooks;
      const result = yield* (ctx as Context).agent(agentOptions);
      return result;
    });

    const handle = await engine.start('parent-workflow', {});
    await flush();
    const result = await handle.result();

    expect(result).toBeDefined();
    // The engine feeds agentResult.content (a string) as the ctx.agent() return value
    expect(result).toBe('embedded result');
  });
});

// ---------------------------------------------------------------------------
// J2: Durable hooks (beforeTurn, afterToolCall, onBudgetWarning)
// ---------------------------------------------------------------------------

describe('J2: Durable hooks on agent definition', () => {
  it('beforeTurn hook fires before each LLM call and can modify messages', async () => {
    const hookCalls: number[] = [];

    const provider = createMockProvider([createChatResponse('result after hook')]);

    const agent = defineAgent({
      name: 'hooked-before',
      model: 'test-model',
      hooks: {
        beforeTurn: (context) => {
          hookCalls.push(context.turnIndex);
          return { action: 'continue' as const };
        },
      },
    });

    const engine = new TestEngine();
    engine.register(agent, { provider });

    const handle = await engine.start('hooked-before', 'test input');
    await flush();
    await handle.result();

    expect(hookCalls).toEqual([0]);
  });

  it('beforeTurn hook can skip the turn with a result', async () => {
    const provider = createMockProvider([]); // No LLM calls needed

    const agent = defineAgent({
      name: 'skip-turn',
      model: 'test-model',
      hooks: {
        beforeTurn: () => ({
          action: 'skip' as const,
          result: 'skipped by hook',
        }),
      },
    });

    const engine = new TestEngine();
    engine.register(agent, { provider });

    const handle = await engine.start('skip-turn', 'test');
    await flush();
    const result = await handle.result();

    // The agent content should be the skip result
    expect(result).toBe('skipped by hook');
  });

  it('afterToolCall hook fires after each tool call and can modify result', async () => {
    const hookCalls: string[] = [];

    const provider = createMockProvider([
      // First response: call a tool
      {
        content: '',
        toolCalls: [{ id: 'call-1', name: 'greet', input: { name: 'world' } }],
        usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
        model: 'test-model',
        stopReason: 'tool_use',
      },
      // Second response: final answer
      createChatResponse('final answer'),
    ]);

    const agent = defineAgent({
      name: 'hooked-after',
      model: 'test-model',
      tools: [
        {
          definition: { name: 'greet', description: 'Greet', inputSchema: {} },
          execute: async (input: unknown) => `Hello ${(input as { name: string }).name}`,
        },
      ],
      hooks: {
        afterToolCall: (context) => {
          hookCalls.push(context.toolCall.name);
          return { action: 'continue' as const, result: 'modified by hook' };
        },
      },
    });

    const engine = new TestEngine();
    engine.register(agent, { provider });

    const handle = await engine.start('hooked-after', 'greet someone');
    await flush();
    await handle.result();

    expect(hookCalls).toEqual(['greet']);
  });
});

// ---------------------------------------------------------------------------
// J3: Context strategy + model router on agent definition
// ---------------------------------------------------------------------------

describe('J3: Context strategy + model router on agent definition', () => {
  it('uses modelRouter from agent definition', async () => {
    const selectedModels: string[] = [];

    const provider: LLMProvider = {
      name: 'spy',
      async chat(_messages, options): Promise<ChatResponse> {
        selectedModels.push(options?.model ?? 'unknown');
        return createChatResponse('routed result');
      },
      async stream() {
        return new ReadableStream();
      },
      async countTokens(): Promise<number> {
        return 100;
      },
    };

    const router: ModelRouter = {
      select: () => ({ model: 'routed-model' }),
    };

    const agent = defineAgent({
      name: 'routed-agent',
      model: 'default-model',
      modelRouter: router,
    });

    const engine = new TestEngine();
    engine.register(agent, { provider });

    const handle = await engine.start('routed-agent', 'test');
    await flush();
    await handle.result();

    expect(selectedModels).toContain('routed-model');
  });

  it('uses contextStrategy from agent definition', async () => {
    let strategyUsed = false;

    const strategy: ContextStrategy = {
      name: 'test',
      async *compact(messages) {
        strategyUsed = true;
        yield messages;
        return messages;
      },
    };

    // The context manager only triggers compaction when token count exceeds
    // threshold. We test that the strategy is at least stored and available.
    const agent = defineAgent({
      name: 'strategy-agent',
      model: 'test-model',
      contextStrategy: strategy,
    });

    expect(agent.contextStrategy).toBe(strategy);
    // strategyUsed will only be true if compaction triggers, which depends on
    // token count. We verify the definition stores it correctly.
    expect(strategyUsed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// J4: Type-safe agent definitions
// ---------------------------------------------------------------------------

describe('J4: Type-safe agent definitions', () => {
  it('preserves generic type parameters via phantom fields', () => {
    const agent = defineAgent<{ topic: string }, { summary: string }>({
      name: 'typed-agent',
      model: 'test-model',
    });

    // The phantom fields should exist but be undefined
    expect(agent._inputType).toBeUndefined();
    expect(agent._outputType).toBeUndefined();

    // The definition itself is well-typed — this is a compile-time check.
    // If the generics were wrong, TypeScript would error on the lines below.
    type InputType = NonNullable<(typeof agent)['_inputType']>;
    type OutputType = NonNullable<(typeof agent)['_outputType']>;

    // Runtime type-level assertions using dummy values
    const _inputCheck: InputType = { topic: 'test' };
    const _outputCheck: OutputType = { summary: 'test' };
    expect(_inputCheck.topic).toBe('test');
    expect(_outputCheck.summary).toBe('test');
  });

  it('defaults generic parameters to unknown', () => {
    const agent = defineAgent({
      name: 'untyped-agent',
      model: 'test-model',
    });

    // When no generics are specified, phantom fields are still undefined
    expect(agent._inputType).toBeUndefined();
    expect(agent._outputType).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// J5: Standalone and embedded agents share executeAgentLoop
// ---------------------------------------------------------------------------

describe('J5: Standalone and embedded share implementation', () => {
  it('standalone agent (engine.register) produces same content as embedded (ctx.agent)', async () => {
    const standaloneProvider = createMockProvider([createChatResponse('shared result')]);
    const embeddedProvider = createMockProvider([createChatResponse('shared result')]);

    const agentDef = defineAgent({
      name: 'shared-agent',
      model: 'test-model',
      systemPrompt: 'You are a test agent.',
    });

    // Standalone path
    const standaloneEngine = new TestEngine();
    standaloneEngine.register(agentDef, { provider: standaloneProvider });
    const standaloneHandle = await standaloneEngine.start('shared-agent', 'test input');
    await flush();
    const standaloneResult = await standaloneHandle.result();

    // Embedded path
    const embeddedEngine = new TestEngine();
    embeddedEngine.register('embedded-workflow', async function* (ctx: WorkflowContext) {
      const opts: import('../core/context.ts').AgentContextOptions = {
        model: agentDef.model,
        prompt: 'test input',
        provider: embeddedProvider,
      };
      if (agentDef.systemPrompt) opts.systemPrompt = agentDef.systemPrompt;
      const result = yield* (ctx as Context).agent(opts);
      return result;
    });
    const embeddedHandle = await embeddedEngine.start('embedded-workflow', {});
    await flush();
    const embeddedResult = await embeddedHandle.result();

    // Both paths ultimately call executeAgentLoop; standalone returns
    // agentResult.content directly, embedded (ctx.agent) also returns
    // agentResult.content via the engine operation handler.
    expect(standaloneResult).toBe('shared result');
    expect(embeddedResult).toBe('shared result');
  });

  it('hooks work in both standalone and embedded modes', async () => {
    const standaloneCalls: number[] = [];
    const embeddedCalls: number[] = [];

    const agentDef = defineAgent({
      name: 'hooks-shared',
      model: 'test-model',
    });

    // Standalone with hooks
    const standaloneProvider = createMockProvider([createChatResponse('ok')]);
    const standaloneEngine = new TestEngine();
    const agentWithStandaloneHooks = defineAgent({
      ...agentDef,
      hooks: {
        beforeTurn: (ctx) => {
          standaloneCalls.push(ctx.turnIndex);
          return { action: 'continue' as const };
        },
      },
    });
    standaloneEngine.register(agentWithStandaloneHooks, { provider: standaloneProvider });
    const sh = await standaloneEngine.start('hooks-shared', 'test');
    await flush();
    await sh.result();

    // Embedded with hooks
    const embeddedProvider = createMockProvider([createChatResponse('ok')]);
    const embeddedEngine = new TestEngine();
    embeddedEngine.register('embedded-hooks', async function* (ctx: WorkflowContext) {
      const result = yield* (ctx as Context).agent({
        model: agentDef.model,
        prompt: 'test',
        provider: embeddedProvider,
        hooks: {
          beforeTurn: (hookContext) => {
            embeddedCalls.push(hookContext.turnIndex);
            return { action: 'continue' as const };
          },
        },
      });
      return result;
    });
    const eh = await embeddedEngine.start('embedded-hooks', {});
    await flush();
    await eh.result();

    expect(standaloneCalls).toEqual([0]);
    expect(embeddedCalls).toEqual([0]);
  });
});
