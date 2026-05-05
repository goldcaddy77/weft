/* oxlint-disable max-lines -- ID:core-engine-operations-agent-suspension-file-length */
import type {
  LLMProvider,
  PendingProviderResumeState,
  PersistedAgentLoopState,
} from '../../ai/agent/index.ts';
import {
  createSuspendingProvider,
  type PendingChatResumeState,
  type SuspendingProviderCoordinator,
} from '../../ai/agent/suspending-provider.ts';
import { KEYS, encodeStorageKeyComponent, type BatchOperation } from '../../storage/interface.ts';
import { decode, encode } from '../codec.ts';
import { isRecord } from '../debug-output.ts';
import type { WorkflowState } from '../types.ts';
import type { EngineInternals } from './internals.ts';
import { releaseSignalWaiter, trackWaiterKey, type ConsumedSignalResult } from './signals.ts';

export { repairMissingSignalMirrorIfNeeded } from './operations-agent-signal-repair.ts';

export type StoredPendingAgentExecutionState = {
  loopState: PersistedAgentLoopState;
  pendingResume: PendingProviderResumeState;
};

export type SignalPayloadWaitResult = { kind: 'resumed'; payload: unknown } | { kind: 'aborted' };

export class VersionMismatchError extends Error {
  readonly offendingField?: string;

  constructor(message: string, offendingField?: string) {
    super(message);
    this.name = 'VersionMismatchError';
    if (offendingField !== undefined) {
      this.offendingField = offendingField;
    }
  }
}

export type AgentSuspensionCallbacks = {
  hasBufferedSignal: (workflowId: string, signalName: string) => Promise<boolean>;
  consumeSignal: (workflowId: string, signalName: string) => Promise<ConsumedSignalResult>;
  waitForSignalPayload: (
    workflowId: string,
    signalName: string,
  ) => Promise<SignalPayloadWaitResult>;
  runSerializedWorkflowStateWrite: <Result>(
    workflowId: string,
    writeOperation: () => Promise<Result>,
  ) => Promise<Result>;
  loadWorkflowState: (workflowId: string) => Promise<WorkflowState | null>;
  resumeParkedInlineWorkflow: (workflowId: string) => Promise<void>;
};

export function withPendingChatResumeTurnIndex(
  turnIndex: number,
  state: PendingChatResumeState,
): PendingProviderResumeState {
  return { ...state, turnIndex };
}

function agentExecutionStateStoragePrefix(workflowId: string): string {
  return `agent-execution:${encodeStorageKeyComponent(workflowId)}:`;
}

function parseAgentExecutionStepIndex(key: string): number | undefined {
  const stepIndexText = key.slice(key.lastIndexOf(':') + 1);
  const stepIndex = Number.parseInt(stepIndexText, 10);
  if (!Number.isSafeInteger(stepIndex) || stepIndex < 0) {
    return undefined;
  }

  return stepIndex;
}

function hasNumberProperties(value: Record<string, unknown>, properties: string[]): boolean {
  return properties.every((property) => typeof value[property] === 'number');
}

function hasArrayProperties(value: Record<string, unknown>, properties: string[]): boolean {
  return properties.every((property) => Array.isArray(value[property]));
}

function isTokenUsageRecord(value: unknown): boolean {
  return (
    isRecord(value) && hasNumberProperties(value, ['inputTokens', 'outputTokens', 'totalTokens'])
  );
}

function logUnknownPersistedAgentLoopFields(value: Record<string, unknown>): void {
  const knownFields = new Set([
    'schemaVersion',
    'conversation',
    'totalTokens',
    'turnCount',
    'lastContent',
    'sizeWarningFired',
    'agentId',
    'workflowId',
    'reasoningTraces',
    'turnUsage',
    'pendingProviderResume',
  ]);

  const unknownFields = Object.keys(value).filter((field) => !knownFields.has(field));
  if (unknownFields.length > 0) {
    console.debug(
      `[weft] Ignoring unknown persisted agent loop fields: ${unknownFields.join(', ')}`,
    );
  }
}

function assertNoForbiddenPersistedAgentLoopFields(value: Record<string, unknown>): void {
  for (const field of ['toolCacheEntries', 'previousModels', 'budgetState']) {
    if (field in value) {
      throw new VersionMismatchError(
        `Persisted agent loop state contains unsupported v1 field "${field}"`,
        field,
      );
    }
  }
}

