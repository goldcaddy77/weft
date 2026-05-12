#!/usr/bin/env bun
/**
 * Verify that no `this.#fieldName` reference remains in `src/core/engine/`
 * for fields that were migrated to `EngineInternals`. Methods stay as
 * `#private` (`this.#methodName(...)`) so those are not flagged.
 *
 * Used by PR 8 (engine substrate) to prove the field migration is complete.
 *
 * The list of migrated field names is hard-coded below. As future engine PRs
 * (PRs 9–32) extract methods into sibling modules, the script's allowlist
 * stays the same — methods extracted to siblings still call `getInternals(...)`,
 * so no `this.#fieldName` references should exist for any of these names
 * anywhere under `src/core/engine/`.
 */

import { Glob, file } from 'bun';
import { join } from 'node:path';

const repoRoot = join(import.meta.dir, '..');

const MIGRATED_FIELDS = [
  'storage',
  'registrations',
  'workflowTypesByHandler',
  'abortController',
  'scheduler',
  'options',
  'strategy',
  'inlineStrategy',
  'handleCache',
  'finalizationRegistry',
  'resultResolvers',
  'signalWaiters',
  'signalWaitersByWorkflow',
  'updateWaiters',
  'updateWaitersByWorkflow',
  'sleepResolvers',
  'sleepResolversByWorkflow',
  'interceptors',
  'activityInterceptors',
  'composedWorkflowInterceptor',
  'composedActivityInterceptor',
  'updateCoordinator',
  'activityRegistry',
  'activityWorkerDispatcher',
  'checkpoints',
  'broadcastChannel',
  'pendingNestingDepth',
  'pendingParentHeaders',
  'workflowNestingDepths',
  'workflowHeaders',
  'workflowStateWriteChains',
  'budgetPolicyEnforcer',
  'tenantQuotaManager',
  'heartbeatDetails',
  'pendingStarts',
  'pendingScheduleCreations',
  'workflowsNeedingTerminalCleanup',
  'cleanupInterval',
  'retentionSweepInterval',
  'retentionSweepInFlight',
  'nextRetentionSweepAt',
  'reviewCoordinator',
  'reviewWaiters',
  'reviewWaitersByWorkflow',
  'reviewEscalationHandlers',
  'workflowReviewIds',
  'parkedInlineWorkflows',
  'terminalizingWorkflows',
  'reviewTimerIds',
  'pendingWebhooks',
  'alertManager',
  'eventLogHeads',
  'workflowFeedListeners',
  'workflowVersionTuples',
  'pendingTimelineEntries',
];

interface Violation {
  file: string;
  line: number;
  field: string;
  text: string;
}

const violations: Violation[] = [];
const glob = new Glob('src/core/engine/**/*.ts');

for await (const relPath of glob.scan({ cwd: repoRoot })) {
  if (relPath.endsWith('.test.ts') || relPath.endsWith('.spec.ts')) continue;
  const absPath = join(repoRoot, relPath);
  const source = await file(absPath).text();
  const lines = source.split('\n');

  for (const [index, lineText] of lines.entries()) {
    for (const fieldName of MIGRATED_FIELDS) {
      const regex = new RegExp(`this\\.#${fieldName}(?![a-zA-Z0-9_$])`, 'g');
      if (regex.test(lineText)) {
        violations.push({
          file: relPath,
          line: index + 1,
          field: fieldName,
          text: lineText.trim(),
        });
      }
    }
  }
}

if (violations.length > 0) {
  console.error('Found `this.#fieldName` references for migrated fields:');
  for (const v of violations) {
    console.error(
      `  ${v.file}:${v.line}  this.#${v.field}  →  should be getInternals(this).${v.field}`,
    );
    console.error(`    ${v.text}`);
  }
  console.error(
    '\nAll formerly-#private fields now live on EngineInternals. Replace `this.#field` with `getInternals(this).field`.',
  );
  process.exit(1);
}

console.log(`OK: no \`this.#fieldName\` references for ${MIGRATED_FIELDS.length} migrated fields.`);
