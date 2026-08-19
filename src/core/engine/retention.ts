import type { RetentionOverview, WorkflowTypeRetentionPolicy } from '../types.ts';
import { purgeInternal } from './bulk-operations.ts';
import type { EngineInternals } from './internals.ts';

type CleanupWaiters = (workflowId: string) => void;
type RetentionSweepCallbacks = {
  hasConfiguredRetention: () => boolean;
  runRetentionSweep: () => Promise<void>;
  setNextRetentionSweepAt: () => void;
};

export function hasConfiguredRetention(internals: EngineInternals): boolean {
  if (internals.options.retention !== null) {
    return true;
  }

  for (const registration of internals.registrations.values()) {
    if (registration.retention !== undefined && registration.retention !== null) {
      return true;
    }
  }

  return false;
}

export function setNextRetentionSweepAt(internals: EngineInternals): void {
  internals.nextRetentionSweepAt =
    internals.options.getNow() + internals.options.retentionSweepIntervalMs;
}

export function ensureRetentionSweepInterval(
  internals: EngineInternals,
  callbacks: RetentionSweepCallbacks,
): void {
  if (internals.options.backgroundTaskMode === 'manual') {
    internals.nextRetentionSweepAt = null;
    return;
  }
  if (!callbacks.hasConfiguredRetention()) {
    if (internals.retentionSweepInterval !== null) {
      clearInterval(internals.retentionSweepInterval ?? undefined);
      internals.retentionSweepInterval = null;
    }
    internals.nextRetentionSweepAt = null;
    return;
  }

  if (internals.retentionSweepInterval !== null) {
    return;
  }

  callbacks.setNextRetentionSweepAt();
  internals.retentionSweepInterval = setInterval(() => {
    callbacks.setNextRetentionSweepAt();
    if (internals.retentionSweepInFlight !== null) {
      return;
    }

    const sweepPromise = callbacks.runRetentionSweep();
    const settledSweepPromise = sweepPromise.finally(() => {
      if (internals.retentionSweepInFlight === settledSweepPromise) {
        internals.retentionSweepInFlight = null;
      }
    });
    internals.retentionSweepInFlight = settledSweepPromise;
  }, internals.options.retentionSweepIntervalMs);
}

export async function runRetentionSweep(
  internals: EngineInternals,
  handleCleanupError: (source: string, error: unknown) => void,
  cleanupWaiters: CleanupWaiters,
): Promise<void> {
  try {
    await purgeInternal(
      internals,
      undefined,
      {
        expiredOnly: true,
        limit: internals.options.retentionSweepBatchSize,
        now: internals.options.getNow(),
        // Per-run isolation: a single workflow that fails to purge no longer
        // aborts the sweep (the batch-cap defect had the oldest oversized run
        // throw and strand every run behind it). Route each per-run failure into
        // the same cleanup-error path a whole-sweep failure would use, so the
        // failure is still surfaced rather than swallowed. A deposition still
        // re-throws from purgeInternal and lands in the catch below.
        onWorkflowPurgeError: (workflowId, error) =>
          handleCleanupError(`retentionSweep(${workflowId})`, error),
      },
      cleanupWaiters,
    );
  } catch (error) {
    handleCleanupError('retentionSweep', error);
  }
}

export function resolveWorkflowTypeRetention(
  internals: EngineInternals,
  type: string,
): WorkflowTypeRetentionPolicy {
  const registration = internals.registrations.get(type);
  if (registration?.retention) {
    return {
      type,
      source: 'workflow',
      retention: registration.retention,
    };
  }

  if (internals.options.retention !== null) {
    return {
      type,
      source: 'engine',
      retention: internals.options.retention,
    };
  }

  return {
    type,
    source: 'none',
    retention: null,
  };
}

export function getRetentionOverview(
  internals: EngineInternals,
  resolveRetentionForType: (type: string) => WorkflowTypeRetentionPolicy = (type) =>
    resolveWorkflowTypeRetention(internals, type),
): RetentionOverview {
  const workflowTypes = [...internals.registrations.keys()]
    .toSorted()
    .map((type) => resolveRetentionForType(type));

  return {
    defaultRetention: internals.options.retention,
    sweepIntervalMs: internals.options.retentionSweepIntervalMs,
    sweepBatchSize: internals.options.retentionSweepBatchSize,
    nextSweepAt: internals.nextRetentionSweepAt,
    workflowTypes,
  };
}
