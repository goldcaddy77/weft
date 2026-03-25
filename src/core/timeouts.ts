/**
 * Workflow-level execution timeouts with durable deadline storage.
 *
 * Deadlines are stored as lexicographically sortable keys so that
 * a single prefix scan can discover all expired workflows.
 *
 * @module timeouts
 */

import type { BatchOperation, Storage } from '../storage/interface';
import { KEYS } from '../storage/interface';
import { decode, encode } from './codec';
import { parseDuration } from './scheduler';
import type { Duration, WorkflowId } from './types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ExpiredDeadline {
  workflowId: string;
  deadline: number;
}

// ---------------------------------------------------------------------------
// Deadline batch operations
// ---------------------------------------------------------------------------

/** Create batch operations for storing an execution deadline. */
export function createDeadlineOperations(
  workflowId: WorkflowId,
  startedAt: number,
  executionTimeout: Duration,
): BatchOperation[] {
  const timeoutMilliseconds = parseDuration(executionTimeout);
  const deadline = startedAt + timeoutMilliseconds;
  const key = KEYS.deadline(deadline, workflowId);

  return [{ type: 'put', key, value: encode({ workflowId, deadline }) }];
}

/** Create batch operations to clean up deadline entries for a workflow. */
export function cleanupDeadlineOperations(
  workflowId: WorkflowId,
  deadline: number,
): BatchOperation[] {
  const key = KEYS.deadline(deadline, workflowId);
  return [{ type: 'delete', key }];
}

// ---------------------------------------------------------------------------
// Deadline scanning
// ---------------------------------------------------------------------------

/** Scan storage for expired deadlines. Returns workflow IDs that have timed out. */
export async function checkExpiredDeadlines(
  storage: Storage,
  now: number,
): Promise<ExpiredDeadline[]> {
  const upperBound = KEYS.deadline(now, '\xff');
  const expired: ExpiredDeadline[] = [];

  for await (const [, value] of storage.scan('wf-deadline:', { lte: upperBound })) {
    const entry = decode(value) as { workflowId: string; deadline: number };
    expired.push({ workflowId: entry.workflowId, deadline: entry.deadline });
  }

  return expired;
}

// ---------------------------------------------------------------------------
// Time remaining
// ---------------------------------------------------------------------------

/** Calculate remaining time before deadline. Returns Infinity if no deadline. */
export function timeRemaining(deadline: number | undefined, now: number): number {
  if (deadline === undefined) return Infinity;
  return deadline - now;
}

// ---------------------------------------------------------------------------
// Timeout error
// ---------------------------------------------------------------------------

export class WorkflowTimeoutError extends Error {
  readonly workflowId: string;
  readonly timeoutType: 'execution' | 'run';
  readonly elapsed: number;

  constructor(workflowId: string, timeoutType: 'execution' | 'run', elapsed: number) {
    super(`Workflow "${workflowId}" exceeded ${timeoutType} timeout after ${elapsed}ms`);
    this.name = 'WorkflowTimeoutError';
    this.workflowId = workflowId;
    this.timeoutType = timeoutType;
    this.elapsed = elapsed;
  }
}
