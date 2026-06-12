import type { BatchOperation, ConditionalBatchCondition } from '../../storage/interface.ts';
import type { EngineInternals } from './internals.ts';
import type { SpeculativeExecutionState } from './speculative-execution-state.ts';

export type CheckpointCommitSideEffects = {
  conditions: ConditionalBatchCondition[];
  operations: BatchOperation[];
};

export type CheckpointCommitSideEffectInput = {
  conditions?: readonly ConditionalBatchCondition[];
  operations: readonly BatchOperation[];
};

export function appendCheckpointCommitSideEffects(
  internals: EngineInternals,
  workflowId: string,
  sideEffects: CheckpointCommitSideEffectInput,
  speculativeState?: SpeculativeExecutionState,
): void {
  const normalized = normalizeCheckpointCommitSideEffects(sideEffects);
  if (normalized.conditions.length === 0 && normalized.operations.length === 0) {
    return;
  }

  if (speculativeState !== undefined) {
    speculativeState.recordCheckpointCommitSideEffects(normalized);
    return;
  }

  appendDirectCheckpointCommitSideEffects(internals, workflowId, normalized);
}

export function appendDirectCheckpointCommitSideEffects(
  internals: EngineInternals,
  workflowId: string,
  sideEffects: CheckpointCommitSideEffects,
): void {
  const pending = internals.pendingCheckpointCommitSideEffects.get(workflowId);
  if (pending === undefined) {
    internals.pendingCheckpointCommitSideEffects.set(workflowId, {
      conditions: [...sideEffects.conditions],
      operations: [...sideEffects.operations],
    });
    return;
  }

  pending.conditions.push(...sideEffects.conditions);
  pending.operations.push(...sideEffects.operations);
}

export function appendPendingCheckpointCommitSideEffects(
  internals: EngineInternals,
  workflowId: string,
  commit: CheckpointCommitSideEffects,
): void {
  const pending = internals.pendingCheckpointCommitSideEffects.get(workflowId);
  if (pending === undefined) {
    return;
  }

  commit.conditions.push(...pending.conditions);
  commit.operations.push(...pending.operations);
}

export function clearPendingCheckpointCommitSideEffects(
  internals: EngineInternals,
  workflowId: string,
): void {
  internals.pendingCheckpointCommitSideEffects.delete(workflowId);
}

function normalizeCheckpointCommitSideEffects(
  sideEffects: CheckpointCommitSideEffectInput,
): CheckpointCommitSideEffects {
  return {
    conditions: [...(sideEffects.conditions ?? [])],
    operations: [...sideEffects.operations],
  };
}
