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
import {
  AgentCheckpointSizeWarningEvent,
  AgentContextCompactedEvent,
  AgentModelFallbackEvent,
  AgentToolCalledEvent,
  AgentToolReturnedEvent,
  AgentTurnCompletedEvent,
  AgentTurnStartedEvent,
} from './events';
import type { AgentHooks } from './hooks';
import type { MCPAuthConfig } from './mcp/authentication';
import { buildAuthHeaders, buildAuthHeadersAsync } from './mcp/authentication';
import { MCPClient, MCPServerUnavailableError } from './mcp/client';
import { createOAuth2TokenManager } from './mcp/oauth2-token-manager';
import type { RegistryTool } from './mcp/registry';
import { ToolRegistry } from './mcp/registry';
import { ToolSchemaValidationError, validateSchema } from './mcp/schema-validator';
import type { TransportKind } from './mcp/transport';
import { inferTransportKind, parseStdioUrl } from './mcp/transport';
import { HttpTransport } from './mcp/transport-http';
import { HttpSseTransport } from './mcp/transport-http-sse';
import { StdioTransport } from './mcp/transport-stdio';
import type { ModelRouter, RoutingContext } from './model-router';
import type { ProviderHealthTracker } from './provider-health';
import type { LLMProvider } from './providers/interface';
import type { ChatResponse, Message, TokenUsage, ToolDefinition } from './providers/types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** An MCP server URL to discover tools from at agent initialization. */
export interface MCPToolSource {
  mcp: string;
  auth?: MCPAuthConfig | undefined;
  timeout?: number | undefined;
  /**
   * Override transport auto-detection.
   * - `'http'` (default for `http(s)://` URLs): plain HTTP request/response
   * - `'sse'`: HTTP POST for requests, Server-Sent Events for responses
   * - `'stdio'` (default for `stdio://` URLs): JSON-RPC over child process stdin/stdout
   */
  transport?: TransportKind | undefined;
}

/** Type guard: is the tools entry an MCP server URL source? */
function isMCPToolSource(entry: AgentTool | MCPToolSource): entry is MCPToolSource {
  return 'mcp' in entry && typeof entry.mcp === 'string';
}

