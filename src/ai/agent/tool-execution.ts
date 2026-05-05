import { AgentToolCalledEvent, AgentToolReturnedEvent } from '../events/index.ts';
import { computeSemanticHash, ToolCallReplayConflictError } from '../tool-effect-log.ts';
import type { RegistryToolEntry } from './tool-initialization.ts';
import type { AgentRuntime, Message, ToolCall, ToolExecutionOutcome, ToolResult } from './types.ts';

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
        toolCall.input,
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
          const result = tool.identity(toolCall.input);
          if (/^[0-9a-f]{16}$/.test(result.semanticHash)) {
            return result.semanticHash;
          }
        } catch {
          // Fall through to the default semantic hash.
        }
      }
      return computeSemanticHash({ name: toolCall.name, input: toolCall.input });
    })();

    const existing = await effectLog.lookup(semanticHash);

    if (existing?.status === 'committed' && existing.toolName === toolCall.name) {
      effectLog.recordReplay();
      return { output: existing.output, success: true };
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
        await effectLog.commit(semanticHash, toolCall.name, outcome.output);
      } else {
        await effectLog.abort(semanticHash, toolCall.name, outcome.output);
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
  let output: string;
  let success = true;

  if (!tool) {
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
    } catch (error: unknown) {
      output = JSON.stringify({ error: error instanceof Error ? error.message : String(error) });
      success = false;
    }
  }

  return { output, success };
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
    toolCallId: toolCall.id,
    output: outcome.output,
    isError: !outcome.success,
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
