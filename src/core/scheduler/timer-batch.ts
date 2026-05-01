import type { BatchOperation } from '../../storage/interface.ts';
import { KEYS } from '../../storage/interface.ts';
import { encode } from '../codec.ts';
import type { TimerEntry } from '../types.ts';
import { normalizeStorageTimestamp } from './duration.ts';

function isTimerEntryKind(value: unknown): value is TimerEntry['kind'] {
  return (
    value === 'sleep' ||
    value === 'visibility-timeout' ||
    value === 'execution-deadline' ||
    value === 'delayed-start' ||
    value === 'schedule' ||
    value === 'terminal-cleanup'
  );
}

/** Runtime type guard for decoded timer entries. */
// oxlint-disable-next-line complexity -- ID:core-scheduler-is-timer-entry-complexity
export function isTimerEntry(value: unknown): value is TimerEntry {
  return (
    typeof value === 'object' &&
    value !== null &&
    'id' in value &&
    typeof value.id === 'string' &&
    'workflowId' in value &&
    typeof value.workflowId === 'string' &&
    'fireAt' in value &&
    typeof value.fireAt === 'number' &&
    Number.isFinite(value.fireAt) &&
    'kind' in value &&
    isTimerEntryKind(value.kind)
  );
}

/**
 * Build the batch operations needed to persist a durable timer entry.
 * Shared between `Scheduler.schedule()` and `Engine.#buildStartBatchOperations()`
 * so the key format stays in one place.
 */
export function buildTimerBatchOperations(entry: TimerEntry): BatchOperation[] {
  const normalizedEntry: TimerEntry = {
    ...entry,
    fireAt: normalizeStorageTimestamp(entry.fireAt, 'Timer fireAt'),
  };
  if (normalizedEntry.kind === 'terminal-cleanup') {
    return [
      {
        type: 'put',
        key: KEYS.terminalCleanup(normalizedEntry.fireAt, normalizedEntry.id),
        value: encode(normalizedEntry.workflowId),
      },
    ];
  }

  const deadlineKey =
    normalizedEntry.kind === 'delayed-start'
      ? KEYS.delayedStart(normalizedEntry.fireAt, normalizedEntry.workflowId)
      : normalizedEntry.kind === 'schedule'
        ? KEYS.scheduleTick(normalizedEntry.fireAt, normalizedEntry.workflowId)
        : KEYS.deadline(normalizedEntry.fireAt, normalizedEntry.id);
  const operations: BatchOperation[] = [
    { type: 'put', key: deadlineKey, value: encode(normalizedEntry) },
  ];
  operations.push({
    type: 'put',
    key: `timer-idx:${normalizedEntry.id}`,
    value: encode(deadlineKey),
  });

  return operations;
}
