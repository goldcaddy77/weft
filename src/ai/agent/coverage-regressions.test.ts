import { describe, expect, it, mock } from 'bun:test';

import type { ToolEffectLogLike } from '../../core/effect-log/index.ts';
import { ToolCallReplayConflictError } from '../../core/effect-log/index.ts';
import { createChatOptions, isAbortError } from './chat.ts';
import { isJSONValue, normalizeJSONValue } from './json-value.ts';
import {
  executeToolCall,
  resolveToolExecution,
  resolveToolExecutionInner,
} from './tool-execution.ts';
import { initializeTools, type RegistryToolEntry } from './tool-initialization.ts';
import type { AgentRuntime, ToolCall } from './types.ts';

function createRuntime(
  overrides: Partial<AgentRuntime['options']> = {},
  toolMap = new Map<string, RegistryToolEntry>(),
): AgentRuntime {
  return {
    options: {
      defaultModel: 'test-model',
      provider: {
        name: 'test-provider',
        async chat() {
          throw new Error('provider should not be called');
        },
      },
      maxTurns: 1,
      workflowId: 'workflow-1',
      agentId: 'agent-1',
      checkpointSizeWarningThreshold: 65_536,
      ...overrides,
    },
    toolMap,
    toolDefinitions: [],
    state: {
      conversation: [],
      totalTokens: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      turnCount: 0,
      lastContent: '',
      sizeWarningFired: false,
      reasoningTraces: [],
      turnUsage: [],
    },
    dispose() {},
  };
}

function createToolCall(name = 'tool'): ToolCall {
  return { id: 'call-1', name, arguments: { value: 1 } };
}

function createRegistryToolEntry(overrides: Partial<RegistryToolEntry> = {}): RegistryToolEntry {
  return {
    definition: { name: 'tool', input: { type: 'object' } },
    async execute(input) {
      return input;
    },
    source: 'local',
    ...overrides,
  };
}

