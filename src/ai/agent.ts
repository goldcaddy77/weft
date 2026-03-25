/**
 * Durable ReAct agent loop with tool caching and budget enforcement.
 *
 * Orchestrates multi-turn LLM conversations where the model can invoke
 * tools, receive their results, and continue reasoning until it produces
 * a final answer or an exit condition is reached.
 *
 * @module agent
 */

import type { BudgetTracker } from './budget';
import { BudgetExceededError } from './budget';
import type { ContextWindowManager } from './context-window';
import type { ModelRouter, RoutingContext } from './model-router';
import type { ProviderHealthTracker } from './provider-health';
import type { LLMProvider } from './providers/interface';
import type { ChatResponse, Message, TokenUsage, ToolDefinition } from './providers/types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AgentOptions {
  model: string;
  provider: LLMProvider;
  systemPrompt?: string | undefined;
  tools?: AgentTool[] | undefined;
  /** Maximum number of LLM turns before returning. Defaults to 10. */
  maxTurns?: number | undefined;
  budget?: BudgetTracker | undefined;
  modelRouter?: ModelRouter | undefined;
  contextManager?: ContextWindowManager | undefined;
  healthTracker?: ProviderHealthTracker | undefined;
  /** Tool result cache TTL in milliseconds. Defaults to 300 000 (5 minutes). */
  toolCacheTTL?: number | undefined;
  signal?: AbortSignal | undefined;
  onTurnStarted?: ((turn: TurnInfo) => void) | undefined;
  onTurnCompleted?: ((turn: TurnResult) => void) | undefined;
  onToolCalled?: ((call: ToolCallInfo) => void) | undefined;
  onToolReturned?: ((result: ToolReturnInfo) => void) | undefined;
}

export interface AgentTool {
  definition: ToolDefinition;
  execute: (input: unknown) => Promise<unknown>;
}

export interface TurnInfo {
  turnIndex: number;
  model: string;
  conversationLength: number;
}

export interface TurnResult {
  turnIndex: number;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cost: number;
  duration: number;
  toolCallCount: number;
}

export interface ToolCallInfo {
  turnIndex: number;
  toolName: string;
  toolInput: unknown;
}

export interface ToolReturnInfo {
  turnIndex: number;
  toolName: string;
  duration: number;
  success: boolean;
}

export interface AgentResult {
  content: string;
  conversation: Message[];
  totalTokens: TokenUsage;
  totalCost: number;
  turnCount: number;
}

// ---------------------------------------------------------------------------
// Tool result cache
// ---------------------------------------------------------------------------

interface CacheEntry {
  output: string;
  timestamp: number;
}

function buildCacheKey(toolName: string, input: unknown): string {
  return `${toolName}:${JSON.stringify(input)}`;
}

// ---------------------------------------------------------------------------
// executeAgentLoop
// ---------------------------------------------------------------------------

