import { describe, expect, it } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const OPERATIONS_DIR = new URL('../operations/', import.meta.url).pathname;

// Files that are explicitly allow-listed for direct OperationFault throws
// (legacy patterns predating raiseFault).
const RAISE_FAULT_ALLOWLIST = new Set([
  'start-workflow.ts',
  'cancel-workflow.ts',
  'bulk-cancel-workflows.ts',
  'bulk-delete-workflows.ts',
  'bulk-mutate-workflow-tags.ts',
  'bulk-signal-workflows.ts',
  'fork-workflow.ts',
  'get-workflow.ts',
  'get-workflow-result.ts',
  'get-workflow-events.ts',
  'get-workflow-timeline.ts',
  'get-workflow-attributes.ts',
  'get-update-result.ts',
  'get-stream-chunks.ts',
  'get-review.ts',
  'get-checkpoint-at.ts',
  'get-budget-policy.ts',
  'get-system-metrics.ts',
  'get-tenant-quota.ts',
  'get-retention-overview.ts',
  'get-schedule.ts',
  'list-workflows.ts',
  'list-schedules.ts',
  'list-checkpoints.ts',
  'list-reviews.ts',
  'pause-schedule.ts',
  'resume-schedule.ts',
  'cancel-schedule.ts',
  'create-schedule.ts',
  'update-schedule.ts',
  'update-workflow.ts',
  'signal-workflow.ts',
  'resume-workflow.ts',
  'replay-workflow.ts',
  'timeout-workflow.ts',
  'submit-review-decision.ts',
  'set-budget-policy.ts',
  'set-workflow-attributes.ts',
  'add-workflow-tags.ts',
  'remove-workflow-tags.ts',
  'purge-workflows.ts',
  'recover-all.ts',
  'query-workflow.ts',
  'stream-workflow-sse.ts',
  'workflow-events-subscription.ts',
  'sse-stream.ts',
]);

// Shrink-ratchet upper bound. The allow-list represents legacy direct-throw
// patterns; this number must DECREASE as files migrate to raiseFault. Never
// raise it. If an honest migration shrinks the set below this number, lower
// the constant in the same commit. The bound is set to the current size so
// any new direct-throw operation file fails the ratchet immediately.
const RAISE_FAULT_ALLOWLIST_MAX_SIZE = 46;

describe('raiseFault canonical path', () => {
  it('all operations using direct throw patterns are tracked in the allow-list', () => {
    const files = readdirSync(OPERATIONS_DIR).filter(
      (file) => file.endsWith('.ts') && !file.endsWith('.test.ts'),
    );
    const violations: string[] = [];

    for (const file of files) {
      const content = readFileSync(join(OPERATIONS_DIR, file), 'utf-8');
      // Match `throw { ... code: '...' }` even when the literal spans
      // multiple lines (a property on a line below `throw {` on its own).
      const hasDirectThrow = /throw\s*\{[\s\S]{0,400}?code:\s*['"]/.test(content);
      if (hasDirectThrow && !RAISE_FAULT_ALLOWLIST.has(file)) {
        violations.push(file);
      }
    }

    expect(violations).toEqual([]);
  });

  it('allow-list size cannot grow beyond the declared shrink-ratchet bound', () => {
    expect(RAISE_FAULT_ALLOWLIST.size).toBeLessThanOrEqual(RAISE_FAULT_ALLOWLIST_MAX_SIZE);
  });
});