export interface AgentOptions {
  model: string;
  provider: LLMProvider;
  systemPrompt?: string | undefined;
  tools?: (AgentTool | MCPToolSource)[] | undefined;
  /** Maximum number of LLM turns before returning. Defaults to 10. */
  maxTurns?: number | undefined;
  budget?: BudgetTracker | undefined;
  modelRouter?: ModelRouter | undefined;
  contextManager?: ContextWindowManager | undefined;
  healthTracker?: ProviderHealthTracker | undefined;
  /** Tool result cache TTL in milliseconds. Defaults to 300 000 (5 minutes). */
  toolCacheTTL?: number | undefined;
  signal?: AbortSignal | undefined;
  hooks?: AgentHooks | undefined;
  eventTarget?: EventTarget | undefined;
  workflowId?: string | undefined;
  agentId?: string | undefined;
  onTurnStarted?: ((turn: TurnInfo) => void) | undefined;
  onTurnCompleted?: ((turn: TurnResult) => void) | undefined;
  onToolCalled?: ((call: ToolCallInfo) => void) | undefined;
  onToolReturned?: ((result: ToolReturnInfo) => void) | undefined;
  /**
   * Conversation size in bytes at which an `AgentCheckpointSizeWarningEvent`
   * is dispatched via the eventTarget. Defaults to 65 536 (64 KB).
   */
  checkpointSizeWarningThreshold?: number | undefined;
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

/** Per-turn cost breakdown entry returned as part of the agent result. */
export interface TurnCostEntry {
  turn: number;
  inputTokens: number;
  outputTokens: number;
  cost: number;
  model: string;
  tools: string[];
}

export interface AgentResult {
  content: string;
  conversation: Message[];
  totalTokens: TokenUsage;
  totalCost: number;
  turnCount: number;
  /** Reasoning/thinking traces captured from each turn's provider response. */
  reasoningTraces: string[];
  /** Per-turn cost breakdown with token counts, model, and tools used. */
  turnCosts: TurnCostEntry[];
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

/**
 * Estimate the serialized size of a conversation in bytes.
 * Uses JSON.stringify as a reasonable approximation of the size
 * the conversation would occupy in a checkpoint blob.
 */
function estimateConversationSizeBytes(conversation: Message[]): number {
  return new TextEncoder().encode(JSON.stringify(conversation)).byteLength;
}

// ---------------------------------------------------------------------------
// Transport creation
// ---------------------------------------------------------------------------

/** Build the appropriate transport for an MCP tool source based on URL scheme and options. */
async function createTransportForSource(
  source: MCPToolSource,
): Promise<import('./mcp/transport').MCPTransport> {
  const kind = inferTransportKind(source.mcp, source.transport);

  // Resolve auth headers — OAuth2 requires async token fetching
  let headers: Record<string, string> = {};
  if (source.auth) {
    if (source.auth.type === 'oauth2') {
      const tokenManager = createOAuth2TokenManager(source.auth);
      headers = await buildAuthHeadersAsync(source.auth, tokenManager);
    } else {
      headers = buildAuthHeaders(source.auth);
    }
  }

  switch (kind) {
    case 'stdio': {
      const target = parseStdioUrl(source.mcp);
      return new StdioTransport({
        command: target.command,
        args: target.args,
        timeout: source.timeout,
      });
    }
    case 'sse':
      return new HttpSseTransport({
        serverUrl: source.mcp,
        headers,
        timeout: source.timeout,
      });
    case 'http':
      return new HttpTransport({
        serverUrl: source.mcp,
        headers,
        timeout: source.timeout,
      });
  }
}

// ---------------------------------------------------------------------------
// Tool initialization
// ---------------------------------------------------------------------------

/**
 * Process a mixed tools array (local `AgentTool` + `MCPToolSource` entries).
 *
 * For each MCP source: health check, discover tools, register in the registry.
 * For each local tool: register in the registry.
 * Finally, validate for name conflicts and return the populated registry.
 */
async function initializeTools(
  tools: (AgentTool | MCPToolSource)[],
  signal?: AbortSignal,
): Promise<ToolRegistry> {
  const registry = new ToolRegistry();

  for (const entry of tools) {
    signal?.throwIfAborted();
    if (isMCPToolSource(entry)) {
      const transport = await createTransportForSource(entry);
      const client = new MCPClient({ transport, timeout: entry.timeout });

      // Health check — fail fast if the server is unreachable
      const healthy = await client.healthCheck();
      if (!healthy) {
        client[Symbol.dispose]();
        throw new MCPServerUnavailableError(entry.mcp);
      }

      // Discover tools
      const discovered = await client.discoverTools();

      // Pre-index discovered tools by name for O(1) schema lookup
      const schemaIndex = new Map(discovered.map((t) => [t.name, t]));

      // Register MCP tools with a dispatch function that validates input
      // and invokes through the client
      registry.registerMCP(discovered, entry.mcp, async (toolName: string, input: unknown) => {
        const toolDef = schemaIndex.get(toolName);
        if (toolDef && Object.keys(toolDef.inputSchema).length > 0) {
          const validation = validateSchema(input, toolDef.inputSchema);
          if (!validation.valid) {
            throw new ToolSchemaValidationError(toolName, validation.errors);
          }
        }

        return client.invokeTool(toolName, input, signal);
      });
    } else {
      registry.registerLocal(entry.definition, entry.execute);
    }
  }

  // Validate for name conflicts before the agent loop starts
  registry.validate();

  return registry;
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
    hooks,
    eventTarget,
    workflowId: optionsWorkflowId,
    agentId: optionsAgentId,
    onTurnStarted,
    onTurnCompleted,
    onToolCalled,
    onToolReturned,
    checkpointSizeWarningThreshold = 65_536,
  } = options;