/** Execute a durable ReAct agent loop. Returns the final agent result. */
export async function executeAgentLoop(options: AgentOptions, input: string): Promise<AgentResult> {
  const {
    model: defaultModel,
    provider,
    systemPrompt,
    tools = [],
    maxTurns = 10,
    budget,
    modelRouter,
    contextManager,
    healthTracker,
    toolCacheTTL = 300_000,
    signal,
    onTurnStarted,
    onTurnCompleted,
    onToolCalled,
    onToolReturned,
  } = options;

  // Build the tool lookup map and definition list
  const toolMap = new Map<string, AgentTool>();
  const toolDefinitions: ToolDefinition[] = [];
  for (const tool of tools) {
    toolMap.set(tool.definition.name, tool);
    toolDefinitions.push(tool.definition);
  }

  // Tool result cache
  const toolCache = new Map<string, CacheEntry>();

  // Initialize conversation
  const conversation: Message[] = [];
  if (systemPrompt !== undefined) {
    conversation.push({ role: 'system', content: systemPrompt });
  }
  conversation.push({ role: 'user', content: input });

  // Accumulate totals
  const totalTokens: TokenUsage = {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
  };
  let totalCost = 0;
  let turnCount = 0;
  let lastContent = '';

  for (let turnIndex = 0; turnIndex < maxTurns; turnIndex++) {
    // Exit path: cancellation
    if (signal?.aborted) {
      break;
    }

    // Exit path: budget exhausted
    if (budget) {
      try {
        budget.checkBudget();
      } catch (error: unknown) {
        if (error instanceof BudgetExceededError) {
          break;
        }
        throw error;
      }
    }

    // Select model via router or use default
    let currentModel = defaultModel;
    if (modelRouter) {
      const routingContext: RoutingContext = {
        workflowId: '',
        turnIndex,
        conversationLength: conversation.length,
        budgetRemaining: budget
          ? {
              tokensRemaining: budget.budgetRemaining().tokensRemaining,
              costRemaining: budget.budgetRemaining().costRemaining,
            }
          : undefined,
        previousModels: [],
      };
      const selection = modelRouter.select(routingContext);
      currentModel = selection.model;
    }

    // Apply context window strategy if configured
    let messagesToSend = conversation;
    if (contextManager) {
      const tokenCount = await provider.countTokens(conversation);
      if (contextManager.shouldCompact(tokenCount)) {
        const compacted = await contextManager.compact(conversation);
        messagesToSend = compacted.messages;
      }
    }

    // Fire turn-started callback
    onTurnStarted?.({
      turnIndex,
      model: currentModel,
      conversationLength: messagesToSend.length,
    });

    const turnStart = Date.now();

    // Call LLM provider
    let response: ChatResponse;
    try {
      const chatOptions: import('./providers/interface').ChatOptions = {
        model: currentModel,
      };
      if (toolDefinitions.length > 0) {
        chatOptions.tools = toolDefinitions;
      }
      if (signal) {
        chatOptions.signal = signal;
      }
      response = await provider.chat(messagesToSend, chatOptions);
    } catch (error: unknown) {
      // Record failure in health tracker if available
      if (healthTracker) {
        healthTracker.recordFailure(provider.name);
      }
      throw error;
    }

    // Record success in health tracker
    if (healthTracker) {
      healthTracker.recordSuccess(provider.name);
    }

    const turnDuration = Date.now() - turnStart;

    // Accumulate usage
    totalTokens.inputTokens += response.usage.inputTokens;
    totalTokens.outputTokens += response.usage.outputTokens;
    totalTokens.totalTokens += response.usage.totalTokens;

    // Record usage in budget tracker
    if (budget) {
      budget.recordUsage(currentModel, response.usage.inputTokens, response.usage.outputTokens);
    }

    turnCount++;
    lastContent = response.content;

    // Add assistant message to conversation
    const assistantMessage: Message = {
      role: 'assistant',
      content: response.content,
    };
    if (response.toolCalls.length > 0) {
      assistantMessage.toolCalls = response.toolCalls;
    }
    conversation.push(assistantMessage);

    // Exit path: final answer (no tool calls)
    if (response.toolCalls.length === 0) {
      // Fire turn-completed callback
      onTurnCompleted?.({
        turnIndex,
        model: currentModel,
        inputTokens: response.usage.inputTokens,
        outputTokens: response.usage.outputTokens,
        cost: 0,
        duration: turnDuration,
        toolCallCount: 0,
      });
      break;
    }

    // Execute tool calls
    const toolResults: Message['toolResults'] = [];

    for (const toolCall of response.toolCalls) {
      // Fire tool-called callback
      onToolCalled?.({
        turnIndex,
        toolName: toolCall.name,
        toolInput: toolCall.input,
      });

      const toolStart = Date.now();
      let output: string;
      let success = true;

      // Check cache first
      const cacheKey = buildCacheKey(toolCall.name, toolCall.input);
      const cached = toolCache.get(cacheKey);
      const now = Date.now();

      if (cached && now - cached.timestamp < toolCacheTTL) {
        output = cached.output;
      } else {
        // Look up tool
        const tool = toolMap.get(toolCall.name);
        if (!tool) {
          output = JSON.stringify({ error: `Unknown tool: ${toolCall.name}` });
          success = false;
        } else {
          try {
            const rawOutput = await tool.execute(toolCall.input);
            output = typeof rawOutput === 'string' ? rawOutput : JSON.stringify(rawOutput);
            // Cache the result
            toolCache.set(cacheKey, { output, timestamp: Date.now() });
          } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error);
            output = JSON.stringify({ error: message });
            success = false;
          }
        }
      }

      const toolDuration = Date.now() - toolStart;

      // Fire tool-returned callback
      onToolReturned?.({
        turnIndex,
        toolName: toolCall.name,
        duration: toolDuration,
        success,
      });

      toolResults.push({
        toolCallId: toolCall.id,
        output,
        isError: !success,
      });
    }

    // Add tool results as a tool message
    conversation.push({
      role: 'tool',
      content: '',
      toolResults,
    });

    // Fire turn-completed callback
    onTurnCompleted?.({
      turnIndex,
      model: currentModel,
      inputTokens: response.usage.inputTokens,
      outputTokens: response.usage.outputTokens,
      cost: 0,
      duration: turnDuration,
      toolCallCount: response.toolCalls.length,
    });
  }

  return {
    content: lastContent,
    conversation,
    totalTokens,
    totalCost,
    turnCount,
  };
}