describe('agent coverage regressions', () => {
  it('detects abort errors from the signal state and DOM exception shape', () => {
    const controller = new AbortController();
    expect(isAbortError(controller.signal, new Error('not aborted'))).toBe(false);

    controller.abort();
    expect(isAbortError(controller.signal, new Error('stopped'))).toBe(true);
    expect(isAbortError(undefined, new DOMException('stopped', 'AbortError'))).toBe(true);
  });

  it('threads tools and abort signals into provider chat options', () => {
    const controller = new AbortController();
    const runtime = createRuntime({ signal: controller.signal });
    runtime.toolDefinitions.push({ name: 'lookup', input: { type: 'object' } });

    expect(createChatOptions(runtime, 'model-a', 3)).toEqual({
      model: 'model-a',
      turnIndex: 3,
      tools: [{ name: 'lookup', input: { type: 'object' } }],
      signal: controller.signal,
    });
  });

  it('normalizes unsupported JSON values through stable fallbacks', () => {
    expect(normalizeJSONValue(undefined)).toBeNull();
    expect(normalizeJSONValue(() => undefined)).toBeNull();
    const recursiveError = new Error('broken') as Error & { self?: unknown };
    recursiveError.self = recursiveError;
    expect(normalizeJSONValue(recursiveError)).toEqual({
      name: 'Error',
      message: 'broken',
    });
    expect(normalizeJSONValue(123n)).toBe('123');
    expect(normalizeJSONValue(Symbol.for('agent-test'))).toBe('agent-test');
    expect(normalizeJSONValue(new Date('2026-05-11T00:00:00.000Z'))).toBe(
      '2026-05-11T00:00:00.000Z',
    );

    const circular: Record<string, unknown> = {};
    circular['self'] = circular;
    expect(normalizeJSONValue(circular)).toBeNull();
  });

  it('rejects recursive and non-plain JSON-like values', () => {
    const recursiveArray: unknown[] = [];
    recursiveArray.push(recursiveArray);
    expect(isJSONValue(recursiveArray)).toBe(false);
    expect(isJSONValue([Symbol('bad')])).toBe(false);
    expect(isJSONValue(['ok', 1, false])).toBe(true);

    const recursiveObject: Record<string, unknown> = {};
    recursiveObject['self'] = recursiveObject;
    expect(isJSONValue(recursiveObject)).toBe(false);

    class CustomObject {
      readonly value = 1;
    }
    expect(isJSONValue(new CustomObject())).toBe(false);

    const nullPrototypeObject = Object.create(null) as Record<string, unknown>;
    nullPrototypeObject['ok'] = true;
    expect(isJSONValue(nullPrototypeObject)).toBe(true);
  });

  it('normalizes legacy, promise-backed, and static-identity tools', async () => {
    const legacyTools = await initializeTools([
      {
        definition: {
          name: 'legacy',
          description: 'Legacy tool.',
          inputSchema: { type: 'object' },
        },
        async execute() {
          return 'legacy-result';
        },
        async verify() {
          return true;
        },
        identity() {
          return { semanticHash: '1234567890abcdef', intentCriticalFields: ['legacy'] };
        },
      },
    ]);
    const legacyEntry = legacyTools.registry.getAll()[0];
    expect(legacyEntry?.definition).toEqual({
      name: 'legacy',
      description: 'Legacy tool.',
      input: { type: 'object' },
    });
    expect(await legacyEntry?.execute({})).toBe('legacy-result');
    expect(await legacyEntry?.verify?.('legacy-result')).toBe(true);
    expect(legacyEntry?.identity?.({})?.semanticHash).toBe('1234567890abcdef');

    const flatTools = await initializeTools([
      {
        name: 'flat',
        input: { type: 'object' },
        execute: Promise.resolve(async () => 'flat-result'),
        identity: { namespace: 'tests', name: 'flat', version: '1' },
      },
    ]);
    const flatEntry = flatTools.registry.getAll()[0];
    expect(await flatEntry?.execute({})).toBe('flat-result');
    expect(flatEntry?.identity?.({ value: 1 })?.semanticHash).toMatch(/^[0-9a-f]{16}$/);
    expect(flatEntry?.identity?.({ value: 1 })?.intentCriticalFields).toEqual([
      'identity',
      'arguments',
    ]);
  });

  it('records deferred tool verification promises when a recorder is configured', async () => {
    const recordedVerifications: Array<Promise<void>> = [];
    const runtime = createRuntime({
      verificationRecorder: {
        recordVerification(verification) {
          recordedVerifications.push(verification);
        },
      },
    });
    const tool = createRegistryToolEntry({
      async execute() {
        return { ok: true };
      },
      async verify(result) {
        return isJSONValue(result);
      },
    });

    const outcome = await resolveToolExecutionInner(runtime, 0, createToolCall(), tool);

    expect(outcome).toEqual({ content: { ok: true }, success: true });
    expect(recordedVerifications).toHaveLength(1);
    await expect(recordedVerifications[0]).resolves.toBeUndefined();
  });

  it('awaits tool verification immediately when no recorder is configured', async () => {
    let verified = false;
    const runtime = createRuntime();
    const tool = createRegistryToolEntry({
      async execute() {
        return 'verified-output';
      },
      async verify() {
        verified = true;
        return true;
      },
    });

    const outcome = await resolveToolExecutionInner(runtime, 0, createToolCall(), tool);

    expect(outcome).toEqual({ content: 'verified-output', success: true });
    expect(verified).toBe(true);
  });

  it('returns an error result when immediate tool verification fails', async () => {
    const runtime = createRuntime();
    const tool = createRegistryToolEntry({
      async execute() {
        return 'unverified-output';
      },
      async verify() {
        return false;
      },
    });

    const outcome = await resolveToolExecutionInner(runtime, 0, createToolCall(), tool);

    expect(outcome).toMatchObject({
      success: false,
      error: { message: 'Verification failed for tool "tool"' },
    });
  });

  it('aborts durable effect-log records when tool execution fails', async () => {
    const abort = mock(async (_hash: string, _toolName: string, _reason: string) => {});
    const effectLog: ToolEffectLogLike = {
      duplicatesPrevented: 0,
      async lookup() {
        return null;
      },
      recordReplay() {},
      async record() {},
      async commit() {},
      abort,
    };
    const runtime = createRuntime({ toolEffectLog: effectLog });
    const tool = createRegistryToolEntry({
      async execute() {
        throw new Error('tool exploded');
      },
    });

    await expect(resolveToolExecution(runtime, 0, createToolCall(), tool)).resolves.toMatchObject({
      success: false,
      error: { message: 'tool exploded' },
    });

    expect(abort).toHaveBeenCalledTimes(1);
    expect(abort.mock.calls[0]?.[1]).toBe('tool');
    expect(abort.mock.calls[0]?.[2]).toBe('tool exploded');
  });

  it('aborts durable effect-log records when result materialization throws', async () => {
    const abort = mock(async (_hash: string, _toolName: string, _reason: string) => {});
    const effectLog: ToolEffectLogLike = {
      duplicatesPrevented: 0,
      async lookup() {
        return null;
      },
      recordReplay() {},
      async record() {},
      async commit() {},
      abort,
    };
    const runtime = createRuntime({ toolEffectLog: effectLog });
    const toolCall = {
      get id(): string {
        throw new Error('tool call id unavailable');
      },
      name: 'tool',
      arguments: { value: 1 },
    };

    await expect(
      resolveToolExecution(runtime, 0, toolCall, createRegistryToolEntry()),
    ).rejects.toThrow('tool call id unavailable');

    expect(abort).toHaveBeenCalledTimes(1);
    expect(abort.mock.calls[0]?.[1]).toBe('tool');
    expect(abort.mock.calls[0]?.[2]).toBe('tool call id unavailable');
  });

  it('surfaces in-flight durable tool replay conflicts', async () => {
    const effectLog: ToolEffectLogLike = {
      duplicatesPrevented: 0,
      async lookup() {
        return { status: 'in-flight', toolName: 'tool', recordedAt: Date.now() };
      },
      recordReplay() {},
      async record() {},
      async commit() {},
      async abort() {},
    };
    const runtime = createRuntime({ toolEffectLog: effectLog });

    await expect(
      resolveToolExecution(runtime, 0, createToolCall(), createRegistryToolEntry()),
    ).rejects.toThrow(ToolCallReplayConflictError);
  });

  it('executes tool calls through the runtime registry', async () => {
    const toolMap = new Map<string, RegistryToolEntry>([
      [
        'tool',
        createRegistryToolEntry({
          async execute(input) {
            return { input };
          },
        }),
      ],
    ]);
    const runtime = createRuntime({}, toolMap);

    await expect(executeToolCall(runtime, 0, createToolCall())).resolves.toMatchObject({
      callId: 'call-1',
      outcome: 'success',
      content: { input: { value: 1 } },
    });
  });
});
