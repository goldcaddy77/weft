/**
 * Durable ReAct agent loop with local tools and provider-resume suspension.
 *
 * Orchestrates multi-turn LLM conversations where the model can invoke
 * tools, receive their results, and continue reasoning until it produces
 * a final answer or an exit condition is reached.
 *
 * @module agent
 */

import { AgentCheckpointResumedEvent } from '../events/index.ts';
import { executeChatWithFallbacks } from './chat.ts';
import { finalizeTurn } from './finalize.ts';
import {
  buildAgentResult,
  createAgentRuntime,
  shouldStopBeforeTurn,
  snapshotAgentLoopState,
} from './runtime.ts';
import { PendingProviderResumeError } from './suspending-provider.ts';
import { executeToolCalls } from './tool-execution.ts';
import { prepareTurn } from './turn.ts';
import type { AgentOptions, AgentResult, AgentRuntime, PersistedAgentLoopState } from './types.ts';
import { AgentLoopSuspendedError } from './types.ts';

export { initializeTools } from './tool-initialization.ts';
export { AgentLoopSuspendedError } from './types.ts';
export type {
  AgentBureauConversationHistory,
  AgentOptions,
  AgentResult,
  AgentRuntime,
  AgentTool,
  ChatOptions,
  ChatResponse,
  ChatResumeContext,
  ChatResumeHint,
  ConversationHistory,
  ConversationHistoryMessage,
  JSONPrimitive,
  JSONValue,
  LLMProvider,
  Message,
  MessageRole,
  NormalizedChatResponse,
  PendingProviderResumeState,
  PersistedAgentLoopState,
  ResolvedAgentOptions,
  TokenUsage,
  ToolActionShape,
  ToolCall,
  ToolCallInput,
  ToolDefinition,
  ToolDescriptor,
  ToolErrorCategory,
  ToolErrorShape,
  ToolExecutionOutcome,
  ToolResult,
  ToolResultInput,
  TurnUsageEntry,
  VerificationRecorder,
} from './types.ts';

async function executeAgentTurn(runtime: AgentRuntime, turnIndex: number): Promise<boolean> {
  if (shouldStopBeforeTurn(runtime)) {
    return false;
  }

  const messagesToSend = prepareTurn(runtime, turnIndex);
  const turnResult = await executeChatWithFallbacks(runtime, turnIndex, messagesToSend);

  if (turnResult.response.toolCalls.length === 0) {
    finalizeTurn(runtime, turnIndex, turnResult, []);
    return false;
  }

  const toolResults = await executeToolCalls(runtime, turnIndex, turnResult.response.toolCalls);
  runtime.state.conversation.push({
    role: 'tool',
    content: '',
    toolResults,
  });
  finalizeTurn(
    runtime,
    turnIndex,
    turnResult,
    turnResult.response.toolCalls.map((toolCall) => toolCall.name),
  );
  return true;
}

/**
 * Execute a tool-calling agent loop and return the final result. Durability
 * (checkpointing across crashes, tool-call dedup) is layered on by
 * `ctx.agent()` inside a registered workflow - calling `executeAgentLoop`
 * directly runs the loop in-memory without persistence.
 *
 * @example Basic agent with a local tool
 * ```ts
 * import { executeAgentLoop, type AgentOptions, type AgentTool } from 'weft';
 * import type { LLMProvider } from 'weft';
 *
 * declare const provider: LLMProvider;
 *
 * const echoCurrent: AgentTool = {
 *   name: 'get_time',
 *   description: 'Returns current ISO time',
 *   input: { type: 'object' },
 *   execute: async () => new Date().toISOString(),
 * };
 *
 * const result = await executeAgentLoop(
 *   { model: 'claude-sonnet-4-5', provider, tools: [echoCurrent], maxTurns: 3 },
 *   'What time is it?',
 * );
 * console.log(result.content);
 * ```
 */
export async function executeAgentLoop(options: AgentOptions, input: string): Promise<AgentResult> {
  return executeAgentLoopWithState(options, input);
}

/** Execute an agent loop, optionally restoring previously persisted state. */
export async function executeAgentLoopWithState(
  options: AgentOptions,
  input: string,
  persistedState?: PersistedAgentLoopState,
): Promise<AgentResult> {
  const runtime = await createAgentRuntime(options, input, persistedState);

  try {
    for (
      let turnIndex = runtime.state.turnCount;
      turnIndex < runtime.options.maxTurns;
      turnIndex++
    ) {
      const shouldContinue = await executeAgentTurn(runtime, turnIndex);
      if (!shouldContinue) {
        break;
      }
    }

    if (
      runtime.options.toolEffectLog &&
      runtime.options.eventTarget &&
      runtime.options.workflowId
    ) {
      const duplicatesPrevented = runtime.options.toolEffectLog.duplicatesPrevented;
      if (duplicatesPrevented > 0) {
        runtime.options.eventTarget.dispatchEvent(
          new AgentCheckpointResumedEvent(
            runtime.options.workflowId,
            runtime.options.agentId,
            duplicatesPrevented,
          ),
        );
      }
    }

    return buildAgentResult(runtime.state);
  } catch (error) {
    if (error instanceof PendingProviderResumeError) {
      throw new AgentLoopSuspendedError(
        snapshotAgentLoopState(runtime.state, runtime.options.agentId, runtime.options.workflowId),
        {
          turnIndex: error.turnIndex,
          hint: error.hint,
          resumed: false,
        },
      );
    }

    throw error;
  } finally {
    runtime.dispose();
  }
}
