import { beforeEach, describe, expect, it } from 'bun:test';

import { MemoryStorage } from '../storage/memory.ts';
import {
  AgentLoopSuspendedError,
  executeAgentLoop,
  executeAgentLoopWithState,
  type AgentTool,
  type ChatResponse,
  type LLMProvider,
  type Message,
  type PersistedAgentLoopState,
} from './agent/index.ts';
import {
  createSuspendingProvider,
  type PendingChatResumeState,
} from './agent/suspending-provider.ts';
import { ToolEffectLog } from './tool-effect-log.ts';

function makeProvider(responses: ChatResponse[]): LLMProvider {
  let index = 0;
  return {
    name: 'test',
    async chat() {
      const response = responses[index++];
      if (!response) throw new Error('provider has no more responses');
      return response;
    },
  };
}

function makeFinal(content: string): ChatResponse {
  return {
    content,
    toolCalls: [],
    usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    model: 'test-1.0',
    stopReason: 'end_turn',
  };
}

function makeToolCall(name: string, id: string, input: unknown): ChatResponse {
  return {
    content: '',
    toolCalls: [{ id, name, arguments: input }],
    usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    model: 'test-1.0',
    stopReason: 'tool_use',
  };
}

function makeTool(name = 'echo', output: unknown = 'tool-result'): AgentTool {
  return {
    name,
    description: `Runs ${name}.`,
    input: { type: 'object' },
    execute: async () => output,
  };
}

function requireTranscript(conversation: unknown): Message[] {
  if (!Array.isArray(conversation)) {
    throw new Error('Expected the built-in agent loop to return a Message[] transcript.');
  }
  return conversation as Message[];
}

