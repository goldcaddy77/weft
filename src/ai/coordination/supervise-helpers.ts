import type { AgentResult } from '../agent/types.ts';
import { confidenceWeightedConsensus } from '../confidence-voting.ts';
import type { AgentDefinition } from '../declaration.ts';

/**
 * Resolve the effective worker list from a `SuperviseOptions.n` override.
 * - When `n` is a number: trim or round-robin-replicate `workers` to that length.
 * - When `n` is a function: call it with `input` to obtain the count.
 * - Clamped to a minimum of 1.
 */
export function resolveWorkers(
  workers: AgentDefinition[],
  n: number | ((input: string) => number) | undefined,
  input: string,
): AgentDefinition[] {
  if (workers.length === 0) throw new Error('supervise requires at least one worker agent');
  if (n === undefined) return workers;

  const requestedCount = typeof n === 'function' ? n(input) : n;
  const effectiveCount = Number.isFinite(requestedCount)
    ? Math.max(1, Math.floor(requestedCount))
    : 1;
  if (effectiveCount <= workers.length) {
    return workers.slice(0, effectiveCount);
  }
  // Round-robin replicate to fill up to effectiveCount.
  const expanded: AgentDefinition[] = [];
  for (let index = 0; index < effectiveCount; index++) {
    expanded.push(workers[index % workers.length]!);
  }
  return expanded;
}

/**
 * Format worker results as a numbered summary string for supervisor prompts.
 *
 * @example "Worker 1: alpha\n\nWorker 2: beta"
 */
export function formatWorkerSummary(results: AgentResult[]): string {
  return results.map((result, index) => `Worker ${index + 1}: ${result.content}`).join('\n\n');
}

/**
 * Determine the consensus winner for the `consensus` strategy.
 * Returns `null` when workers disagree (or there is a confidence tie),
 * signalling that the supervisor should be invoked.
 */
export function resolveConsensusWinner(
  results: AgentResult[],
  voting: 'naive' | 'confidence-weighted' | undefined,
): string | null {
  if (voting === 'confidence-weighted') {
    return confidenceWeightedConsensus(results).winner;
  }
  // Naive default: unanimous exact-string agreement required.
  const allAgree = results.every((r) => r.content === results[0]!.content);
  return allAgree ? (results[0]?.content ?? null) : null;
}
