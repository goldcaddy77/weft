import { normalizeJSONValue } from './json-value.ts';
import type {
  ToolActionShape,
  ToolCall,
  ToolCallInput,
  ToolErrorShape,
  ToolResult,
  ToolResultInput,
} from './types.ts';

/** Materialize one provider-supplied tool call into Weft's canonical shape. */
export function materializeToolCall(toolCall: ToolCallInput): ToolCall {
  return {
    id: toolCall.id ?? crypto.randomUUID(),
    name: toolCall.name,
    arguments: normalizeJSONValue(toolCall.arguments ?? {}),
  };
}

/** Materialize provider-supplied tool calls into Weft's canonical shape. */
export function materializeToolCalls(toolCalls: ReadonlyArray<ToolCallInput>): ToolCall[] {
  return toolCalls.map((toolCall) => materializeToolCall(toolCall));
}

/** Normalize one tool-result input into Weft's canonical shape. */
export function materializeToolResult(toolResult: ToolResultInput): ToolResult {
  return {
    callId: toolResult.callId,
    outcome: toolResult.outcome,
    content: normalizeJSONValue(toolResult.content),
    ...(toolResult.error ? { error: normalizeToolError(toolResult.error) } : {}),
    ...(toolResult.action ? { action: normalizeToolAction(toolResult.action) } : {}),
    ...(toolResult.inputDigest ? { inputDigest: toolResult.inputDigest } : {}),
    ...(toolResult.outputDigest ? { outputDigest: toolResult.outputDigest } : {}),
  };
}

/** Build a normalized success result for a tool call. */
export function createSuccessfulToolResult(callId: string, content: unknown): ToolResult {
  return materializeToolResult({
    callId,
    outcome: 'success',
    content,
  });
}

/** Build a normalized error result for a tool call. */
export function createErrorToolResult(
  callId: string,
  error: ToolErrorShape,
  content: unknown = { error: error.message },
): ToolResult {
  return materializeToolResult({
    callId,
    outcome: 'error',
    content,
    error,
  });
}

function normalizeToolError(error: NonNullable<ToolResultInput['error']>): ToolErrorShape {
  return {
    code: error.code,
    category: error.category,
    retryable: error.retryable,
    message: error.message,
    ...(error.details !== undefined ? { details: normalizeJSONValue(error.details) } : {}),
  };
}

function normalizeToolAction(action: NonNullable<ToolResultInput['action']>): ToolActionShape {
  return {
    type: action.type,
    ...(action.message ? { message: action.message } : {}),
    ...(action.schema !== undefined ? { schema: normalizeJSONValue(action.schema) } : {}),
  };
}