describe('executeAgentLoop', () => {
  let storage: MemoryStorage;

  beforeEach(() => {
    storage = new MemoryStorage();
  });

  it('runs a basic two-turn loop with one local tool call before the final answer', async () => {
    let toolCallCount = 0;
    const tool: AgentTool = {
      name: 'echo',
      description: 'Returns the provided text.',
      input: { type: 'object', properties: { text: { type: 'string' } } },
      execute: async (input) => {
        toolCallCount++;
        return (input as { text: string }).text;
      },
    };

    const result = await executeAgentLoop(
      {
        model: 'test-1.0',
        provider: makeProvider([
          makeToolCall('echo', 'tc-1', { text: 'hello' }),
          makeFinal('done'),
        ]),
        tools: [tool],
      },
      'echo hello',
    );

    expect(result.content).toBe('done');
    expect(result.turnCount).toBe(2);
    expect(toolCallCount).toBe(1);
    expect(result.totalTokens).toEqual({ inputTokens: 20, outputTokens: 10, totalTokens: 30 });
  });

  it('executes multiple tool calls returned in the same turn', async () => {
    const executedTools: string[] = [];
    const toolA = makeTool('tool_a', 'a');
    const toolB = makeTool('tool_b', 'b');
    toolA.execute = async () => {
      executedTools.push('tool_a');
      return 'a';
    };
    toolB.execute = async () => {
      executedTools.push('tool_b');
      return 'b';
    };

    const result = await executeAgentLoop(
      {
        model: 'test-1.0',
        provider: makeProvider([
          {
            ...makeToolCall('tool_a', 'tc-1', {}),
            toolCalls: [
              { id: 'tc-1', name: 'tool_a', arguments: {} },
              { id: 'tc-2', name: 'tool_b', arguments: {} },
            ],
          },
          makeFinal('finished'),
        ]),
        tools: [toolA, toolB],
      },
      'run both',
    );

    expect(result.content).toBe('finished');
    expect(executedTools).toEqual(['tool_a', 'tool_b']);
    const conversation = requireTranscript(result.conversation);
    expect(conversation.find((message) => message.role === 'tool')?.toolResults).toEqual([
      { callId: 'tc-1', outcome: 'success', content: 'a' },
      { callId: 'tc-2', outcome: 'success', content: 'b' },
    ]);
  });

  it('stops at maxTurns when the provider keeps requesting tools', async () => {
    let providerCalls = 0;
    const provider: LLMProvider = {
      name: 'test',
      async chat() {
        providerCalls++;
        return makeToolCall('noop', `tc-${providerCalls}`, {});
      },
    };

    const result = await executeAgentLoop(
      { model: 'test-1.0', provider, tools: [makeTool('noop')], maxTurns: 3 },
      'keep going',
    );

    expect(providerCalls).toBe(3);
    expect(result.turnCount).toBe(3);
    expect(result.content).toBe('');
  });

  it('honors an already-aborted signal before making a provider call', async () => {
    const controller = new AbortController();
    controller.abort();
    let providerCalled = false;

    const provider: LLMProvider = {
      name: 'test',
      async chat() {
        providerCalled = true;
        return makeFinal('should not happen');
      },
    };

    const result = await executeAgentLoop(
      { model: 'test-1.0', provider, signal: controller.signal },
      'stop',
    );

    expect(providerCalled).toBe(false);
    expect(result.turnCount).toBe(0);
    expect(result.content).toBe('');
  });

  it('threads the system prompt through the conversation sent to the provider', async () => {
    let capturedMessages: Message[] = [];
    const provider: LLMProvider = {
      name: 'test',
      async chat(messages) {
        capturedMessages = messages;
        return makeFinal('ok');
      },
    };

    await executeAgentLoop(
      { model: 'test-1.0', provider, systemPrompt: 'You are concise.' },
      'answer',
    );

    expect(capturedMessages).toEqual([
      { role: 'system', content: 'You are concise.' },
      { role: 'user', content: 'answer' },
    ]);
  });

  it('deduplicates a committed tool call through the tool effect log on a later run', async () => {
    let toolExecutionCount = 0;
    const tool: AgentTool = {
      name: 'charge',
      description: 'Charges once.',
      input: { type: 'object' },
      execute: async () => {
        toolExecutionCount++;
        return 'charged';
      },
    };

    const firstLog = new ToolEffectLog(storage, 'workflow-1', 'agent-1');
    const firstRun = await executeAgentLoop(
      {
        model: 'test-1.0',
        provider: makeProvider([
          makeToolCall('charge', 'tc-1', { amount: 100 }),
          makeFinal('charged once'),
        ]),
        tools: [tool],
        toolEffectLog: firstLog,
      },
      'charge',
    );

    const secondLog = new ToolEffectLog(storage, 'workflow-1', 'agent-1');
    const secondRun = await executeAgentLoop(
      {
        model: 'test-1.0',
        provider: makeProvider([
          makeToolCall('charge', 'tc-1', { amount: 100 }),
          makeFinal('charged once again'),
        ]),
        tools: [tool],
        toolEffectLog: secondLog,
      },
      'charge',
    );

    expect(firstRun.content).toBe('charged once');
    expect(secondRun.content).toBe('charged once again');
    expect(toolExecutionCount).toBe(1);
    expect(secondLog.duplicatesPrevented).toBe(1);
  });

  it('throws AgentLoopSuspendedError with a schema version 2 state when the provider can suspend', async () => {
    const baseProvider: LLMProvider = {
      name: 'test',
      async createChatResumeHint() {
        return { resumeToken: 'resume-1', state: { provider: 'test' } };
      },
      async chat() {
        return makeFinal('after resume');
      },
    };

    const provider = createSuspendingProvider(baseProvider, {
      canSuspend: true,
      async load() {
        return undefined;
      },
      async store() {},
      async clear() {},
    });

    try {
      await executeAgentLoop(
        { model: 'test-1.0', provider, workflowId: 'workflow-1', agentId: 'agent-1' },
        'resume later',
      );
      throw new Error('expected agent loop to suspend');
    } catch (error) {
      expect(error).toBeInstanceOf(AgentLoopSuspendedError);
      const suspended = error as AgentLoopSuspendedError;
      expect(suspended.loopState.schemaVersion).toBe(2);
      expect(suspended.loopState.workflowId).toBe('workflow-1');
      expect(suspended.loopState.agentId).toBe('agent-1');
      expect(suspended.pendingResume).toEqual({
        turnIndex: 0,
        hint: { resumeToken: 'resume-1', state: { provider: 'test' } },
        resumed: false,
      });
    }
  });

  it('resumes execution from a persisted loop state when the provider resume signal is available', async () => {
    let suspendedState: PersistedAgentLoopState | undefined;
    const hint = { resumeToken: 'resume-1' };
    const baseProvider: LLMProvider = {
      name: 'test',
      async createChatResumeHint() {
        return hint;
      },
      async chat(_messages, options) {
        expect(options.resumeContext).toEqual({ hint, payload: { approved: true } });
        return makeFinal('resumed');
      },
    };

    const suspendingProvider = createSuspendingProvider(baseProvider, {
      canSuspend: true,
      async load() {
        return undefined;
      },
      async store() {},
      async clear() {},
    });

    try {
      await executeAgentLoop(
        {
          model: 'test-1.0',
          provider: suspendingProvider,
          workflowId: 'workflow-1',
          agentId: 'agent-1',
        },
        'start',
      );
    } catch (error) {
      expect(error).toBeInstanceOf(AgentLoopSuspendedError);
      suspendedState = (error as AgentLoopSuspendedError).loopState;
    }

    const resumedState: PendingChatResumeState = {
      hint,
      resumed: true,
      payload: { approved: true },
    };
    const resumingProvider = createSuspendingProvider(baseProvider, {
      canSuspend: true,
      async load() {
        return resumedState;
      },
      async store() {},
      async clear() {},
    });

    const result = await executeAgentLoopWithState(
      {
        model: 'test-1.0',
        provider: resumingProvider,
        workflowId: 'workflow-1',
        agentId: 'agent-1',
      },
      'start',
      suspendedState,
    );

    expect(result.content).toBe('resumed');
    expect(result.turnCount).toBe(1);
  });

  it('accumulates conversation messages across provider and tool turns', async () => {
    const result = await executeAgentLoop(
      {
        model: 'test-1.0',
        provider: makeProvider([makeToolCall('lookup', 'tc-1', { id: 1 }), makeFinal('final')]),
        tools: [makeTool('lookup', { value: 42 })],
      },
      'look up value',
    );

    const conversation = requireTranscript(result.conversation);
    expect(conversation.map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'tool',
      'assistant',
    ]);
    expect(conversation[1]?.toolCalls).toEqual([
      { id: 'tc-1', name: 'lookup', arguments: { id: 1 } },
    ]);
    expect(conversation[2]?.toolResults).toEqual([
      { callId: 'tc-1', outcome: 'success', content: { value: 42 } },
    ]);
    expect(conversation[3]?.content).toBe('final');
  });
});