// oxlint-disable-next-line complexity -- ID:core-engine-operations-agent-suspension-is-persisted-state-complexity
export function isPersistedAgentLoopStateValue(value: unknown): value is PersistedAgentLoopState {
  if (!isRecord(value)) {
    return false;
  }

  assertNoForbiddenPersistedAgentLoopFields(value);

  if (value['schemaVersion'] !== 2) {
    return false;
  }

  const lastContent = value['lastContent'];
  const requiredShapeMatches =
    Array.isArray(value['conversation']) &&
    isTokenUsageRecord(value['totalTokens']) &&
    typeof value['turnCount'] === 'number' &&
    (typeof lastContent === 'string' || lastContent === null) &&
    typeof value['sizeWarningFired'] === 'boolean' &&
    typeof value['agentId'] === 'string' &&
    typeof value['workflowId'] === 'string' &&
    hasArrayProperties(value, ['reasoningTraces', 'turnUsage']);

  if (!requiredShapeMatches) {
    return false;
  }

  logUnknownPersistedAgentLoopFields(value);
  return true;
}

function isStoredPendingAgentExecutionState(
  value: unknown,
): value is StoredPendingAgentExecutionState {
  if (
    !isRecord(value) ||
    !isPersistedAgentLoopStateValue(value['loopState']) ||
    !isRecord(value['pendingResume']) ||
    typeof value['pendingResume']['turnIndex'] !== 'number' ||
    !isRecord(value['pendingResume']['hint']) ||
    typeof value['pendingResume']['hint']['resumeToken'] !== 'string' ||
    typeof value['pendingResume']['resumed'] !== 'boolean'
  ) {
    return false;
  }

  if (!value['pendingResume']['resumed']) {
    return true;
  }

  return 'payload' in value['pendingResume'];
}

export function createAgentResumeSignalName(stepIndex: number, resumeToken: string): string {
  return `agent-resume:${String(stepIndex).padStart(10, '0')}:${resumeToken}`;
}

export async function waitForSignalPayload(
  internals: EngineInternals,
  workflowId: string,
  signalName: string,
  callbacks: Pick<AgentSuspensionCallbacks, 'consumeSignal'>,
): Promise<SignalPayloadWaitResult> {
  const abortSignal = internals.abortController.signal;
  const waiterKey = `${workflowId}:${signalName}`;
  let pendingWaiterResolve: (() => void) | undefined;

  try {
    while (true) {
      if (abortSignal.aborted) {
        return { kind: 'aborted' };
      }

      const existingPayload = await callbacks.consumeSignal(workflowId, signalName);
      if (existingPayload.found) {
        return { kind: 'resumed', payload: existingPayload.payload };
      }

      const { promise, resolve } = Promise.withResolvers<void>();
      internals.signalWaiters.set(waiterKey, resolve);
      trackWaiterKey(internals.signalWaitersByWorkflow, workflowId, waiterKey);
      pendingWaiterResolve = resolve;

      if (abortSignal.aborted) {
        releaseSignalWaiter(internals, workflowId, waiterKey, resolve);
        pendingWaiterResolve = undefined;
        return { kind: 'aborted' };
      }

      const bufferedPayload = await callbacks.consumeSignal(workflowId, signalName);
      if (bufferedPayload.found) {
        releaseSignalWaiter(internals, workflowId, waiterKey, resolve);
        pendingWaiterResolve = undefined;
        return { kind: 'resumed', payload: bufferedPayload.payload };
      }

      await promise;
      pendingWaiterResolve = undefined;
    }
  } finally {
    if (pendingWaiterResolve) {
      releaseSignalWaiter(internals, workflowId, waiterKey, pendingWaiterResolve);
    }
  }
}

