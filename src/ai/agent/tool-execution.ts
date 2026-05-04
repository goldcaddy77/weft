import { AgentToolCalledEvent, AgentToolReturnedEvent } from '../events.ts';
import type { RegistryTool } from '../mcp/registry.ts';
import type { Message, ToolCall, ToolResult } from '../providers/types.ts';
import {
  setToolCacheEntry,
  sweepExpiredCacheEntries,
  TOOL_CACHE_SWEEP_THRESHOLD,
} from '../tool-cache.ts';
import { computeSemanticHash, ToolCallReplayConflictError } from '../tool-effect-log.ts';
import type { AgentRuntime, ToolExecutionOutcome } from './types.ts';

function buildCacheKey(toolName: string, input: unknown): string {
  return `${toolName}:${JSON.stringify(input)}`;
}

/**
 * Estimate the serialized size of a conversation in bytes.
 * Uses JSON.stringify as a reasonable approximation of the size
 * the conversation would occupy in a checkpoint blob.
 */
export function estimateConversationSizeBytes(conversation: Message[]): number {
  return new TextEncoder().encode(JSON.stringify(conversation)).byteLength;
}

export function dispatchToolCalled(
  runtime: AgentRuntime,
  turnIndex: number,
  toolCall: ToolCall,
  toolSource: 'local' | 'mcp',
  toolOperationId: string,
): void {
  if (runtime.options.eventTarget && runtime.options.workflowId) {
    runtime.options.eventTarget.dispatchEvent(
      new AgentToolCalledEvent(
        runtime.options.workflowId,
        runtime.options.agentId,
        turnIndex,
        toolCall.name,
        toolCall.input,
        toolSource,
        toolOperationId,
      ),
    );
  }

  runtime.options.onToolCalled?.({
    turnIndex,
    toolName: toolCall.name,
    toolInput: toolCall.input,
  });
}

// oxlint-disable-next-line complexity -- ID:ai-agent-resolve-tool-execution-complexity
export async function resolveToolExecution(
  runtime: AgentRuntime,
  turnIndex: number,
  toolCall: ToolCall,
  tool: RegistryTool | undefined,
): Promise<ToolExecutionOutcome> {
  const effectLog = runtime.options.toolEffectLog;

  // ---------------------------------------------------------------------------
  // Effect log — durable deduplication across checkpoint-restore cycles
  //
  // Compute the semantic hash and consult the log before any execution.
  // This prevents duplicate tool calls when the agent is restored from a
  // checkpoint mid-turn and the LLM re-synthesizes a semantically different
  // version of an already-dispatched tool call.
  // ---------------------------------------------------------------------------
  if (effectLog) {
    const semanticHash = (() => {
      if (tool?.identity) {
        try {
          const result = tool.identity(toolCall.input);
          // Validate that the custom identity returns a well-formed 16-char hex
          // string. An invalid hash would produce unpredictable storage keys.
          // Fall back to the default hash if validation fails.
          if (/^[0-9a-f]{16}$/.test(result.semanticHash)) {
            return result.semanticHash;
          }
        } catch {
          // identity() threw — fall through to the default hash.
        }
      }
      return computeSemanticHash({ name: toolCall.name, input: toolCall.input });
    })();

    const existing = await effectLog.lookup(semanticHash);

    if (existing?.status === 'committed' && existing.toolName === toolCall.name) {
      // A prior run completed this tool call successfully — replay the result
      // without re-executing the tool. The toolName check guards against
      // cross-tool hash collisions from custom identity() functions that omit
      // the tool name. A mismatched toolName falls through to execute normally.
      effectLog.recordReplay();
      return { output: existing.output, success: true };
    }

    if (existing?.status === 'in-flight' && existing.toolName === toolCall.name) {
      // The process crashed between recording in-flight and receiving the
      // result. Re-executing a non-idempotent tool could cause duplicate
      // effects. Throw so the caller can escalate. The toolName check guards
      // against spurious conflicts from cross-tool hash collisions.
      throw new ToolCallReplayConflictError(semanticHash, toolCall.name);
    }

    // Reaches here when:
    // - No existing record for this hash
    // - existing is `aborted` (retriable — re-execute)
    // - existing is `committed` or `in-flight` for a different tool (hash
    //   collision — proceed but do NOT overwrite the other tool's record)
    const shouldRecord = !existing || existing.toolName === toolCall.name;
    if (shouldRecord) {
      await effectLog.record(semanticHash, toolCall.name);
    }

    // Run the tool and update the log on success or failure.
    // Skip log writes on hash collision (shouldRecord=false) to avoid
    // overwriting a committed record that belongs to a different tool.
    // Use try/finally to abort the in-flight record if resolveToolExecutionInner
    // throws unexpectedly — leaving it in-flight permanently would cause a
    // ToolCallReplayConflictError on every future restore.
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
        await effectLog.commit(semanticHash, toolCall.name, outcome.output);
      } else {
        await effectLog.abort(semanticHash, toolCall.name, outcome.output);
      }
    }
    return outcome;
  }

  // No effect log configured — execute directly (original behaviour).
  return resolveToolExecutionInner(runtime, turnIndex, toolCall, tool);
}