  const resolvedWorkflowId = optionsWorkflowId ?? '';
  const resolvedAgentId = optionsAgentId ?? '';

  // Build the tool registry from mixed local + MCP entries
  const registry = await initializeTools(tools, signal);

  // Build the tool lookup map and definition list from the registry
  const registryTools = registry.getAll();
  const toolMap = new Map<string, RegistryTool>();
  const toolDefinitions: ToolDefinition[] = [];
  for (const tool of registryTools) {
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
  let sizeWarningFired = false;
  let budgetWarningFired = false;
  const previousModels: string[] = [];
  const reasoningTraces: string[] = [];
  const turnCosts: TurnCostEntry[] = [];

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
    let fallbackModels: string[] = [];
    if (modelRouter) {
      const routingContext: RoutingContext = {
        workflowId: resolvedWorkflowId,
        turnIndex,
        conversationLength: conversation.length,
        budgetRemaining: budget
          ? {
              tokensRemaining: budget.budgetRemaining().tokensRemaining,
              costRemaining: budget.budgetRemaining().costRemaining,
            }
          : undefined,
        previousModels: [...previousModels],
      };
      const selection = modelRouter.select(routingContext);
      currentModel = selection.model;
      fallbackModels = selection.fallback ?? [];
    }

    // Apply context window strategy if configured.
    // Always pass the full conversation — the strategy decides what to keep.
    let messagesToSend = [...conversation];
    if (contextManager) {
      const tokenCount = await provider.countTokens(messagesToSend);
      if (contextManager.shouldCompact(tokenCount)) {
        const compacted = await contextManager.compact(messagesToSend);
        messagesToSend = compacted.messages;

        // Dispatch context-compacted event
        if (eventTarget && resolvedWorkflowId) {
          eventTarget.dispatchEvent(
            new AgentContextCompactedEvent(
              resolvedWorkflowId,
              resolvedAgentId,
              contextManager.strategyName,
              compacted.tokensBefore,
              compacted.tokensAfter,
              compacted.messagesDropped,
            ),
          );
        }
      }
    }

    // Run beforeTurn hook if provided
    if (hooks?.beforeTurn) {
      const hookResult = await hooks.beforeTurn({
        turnIndex,
        messages: messagesToSend,
        model: currentModel,
      });

      if (hookResult.action === 'skip') {
        // Use skip result as the final content and break
        lastContent = hookResult.result ?? '';
        break;
      }

      // If the hook returned modified messages, use them
      if (hookResult.action === 'continue' && hookResult.messages) {
        messagesToSend = hookResult.messages;
      }
    }

    // Dispatch event to eventTarget if provided
    if (eventTarget && resolvedWorkflowId) {
      eventTarget.dispatchEvent(
        new AgentTurnStartedEvent(
          resolvedWorkflowId,
          resolvedAgentId,
          turnIndex,
          currentModel,
          0,
          messagesToSend.length,
        ),
      );
    }

    // Fire turn-started callback
    onTurnStarted?.({
      turnIndex,
      model: currentModel,
      conversationLength: messagesToSend.length,
    });

    const turnStart = Date.now();
    const costBefore = budget?.budgetRemaining().costUsed ?? 0;

    // Call LLM provider with fallback chain
    let response: ChatResponse | undefined;
    let fallbackAttempts = 0;
    const modelsToTry = [currentModel, ...fallbackModels];
    const originalModel = currentModel;
    let lastError: unknown;

    for (let attempt = 0; attempt < modelsToTry.length; attempt++) {
      const attemptModel = modelsToTry[attempt]!;
      try {
        const chatOptions: import('./providers/interface').ChatOptions = {
          model: attemptModel,
        };
        if (toolDefinitions.length > 0) {
          chatOptions.tools = toolDefinitions;
        }
        if (signal) {
          chatOptions.signal = signal;
        }
        response = await provider.chat(messagesToSend, chatOptions);

        // Record success in health tracker
        if (healthTracker) {
          healthTracker.recordSuccess(provider.name);
        }

        // Update currentModel to whichever one succeeded
        currentModel = attemptModel;
        break;
      } catch (error: unknown) {
        lastError = error;

        // If the request was aborted, stop immediately — do not try fallback models.
        if (signal?.aborted || (error instanceof DOMException && error.name === 'AbortError')) {
          throw error;
        }

        // Record failure in health tracker
        if (healthTracker) {
          healthTracker.recordFailure(provider.name);
        }

        // If there are more fallbacks to try, dispatch fallback event and continue
        const nextModel = modelsToTry[attempt + 1];
        if (nextModel) {
          fallbackAttempts++;
          if (eventTarget && resolvedWorkflowId) {
            const reason = error instanceof Error ? error.message : String(error);
            eventTarget.dispatchEvent(
              new AgentModelFallbackEvent(
                resolvedWorkflowId,
                resolvedAgentId,
                turnIndex,
                attemptModel,
                reason,
                nextModel,
                fallbackAttempts,
              ),
            );
          }
        }
      }
    }

    // If no model succeeded, throw the last error
    if (response === undefined) {
      throw lastError;
    }

    // Track which model was used for this turn
    previousModels.push(currentModel);

    const turnDuration = Date.now() - turnStart;

    // Accumulate usage
    totalTokens.inputTokens += response.usage.inputTokens;
    totalTokens.outputTokens += response.usage.outputTokens;
    totalTokens.totalTokens += response.usage.totalTokens;

    // Record usage in budget tracker
    if (budget) {
      budget.recordUsage(currentModel, response.usage.inputTokens, response.usage.outputTokens);

      // Fire the onBudgetWarning hook once when usage crosses the 80% threshold
      if (hooks?.onBudgetWarning && !budgetWarningFired) {
        const state = budget.budgetRemaining();
        const tokenBudgetTotal = state.tokensUsed + state.tokensRemaining;
        const costBudgetTotal = state.costUsed + state.costRemaining;
        const tokenFraction =
          tokenBudgetTotal > 0 && isFinite(tokenBudgetTotal)
            ? state.tokensUsed / tokenBudgetTotal
            : 0;
        const costFraction =
          costBudgetTotal > 0 && isFinite(costBudgetTotal) ? state.costUsed / costBudgetTotal : 0;
        const budgetUsedPercent = Math.max(tokenFraction, costFraction) * 100;

        if (budgetUsedPercent >= 80) {
          budgetWarningFired = true;
          await hooks.onBudgetWarning({
            tokensRemaining: state.tokensRemaining,
            costRemaining: state.costRemaining,
            budgetUsedPercent,
          });
        }
      }
    }

    const turnCost = (budget?.budgetRemaining().costUsed ?? 0) - costBefore;
    totalCost += turnCost;

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

    // Capture reasoning trace if present
    if (response.reasoningTrace) {
      reasoningTraces.push(response.reasoningTrace);
    }

    // Exit path: final answer (no tool calls)
    if (response.toolCalls.length === 0) {
      // Record turn cost entry
      turnCosts.push({
        turn: turnIndex,
        inputTokens: response.usage.inputTokens,
        outputTokens: response.usage.outputTokens,
        cost: turnCost,
        model: currentModel,
        tools: [],
      });

      // Dispatch turn-completed event
      if (eventTarget && resolvedWorkflowId) {
        eventTarget.dispatchEvent(
          new AgentTurnCompletedEvent(
            resolvedWorkflowId,
            resolvedAgentId,
            turnIndex,
            originalModel,
            currentModel,
            response.usage.inputTokens,
            response.usage.outputTokens,
            turnCost,
            totalCost,
            turnDuration,
            0,
            fallbackAttempts,
            response.reasoningTrace,
          ),
        );
      }
      // Fire turn-completed callback
      onTurnCompleted?.({
        turnIndex,
        model: currentModel,
        inputTokens: response.usage.inputTokens,
        outputTokens: response.usage.outputTokens,
        cost: turnCost,
        duration: turnDuration,
        toolCallCount: 0,
      });

      // Check conversation size on final-answer path too
      if (eventTarget && resolvedWorkflowId && !sizeWarningFired) {
        const sizeBytes = estimateConversationSizeBytes(conversation);
        if (sizeBytes >= checkpointSizeWarningThreshold) {
          sizeWarningFired = true;
          eventTarget.dispatchEvent(
            new AgentCheckpointSizeWarningEvent(
              resolvedWorkflowId,
              resolvedAgentId,
              sizeBytes,
              turnIndex,
            ),
          );
        }
      }
      break;
    }

    // Execute tool calls
    const toolResults: Message['toolResults'] = [];

    for (const toolCall of response.toolCalls) {
      const toolOperationId = crypto.randomUUID();

      // Look up tool to determine source for events
      const tool = toolMap.get(toolCall.name);
      const toolSource: 'local' | 'mcp' = tool?.source ?? 'local';

      // Dispatch tool-called event
      if (eventTarget && resolvedWorkflowId) {
        eventTarget.dispatchEvent(
          new AgentToolCalledEvent(
            resolvedWorkflowId,
            resolvedAgentId,
            turnIndex,
            toolCall.name,
            toolCall.input,
            toolSource,
            toolOperationId,
          ),
        );
      }

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

      // Run afterToolCall hook if provided
      if (hooks?.afterToolCall && success) {
        const hookResult = await hooks.afterToolCall({
          turnIndex,
          toolCall,
          result: output,
        });

        if (hookResult.action === 'reject') {
          output = JSON.stringify({ error: hookResult.reason });
          success = false;
        } else if (hookResult.action === 'continue' && hookResult.result !== undefined) {
          output =
            typeof hookResult.result === 'string'
              ? hookResult.result
              : JSON.stringify(hookResult.result);
        }
      }

      const toolDuration = Date.now() - toolStart;

      // Dispatch tool-returned event
      if (eventTarget && resolvedWorkflowId) {
        eventTarget.dispatchEvent(
          new AgentToolReturnedEvent(
            resolvedWorkflowId,
            resolvedAgentId,
            turnIndex,
            toolCall.name,
            toolDuration,
            success,
            toolOperationId,
          ),
        );
      }

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

    // Record turn cost entry (with tool names)
    turnCosts.push({
      turn: turnIndex,
      inputTokens: response.usage.inputTokens,
      outputTokens: response.usage.outputTokens,
      cost: turnCost,
      model: currentModel,
      tools: response.toolCalls.map((tc) => tc.name),
    });

    // Dispatch turn-completed event (with tool calls)
    if (eventTarget && resolvedWorkflowId) {
      eventTarget.dispatchEvent(
        new AgentTurnCompletedEvent(
          resolvedWorkflowId,
          resolvedAgentId,
          turnIndex,
          originalModel,
          currentModel,
          response.usage.inputTokens,
          response.usage.outputTokens,
          turnCost,
          totalCost,
          turnDuration,
          response.toolCalls.length,
          fallbackAttempts,
          response.reasoningTrace,
        ),
      );
    }

    // Fire turn-completed callback
    onTurnCompleted?.({
      turnIndex,
      model: currentModel,
      inputTokens: response.usage.inputTokens,
      outputTokens: response.usage.outputTokens,
      cost: turnCost,
      duration: turnDuration,
      toolCallCount: response.toolCalls.length,
    });

    // Check conversation size and dispatch warning if threshold exceeded
    if (eventTarget && !sizeWarningFired) {
      const sizeBytes = estimateConversationSizeBytes(conversation);
      if (sizeBytes >= checkpointSizeWarningThreshold) {
        sizeWarningFired = true;
        eventTarget.dispatchEvent(
          new AgentCheckpointSizeWarningEvent(
            resolvedWorkflowId,
            resolvedAgentId,
            sizeBytes,
            turnIndex,
          ),
        );
      }
    }
  }

  return {
    content: lastContent,
    conversation,
    totalTokens,
    totalCost,
    turnCount,
    reasoningTraces,
    turnCosts,
  };
}
