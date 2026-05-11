import { computeSemanticHash, ToolCallReplayConflictError } from '../../core/effect-log/index.ts';
import { AgentToolCalledEvent, AgentToolReturnedEvent } from '../events/index.ts';
import { normalizeJSONValue } from './json-value.ts';
import type { RegistryToolEntry } from './tool-initialization.ts';
import { createErrorToolResult, createSuccessfulToolResult } from './tool-materialization.ts';
import type {
  AgentRuntime,
  Message,
  ToolCall,
  ToolErrorShape,
  ToolExecutionOutcome,
  ToolResult,
} from './types.ts';

/**
 * Estimate the serialized size of a conversation in bytes.
 * Uses JSON.stringify as a reasonable approximation of checkpoint size.
 */
export function estimateConversationSizeBytes(conversation: Message[]): number {
  return new TextEncoder().encode(JSON.stringify(conversation)).byteLength;
}

/** Dispatch the tool-called event for a local tool invocation. */
export function dispatchToolCalled(
  runtime: AgentRuntime,
  turnIndex: number,
  toolCall: ToolCall,
  toolSource: 'local',
  toolOperationId: string,
): void {
  if (runtime.options.eventTarget && runtime.options.workflowId) {
    runtime.options.eventTarget.dispatchEvent(
      new AgentToolCalledEvent(
        runtime.options.workflowId,
        runtime.options.agentId,
        turnIndex,
        toolCall.name,
        toolCall.arguments,
        toolSource,
        toolOperationId,
      ),
    );
  }
}

/** Resolve a tool call with durable effect-log deduplication when configured. */
// oxlint-disable-next-line complexity -- ID:ai-agent-resolve-tool-execution-complexity
export async function resolveToolExecution(
  runtime: AgentRuntime,
  turnIndex: number,
  toolCall: ToolCall,
  tool: RegistryToolEntry | undefined,
): Promise<ToolExecutionOutcome> {
  const effectLog = runtime.options.toolEffectLog;

  if (effectLog) {
    const semanticHash = (() => {
      if (tool?.identity) {
        try {
          const result = tool.identity(toolCall.arguments);
          if (/^[0-9a-f]{16}$/.test(result.semanticHash)) {
            return result.semanticHash;
          }
        } catch {
          // Fall through to the default semantic hash.
        }
      }
      return computeSemanticHash({ name: toolCall.name, arguments: toolCall.arguments });
    })();

    const existing = await effectLog.lookup(semanticHash);

    if (existing?.status === 'committed' && existing.toolName === toolCall.name) {
      effectLog.recordReplay();
      return { content: normalizeJSONValue(existing.output), success: true };
    }

    if (existing?.status === 'in-flight' && existing.toolName === toolCall.name) {
      throw new ToolCallReplayConflictError(semanticHash, toolCall.name);
    }

    const shouldRecord = !existing || existing.toolName === toolCall.name;
    if (shouldRecord) {
      await effectLog.record(semanticHash, toolCall.name);
    }

    let outcome: Awaited<ReturnType<typeof resolveToolExecutionInner>>;
    try {
      outcome = await resolveToolExecutionInner(runtime, turnIndex, toolCall, tool);
    } catch (error) {
      if (shouldRecord) {
        const reason = error instanceof Error ? error.message : String(error);
        await effectLog.abort(semanticHash, toolCall.name, reason);
      }
      throw error;
    }

    if (shouldRecord) {
      if (outcome.success) {
        await effectLog.commit(semanticHash, toolCall.name, outcome.content);
      } else {
        await effectLog.abort(semanticHash, toolCall.name, outcome.error?.message ?? 'Tool failed');
      }
    }
    return outcome;
  }

  return resolveToolExecutionInner(runtime, turnIndex, toolCall, tool);
}

/** Execute a resolved local tool directly. */
export async function resolveToolExecutionInner(
  runtime: AgentRuntime,
  _turnIndex: number,
  toolCall: ToolCall,
  tool: RegistryToolEntry | undefined,
): Promise<ToolExecutionOutcome> {
  let content: unknown;
  let success = true;
  let toolError: ToolErrorShape | undefined;

  if (!tool) {
    toolError = {
      code: 'tool_not_found',
      category: 'not_found',
      retryable: false,
      message: `Unknown tool: ${toolCall.name}`,
    };
    content = { error: toolError.message };
    success = false;
  } else {
    try {
      const rawOutput = await tool.execute(toolCall.arguments);
      if (tool.verify) {
        const verification = (async () => {
          const verified = await tool.verify?.(rawOutput);
          if (!verified) {
            throw new Error(`Verification failed for tool "${toolCall.name}"`);
          }
        })();

        const verificationRecorder = runtime.options.verificationRecorder;
        if (verificationRecorder) {
          verificationRecorder.recordVerification(verification);
        } else {
          await verification;
        }
      }
      content = rawOutput;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      toolError = {
        code: 'tool_execution_failed',
        category: 'internal',
        retryable: false,
        message,
      };
      content = { error: message };
      success = false;
    }
  }

  if (success) {
    const result = createSuccessfulToolResult(toolCall.id, content);
    return { content: result.content, success: true };
  }

  const error = toolError ?? {
    code: 'tool_execution_failed',
    category: 'internal',
    retryable: false,
    message: `Tool "${toolCall.name}" failed without an error payload.`,
  };
  const result = createErrorToolResult(toolCall.id, error, content);
  return { content: result.content, success: false, error };
}

/** Dispatch the tool-returned event for a local tool invocation. */
export function dispatchToolReturned(
  runtime: AgentRuntime,
  turnIndex: number,
  toolCall: ToolCall,
  toolDuration: number,
  success: boolean,
  toolOperationId: string,
): void {
  if (runtime.options.eventTarget && runtime.options.workflowId) {
    runtime.options.eventTarget.dispatchEvent(
      new AgentToolReturnedEvent(
        runtime.options.workflowId,
        runtime.options.agentId,
        turnIndex,
        toolCall.name,
        toolDuration,
        success,
        toolOperationId,
      ),
    );
  }
}

/** Execute one model-requested tool call and convert it to a tool result. */
export async function executeToolCall(
  runtime: AgentRuntime,
  turnIndex: number,
  toolCall: ToolCall,
): Promise<ToolResult> {
  const toolOperationId = crypto.randomUUID();
  const tool = runtime.toolMap.get(toolCall.name);
  dispatchToolCalled(runtime, turnIndex, toolCall, 'local', toolOperationId);

  const toolStart = Date.now();
  const outcome = await resolveToolExecution(runtime, turnIndex, toolCall, tool);
  const toolDuration = Date.now() - toolStart;
  dispatchToolReturned(
    runtime,
    turnIndex,
    toolCall,
    toolDuration,
    outcome.success,
    toolOperationId,
  );

  return {
    callId: toolCall.id,
    outcome: outcome.success ? 'success' : 'error',
    content: outcome.content,
    ...(outcome.error ? { error: outcome.error } : {}),
  };
}

/** Execute a list of tool calls in order. */
export async function executeToolCalls(
  runtime: AgentRuntime,
  turnIndex: number,
  toolCalls: ToolCall[],
): Promise<ToolResult[]> {
  const toolResults: ToolResult[] = [];
  for (const toolCall of toolCalls) {
    toolResults.push(await executeToolCall(runtime, turnIndex, toolCall));
  }
  return toolResults;
}