export async function parkInlineWorkflowForAgentSuspension(
  internals: EngineInternals,
  workflowId: string,
  stepIndex: number,
  resumeToken: string,
  callbacks: Pick<
    AgentSuspensionCallbacks,
    | 'hasBufferedSignal'
    | 'loadWorkflowState'
    | 'resumeParkedInlineWorkflow'
    | 'runSerializedWorkflowStateWrite'
  >,
): Promise<boolean> {
  if (internals.inlineStrategy === null) {
    return false;
  }

  const context = internals.inlineStrategy.getContext(workflowId);
  if (context?.hasUpdateHandlers || context?.hasExposedAccessors) {
    return false;
  }

  const internalSignalName = createAgentResumeSignalName(stepIndex, resumeToken);
  if (await callbacks.hasBufferedSignal(workflowId, internalSignalName)) {
    return false;
  }

  const publishedParkedMarker = await publishParkedInlineWorkflowMarker(
    internals,
    workflowId,
    callbacks,
  );
  if (!publishedParkedMarker) {
    return false;
  }

  if (await callbacks.hasBufferedSignal(workflowId, internalSignalName)) {
    await callbacks.resumeParkedInlineWorkflow(workflowId);
  }

  return true;
}

async function publishParkedInlineWorkflowMarker(
  internals: EngineInternals,
  workflowId: string,
  callbacks: Pick<
    AgentSuspensionCallbacks,
    'loadWorkflowState' | 'runSerializedWorkflowStateWrite'
  >,
): Promise<boolean> {
  return callbacks.runSerializedWorkflowStateWrite(workflowId, async () => {
    const latestState = await callbacks.loadWorkflowState(workflowId);
    if (
      internals.terminalizingWorkflows.has(workflowId) ||
      !latestState ||
      latestState.status !== 'running'
    ) {
      return false;
    }

    internals.inlineStrategy?.parkWorkflow(workflowId);
    internals.parkedInlineWorkflows.add(workflowId);
    return true;
  });
}

export function createAgentProvider(
  internals: EngineInternals,
  workflowId: string,
  stepIndex: number,
  provider: LLMProvider,
  callbacks: AgentSuspensionCallbacks,
): LLMProvider {
  if (!internals.options.suspendOnLlmWait) {
    return provider;
  }

  return createSuspendingProvider(
    provider,
    createSuspendingProviderCoordinator(internals, workflowId, stepIndex, callbacks),
  );
}

function createSuspendingProviderCoordinator(
  internals: EngineInternals,
  workflowId: string,
  stepIndex: number,
  callbacks: AgentSuspensionCallbacks,
): SuspendingProviderCoordinator {
  const toInternalSignalName = (resumeToken: string) =>
    createAgentResumeSignalName(stepIndex, resumeToken);

  return {
    load: (turnIndex) => loadPendingChatResumeState(internals, workflowId, stepIndex, turnIndex),
    store: (turnIndex, state) =>
      storePendingChatResumeState(internals, workflowId, stepIndex, turnIndex, state, callbacks),
    clear: (turnIndex) => clearPendingChatResumeState(internals, workflowId, stepIndex, turnIndex),
    consumeSignal: (resumeToken) =>
      callbacks.consumeSignal(workflowId, toInternalSignalName(resumeToken)),
    canSuspend: true,
  };
}

function signalStoragePrefix(workflowId: string, signalName: string): string {
  return `sig:${encodeStorageKeyComponent(workflowId)}:${signalName}:`;
}

async function collectBufferedSignalMirrorOperations(
  internals: EngineInternals,
  workflowId: string,
  sourceSignalName: string,
  targetSignalName: string,
  callbacks: AgentSuspensionCallbacks,
): Promise<BatchOperation[]> {
  if (await callbacks.hasBufferedSignal(workflowId, targetSignalName)) {
    return [];
  }

  const prefix = signalStoragePrefix(workflowId, sourceSignalName);
  for await (const [_key, value] of internals.storage.scan(prefix, { limit: 1 })) {
    return [
      {
        type: 'put',
        key: KEYS.signal(workflowId, targetSignalName, crypto.randomUUID()),
        value: new Uint8Array(value),
      },
    ];
  }

  return [];
}

async function collectBufferedSignalDeleteOperations(
  internals: EngineInternals,
  workflowId: string,
  signalName: string,
): Promise<BatchOperation[]> {
  const prefix = signalStoragePrefix(workflowId, signalName);
  const operations: BatchOperation[] = [];

  for await (const [key] of internals.storage.scan(prefix)) {
    operations.push({ type: 'delete', key });
  }

  return operations;
}

async function loadPendingChatResumeState(
  internals: EngineInternals,
  workflowId: string,
  stepIndex: number,
  turnIndex: number,
): Promise<PendingChatResumeState | undefined> {
  const executionState = await loadPendingAgentExecutionState(internals, workflowId, stepIndex);
  if (!executionState || executionState.pendingResume.turnIndex !== turnIndex) {
    return undefined;
  }

  return executionState.pendingResume;
}