// oxlint-disable-next-line complexity -- ID:ai-agent-resolve-tool-execution-inner-complexity
export async function resolveToolExecutionInner(
  runtime: AgentRuntime,
  turnIndex: number,
  toolCall: ToolCall,
  tool: RegistryTool | undefined,
): Promise<ToolExecutionOutcome> {
  const cacheKey = buildCacheKey(toolCall.name, toolCall.input);

  // Proactively evict expired entries when the cache grows large. The
  // sweep uses the caller's configured `toolCacheMaxSize` so the proactive
  // read-time eviction agrees with the write-time eviction in
  // `setToolCacheEntry`.
  if (runtime.state.toolCache.size >= TOOL_CACHE_SWEEP_THRESHOLD) {
    sweepExpiredCacheEntries(
      runtime.state.toolCache,
      runtime.options.toolCacheTTL,
      runtime.options.toolCacheMaxSize,
    );
  }

  const cached = runtime.state.toolCache.get(cacheKey);
  const now = Date.now();

  let output: string;
  let success = true;
  if (cached && now - cached.timestamp < runtime.options.toolCacheTTL) {
    output = cached.output;
  } else if (!tool) {
    output = JSON.stringify({ error: `Unknown tool: ${toolCall.name}` });
    success = false;
  } else {
    try {
      const rawOutput = await tool.execute(toolCall.input);
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
      output = typeof rawOutput === 'string' ? rawOutput : JSON.stringify(rawOutput);
      setToolCacheEntry(
        runtime.state.toolCache,
        cacheKey,
        { output, timestamp: Date.now() },
        runtime.options.toolCacheMaxSize,
      );
    } catch (error: unknown) {
      output = JSON.stringify({ error: error instanceof Error ? error.message : String(error) });
      success = false;
    }
  }

  if (!(runtime.options.hooks?.afterToolCall && success)) {
    return { output, success };
  }

  const hookResult = await runtime.options.hooks.afterToolCall({
    turnIndex,
    toolCall,
    result: output,
  });
  if (hookResult.action === 'reject') {
    return {
      output: JSON.stringify({ error: hookResult.reason }),
      success: false,
    };
  }

  if (hookResult.action === 'continue' && hookResult.result !== undefined) {
    return {
      output:
        typeof hookResult.result === 'string'
          ? hookResult.result
          : JSON.stringify(hookResult.result),
      success,
    };
  }

  return { output, success };
}

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

  runtime.options.onToolReturned?.({
    turnIndex,
    toolName: toolCall.name,
    duration: toolDuration,
    success,
  });
}

export async function executeToolCall(
  runtime: AgentRuntime,
  turnIndex: number,
  toolCall: ToolCall,
): Promise<ToolResult> {
  const toolOperationId = crypto.randomUUID();
  const tool = runtime.toolMap.get(toolCall.name);
  const toolSource: 'local' | 'mcp' = tool?.source ?? 'local';
  dispatchToolCalled(runtime, turnIndex, toolCall, toolSource, toolOperationId);

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
    toolCallId: toolCall.id,
    output: outcome.output,
    isError: !outcome.success,
  };
}

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
