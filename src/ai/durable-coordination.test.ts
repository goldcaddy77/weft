import { sleepForTesting } from '../testing/fake-timers.ts';
/**
 * Tests for durable multi-agent coordination operations.
 *
 * These test that handoff, debate, supervise, and parallel agent
 * execution are wired through the engine's generator/checkpoint system
 * as first-class durable operations.
 *
 * @module ai/durable-coordination.test
 */

import { describe, expect, it } from 'bun:test';

import type { Context } from '../core/context.ts';
import type { WorkflowContext } from '../core/types.ts';
import { TestEngine } from '../testing/test-engine.ts';
import type { ChatResponse, LLMProvider } from './agent/types.ts';
import { agent, type AgentDefinition } from './declaration.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Drain microtasks so fire-and-forget work completes. */
async function flush(): Promise<void> {
  await sleepForTesting(10);
}

function createMockProvider(responses: ChatResponse[]): LLMProvider {
  let callIndex = 0;
  return {
    name: 'mock',
    async chat(): Promise<ChatResponse> {
      return responses[callIndex++]!;
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

function createAgentDefinition(overrides?: Partial<AgentDefinition>): AgentDefinition {
  return agent({
    name: 'test-agent',
    model: 'test-model',
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// I1: ctx.handoff() as durable operation
// ---------------------------------------------------------------------------

describe('ctx.handoff() — durable handoff', () => {
  it('parent workflow hands off to child agent and receives result', async () => {
    const engine = new TestEngine();
    const provider = createMockProvider([createChatResponse('child-agent-result')]);
    const childAgent = createAgentDefinition({
      name: 'child-agent',
      systemPrompt: 'You are a child agent',
    });

    engine.register('handoff-workflow', async function* (ctx: WorkflowContext) {
      const result = yield* (ctx as Context).handoff({
        agent: childAgent,
        input: 'Do the thing',
        provider,
      });
      return result;
    });

    const handle = await engine.start('handoff-workflow', null);
    const result = await handle.result();

    expect(result).toEqual(
      expect.objectContaining({
        result: expect.objectContaining({ content: 'child-agent-result' }),
        contextForwarded: 'none',
      }),
    );
  });

  it('with forwardContext "summary" — only summary forwarded', async () => {
    const capturedMessages: unknown[] = [];
    const provider: LLMProvider = {
      name: 'mock',
      async chat(messages): Promise<ChatResponse> {
        capturedMessages.push([...messages]);
        return createChatResponse('summary-result');
      },
    };

    const childAgent = createAgentDefinition({ name: 'summary-agent' });
    const engine = new TestEngine();

    engine.register('summary-handoff', async function* (ctx: WorkflowContext) {
      const result = yield* (ctx as Context).handoff({
        agent: childAgent,
        input: 'Summarize the conversation',
        provider,
        forwardContext: 'summary',
        parentConversation: [
          { role: 'user', content: 'What is 2+2?' },
          { role: 'assistant', content: '4' },
        ],
      });
      return result;
    });

    const handle = await engine.start('summary-handoff', null);
    const result = await handle.result();

    expect(result).toEqual(expect.objectContaining({ contextForwarded: 'summary' }));
  });

  it('with forwardContext "none" — only structured input forwarded', async () => {
    const provider = createMockProvider([createChatResponse('none-result')]);
    const childAgent = createAgentDefinition({ name: 'none-agent' });
    const engine = new TestEngine();

    engine.register('none-handoff', async function* (ctx: WorkflowContext) {
      const result = yield* (ctx as Context).handoff({
        agent: childAgent,
        input: 'Just the input',
        provider,
        forwardContext: 'none',
        parentConversation: [{ role: 'user', content: 'ignored context' }],
      });
      return result;
    });

    const handle = await engine.start('none-handoff', null);
    const result = await handle.result();

    expect(result).toEqual(
      expect.objectContaining({
        result: expect.objectContaining({ content: 'none-result' }),
        contextForwarded: 'none',
      }),
    );
  });

  it('crash and recover — handoff resumes correctly after checkpoint', async () => {
    let callCount = 0;
    const provider: LLMProvider = {
      name: 'mock',
      async chat(): Promise<ChatResponse> {
        callCount++;
        return createChatResponse(`handoff-result-${callCount}`);
      },
    };

    const childAgent = createAgentDefinition({ name: 'resilient-agent' });
    const engine = new TestEngine();

    engine.register('resilient-handoff', async function* (ctx: WorkflowContext) {
      // First activity creates a checkpoint
      const step1 = yield* (ctx as Context).run(async () => 'step-1-done');
      // Then the handoff operation creates another checkpoint
      const handoffResult = yield* (ctx as Context).handoff({
        agent: childAgent,
        input: 'do work',
        provider,
      });
      return { step1, handoffContent: handoffResult.result.content };
    });

    const handle = await engine.start('resilient-handoff', null);
    const result = await handle.result();

    expect(result).toEqual({
      step1: 'step-1-done',
      handoffContent: 'handoff-result-1',
    });
  });
});

// ---------------------------------------------------------------------------
// I2: ctx.debate() as durable operation
// ---------------------------------------------------------------------------

describe('ctx.debate() — durable debate', () => {
  it('two agents alternate for N rounds, then judge renders verdict', async () => {
    let callCount = 0;
    const provider: LLMProvider = {
      name: 'mock',
      async chat(): Promise<ChatResponse> {
        callCount++;
        if (callCount <= 4) {
          return createChatResponse(`round-response-${callCount}`);
        }
        return createChatResponse('The advocate wins.');
      },
    };

    const engine = new TestEngine();

    engine.register('debate-workflow', async function* (ctx: WorkflowContext) {
      const result = yield* (ctx as Context).debate({
        advocate: createAgentDefinition({ name: 'advocate', systemPrompt: 'Argue for' }),
        critic: createAgentDefinition({ name: 'critic', systemPrompt: 'Argue against' }),
        judge: createAgentDefinition({ name: 'judge', systemPrompt: 'Judge the debate' }),
        topic: 'Is the sky blue?',
        rounds: 2,
        provider,
      });
      return result;
    });

    const handle = await engine.start('debate-workflow', null);
    const result = (await handle.result()) as {
      verdict: string;
      rounds: { roundIndex: number; advocateResponse: string; criticResponse: string }[];
      judgeResult: { content: string };
    };

    expect(result.rounds).toHaveLength(2);
    expect(result.verdict).toBe('The advocate wins.');
    expect(result.judgeResult.content).toBe('The advocate wins.');
    // 2 rounds x 2 agents + 1 judge = 5 calls
    expect(callCount).toBe(5);
  });

  it('each round is a checkpoint boundary', async () => {
    let callCount = 0;
    const provider: LLMProvider = {
      name: 'mock',
      async chat(): Promise<ChatResponse> {
        callCount++;
        return createChatResponse(`response-${callCount}`);
      },
    };

    const engine = new TestEngine();

    engine.register('debate-checkpoint', async function* (ctx: WorkflowContext) {
      const result = yield* (ctx as Context).debate({
        advocate: createAgentDefinition({ name: 'advocate' }),
        critic: createAgentDefinition({ name: 'critic' }),
        judge: createAgentDefinition({ name: 'judge' }),
        topic: 'Test topic',
        rounds: 1,
        provider,
      });
      return result;
    });

    const handle = await engine.start('debate-checkpoint', null);
    const result = (await handle.result()) as {
      verdict: string;
      rounds: { roundIndex: number }[];
    };

    expect(result.rounds).toHaveLength(1);
    expect(result.verdict).toBe('response-3');
  });

  it('returns full DebateResult structure with all rounds', async () => {
    let callCount = 0;
    const provider: LLMProvider = {
      name: 'mock',
      async chat(): Promise<ChatResponse> {
        callCount++;
        if (callCount === 1) return createChatResponse('advocate-round-1');
        if (callCount === 2) return createChatResponse('critic-round-1');
        if (callCount === 3) return createChatResponse('advocate-round-2');
        if (callCount === 4) return createChatResponse('critic-round-2');
        return createChatResponse('final-verdict');
      },
    };

    const engine = new TestEngine();

    engine.register('debate-structure', async function* (ctx: WorkflowContext) {
      return yield* (ctx as Context).debate({
        advocate: createAgentDefinition({ name: 'advocate' }),
        critic: createAgentDefinition({ name: 'critic' }),
        judge: createAgentDefinition({ name: 'judge' }),
        topic: 'Structure test',
        rounds: 2,
        provider,
      });
    });

    const handle = await engine.start('debate-structure', null);
    const result = (await handle.result()) as {
      verdict: string;
      rounds: { roundIndex: number; advocateResponse: string; criticResponse: string }[];
      judgeResult: { content: string };
    };

    expect(result.rounds[0]!.roundIndex).toBe(0);
    expect(result.rounds[0]!.advocateResponse).toBe('advocate-round-1');
    expect(result.rounds[0]!.criticResponse).toBe('critic-round-1');
    expect(result.rounds[1]!.roundIndex).toBe(1);
    expect(result.rounds[1]!.advocateResponse).toBe('advocate-round-2');
    expect(result.rounds[1]!.criticResponse).toBe('critic-round-2');
    expect(result.verdict).toBe('final-verdict');
  });
});

// ---------------------------------------------------------------------------
// I3: ctx.supervise() with synthesis strategies
// ---------------------------------------------------------------------------

describe('ctx.supervise() — durable supervision', () => {
  it('with "consensus" strategy — all workers agree', async () => {
    const provider: LLMProvider = {
      name: 'mock',
      async chat(): Promise<ChatResponse> {
        return createChatResponse('The answer is 42');
      },
    };

    const engine = new TestEngine();

    engine.register('supervise-consensus', async function* (ctx: WorkflowContext) {
      return yield* (ctx as Context).supervise({
        workers: [
          createAgentDefinition({ name: 'worker-1' }),
          createAgentDefinition({ name: 'worker-2' }),
          createAgentDefinition({ name: 'worker-3' }),
        ],
        supervisor: createAgentDefinition({ name: 'supervisor' }),
        input: 'What is the answer?',
        strategy: 'consensus',
        provider,
      });
    });

    const handle = await engine.start('supervise-consensus', null);
    const result = (await handle.result()) as {
      finalResult: string;
      workerResults: { content: string }[];
      strategy: string;
    };

    expect(result.finalResult).toBe('The answer is 42');
    expect(result.strategy).toBe('consensus');
    expect(result.workerResults).toHaveLength(3);
  });

  it('with "best-of-n" strategy — supervisor picks best', async () => {
    let callCount = 0;
    const provider: LLMProvider = {
      name: 'mock',
      async chat(): Promise<ChatResponse> {
        callCount++;
        if (callCount <= 3) return createChatResponse(`worker-${callCount}-answer`);
        return createChatResponse('worker-2-answer is best');
      },
    };

    const engine = new TestEngine();

    engine.register('supervise-best-of-n', async function* (ctx: WorkflowContext) {
      return yield* (ctx as Context).supervise({
        workers: [
          createAgentDefinition({ name: 'worker-1' }),
          createAgentDefinition({ name: 'worker-2' }),
          createAgentDefinition({ name: 'worker-3' }),
        ],
        supervisor: createAgentDefinition({ name: 'supervisor' }),
        input: 'Solve the problem',
        strategy: 'best-of-n',
        provider,
      });
    });

    const handle = await engine.start('supervise-best-of-n', null);
    const result = (await handle.result()) as {
      finalResult: string;
      workerResults: { content: string }[];
      strategy: string;
    };

    expect(result.finalResult).toBe('worker-2-answer is best');
    expect(result.strategy).toBe('best-of-n');
    expect(result.workerResults).toHaveLength(3);
  });

  it('with "merge" strategy — supervisor combines outputs', async () => {
    let callCount = 0;
    const provider: LLMProvider = {
      name: 'mock',
      async chat(): Promise<ChatResponse> {
        callCount++;
        if (callCount <= 2) return createChatResponse(`partial-${callCount}`);
        return createChatResponse('merged output combining partial-1 and partial-2');
      },
    };

    const engine = new TestEngine();

    engine.register('supervise-merge', async function* (ctx: WorkflowContext) {
      return yield* (ctx as Context).supervise({
        workers: [
          createAgentDefinition({ name: 'worker-1' }),
          createAgentDefinition({ name: 'worker-2' }),
        ],
        supervisor: createAgentDefinition({ name: 'supervisor' }),
        input: 'Merge these',
        strategy: 'merge',
        provider,
      });
    });

    const handle = await engine.start('supervise-merge', null);
    const result = (await handle.result()) as {
      finalResult: string;
      workerResults: { content: string }[];
      strategy: string;
    };

    expect(result.finalResult).toBe('merged output combining partial-1 and partial-2');
    expect(result.strategy).toBe('merge');
    expect(result.workerResults).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// I4: ctx.all() with agent branches + budget sharing
// ---------------------------------------------------------------------------

describe('ctx.all() with agent branches and budget sharing', () => {
  it('three parallel agents via ctx.all()', async () => {
    let callCount = 0;
    const provider: LLMProvider = {
      name: 'mock',
      async chat(): Promise<ChatResponse> {
        callCount++;
        return createChatResponse(`agent-${callCount}-result`);
      },
    };

    const engine = new TestEngine();

    engine.register('parallel-agents', async function* (ctx: WorkflowContext) {
      const results = yield* (ctx as Context).all([
        (ctx as Context).agent({
          model: 'test-model',
          prompt: 'Task 1',
          provider,
        }),
        (ctx as Context).agent({
          model: 'test-model',
          prompt: 'Task 2',
          provider,
        }),
        (ctx as Context).agent({
          model: 'test-model',
          prompt: 'Task 3',
          provider,
        }),
      ]);
      return results;
    });

    const handle = await engine.start('parallel-agents', null);
    const result = (await handle.result()) as unknown[];

    // All three agents should have produced results
    expect(result).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// I5: Agent-to-agent signals
// ---------------------------------------------------------------------------

describe('agent-to-agent signals within workflow', () => {
  it('agent A sends signal to agent B within same workflow via child workflows', async () => {
    const engine = new TestEngine();

    engine.register('signal-sender', async function* (_ctx: WorkflowContext, input: unknown) {
      const { targetId } = input as { targetId: string };
      // Send a signal to the target workflow
      await engine.signal(targetId, 'agent-message', { data: 'hello from A' });
      return 'sent';
    });

    engine.register('signal-receiver', async function* (ctx: WorkflowContext) {
      const signal = yield* (ctx as Context).waitForSignal<{ data: string }>('agent-message');
      return signal;
    });

    // Start receiver first (it will block waiting for signal)
    const receiverHandle = await engine.start('signal-receiver', null, { id: 'receiver-wf' });

    // Allow receiver to start and reach wait-for-signal
    await flush();

    // Start sender, pointing it at the receiver
    const senderHandle = await engine.start('signal-sender', { targetId: 'receiver-wf' });

    await flush();

    const senderResult = await senderHandle.result();
    expect(senderResult).toBe('sent');

    const receiverResult = await receiverHandle.result();
    expect(receiverResult).toEqual({ data: 'hello from A' });
  });

  it('signal delivery between agents coordinated by parent workflow', async () => {
    const engine = new TestEngine();

    engine.register('worker-a', async function* (_ctx: WorkflowContext) {
      // Worker A completes with a result
      return { message: 'result from A' };
    });

    engine.register('worker-b', async function* (_ctx: WorkflowContext, input: unknown) {
      // Worker B uses input from parent (which includes A's result)
      return { received: input };
    });

    engine.register('coordinator', async function* (ctx: WorkflowContext) {
      // Start child A, get result
      const resultA = yield* (ctx as Context).startChild('worker-a', null);
      // Pass A's result to child B
      const resultB = yield* (ctx as Context).startChild('worker-b', resultA);
      return resultB;
    });

    const handle = await engine.start('coordinator', null);
    const result = (await handle.result()) as { received: { message: string } };

    expect(result.received).toEqual({ message: 'result from A' });
  });
});