async function storePendingChatResumeState(
  internals: EngineInternals,
  workflowId: string,
  stepIndex: number,
  turnIndex: number,
  state: PendingChatResumeState,
  callbacks: AgentSuspensionCallbacks,
): Promise<void> {
  const executionState = await loadPendingAgentExecutionState(internals, workflowId, stepIndex);
  if (!executionState) {
    return;
  }

  await storePendingAgentExecutionState(
    internals,
    workflowId,
    stepIndex,
    {
      ...executionState,
      pendingResume: withPendingChatResumeTurnIndex(turnIndex, state),
    },
    callbacks,
  );
}

async function clearPendingChatResumeState(
  internals: EngineInternals,
  workflowId: string,
  stepIndex: number,
  turnIndex: number,
): Promise<void> {
  const executionState = await loadPendingAgentExecutionState(internals, workflowId, stepIndex);
  if (!executionState || executionState.pendingResume.turnIndex !== turnIndex) {
    return;
  }

  await clearPendingAgentExecutionState(internals, workflowId, stepIndex);
}

function agentExecutionStateStorageKey(workflowId: string, stepIndex: number): string {
  const key = KEYS.agentExecutionState(workflowId, stepIndex);
  const parsedStepIndex = parseAgentExecutionStepIndex(key);
  if (
    !key.startsWith(agentExecutionStateStoragePrefix(workflowId)) ||
    parsedStepIndex !== stepIndex
  ) {
    throw new Error('Invalid agent execution state key factory output');
  }

  return key;
}

export async function loadPendingAgentExecutionState(
  internals: EngineInternals,
  workflowId: string,
  stepIndex: number,
): Promise<StoredPendingAgentExecutionState | undefined> {
  const bytes = await internals.storage.get(agentExecutionStateStorageKey(workflowId, stepIndex));
  if (!bytes) {
    return undefined;
  }

  const decoded = decode(bytes);
  if (!isStoredPendingAgentExecutionState(decoded)) {
    return undefined;
  }

  return decoded;
}

export async function storePendingAgentExecutionState(
  internals: EngineInternals,
  workflowId: string,
  stepIndex: number,
  state: StoredPendingAgentExecutionState,
  callbacks: AgentSuspensionCallbacks,
): Promise<void> {
  const operations: BatchOperation[] = [
    {
      type: 'put',
      key: agentExecutionStateStorageKey(workflowId, stepIndex),
      value: encode(state),
    },
  ];

  if (!state.pendingResume.resumed) {
    operations.push(
      ...(await collectBufferedSignalMirrorOperations(
        internals,
        workflowId,
        state.pendingResume.hint.resumeToken,
        createAgentResumeSignalName(stepIndex, state.pendingResume.hint.resumeToken),
        callbacks,
      )),
    );
  }

  await internals.storage.batch(operations);
}

export async function clearPendingAgentExecutionState(
  internals: EngineInternals,
  workflowId: string,
  stepIndex: number,
): Promise<void> {
  const operations: BatchOperation[] = [
    { type: 'delete', key: agentExecutionStateStorageKey(workflowId, stepIndex) },
  ];
  const existingState = await loadPendingAgentExecutionState(internals, workflowId, stepIndex);
  if (existingState) {
    operations.push(
      ...(await collectBufferedSignalDeleteOperations(
        internals,
        workflowId,
        createAgentResumeSignalName(stepIndex, existingState.pendingResume.hint.resumeToken),
      )),
    );
  }

  await internals.storage.batch(operations);
}

export async function markPendingAgentResumeStateResumed(
  internals: EngineInternals,
  workflowId: string,
  stepIndex: number,
  turnIndex: number,
  payload: unknown,
  callbacks: AgentSuspensionCallbacks,
): Promise<void> {
  const executionState = await loadPendingAgentExecutionState(internals, workflowId, stepIndex);
  if (!executionState || executionState.pendingResume.turnIndex !== turnIndex) {
    return;
  }

  await storePendingAgentExecutionState(
    internals,
    workflowId,
    stepIndex,
    {
      ...executionState,
      pendingResume: {
        ...executionState.pendingResume,
        resumed: true,
        payload,
      },
    },
    callbacks,
  );
}
