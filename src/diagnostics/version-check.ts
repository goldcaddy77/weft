/**
 * Version compatibility check for running workflows against registered versions.
 *
 * Scans storage for active (running/pending) workflows, groups by type,
 * and compares stored versions with currently registered versions to
 * determine deployment safety.
 *
 * @module diagnostics/version-check
 */

import { decode } from '../core/codec.ts';
import type { WorkflowRegistration, WorkflowState } from '../core/types.ts';
import { DEFAULT_WORKFLOW_VERSION, checkVersionCompatibility } from '../core/versioning.ts';
import type { Storage } from '../storage/interface.ts';
import type { VersionCheckReport, WorkflowTypeReport } from './types.ts';

interface WorkflowTypeGroup {
  count: number;
  versionCounts: Map<string, number>;
}

export async function runVersionCheck(
  storage: Storage,
  registrations: Record<string, WorkflowRegistration>,
): Promise<VersionCheckReport> {
  // 1. Scan all wf: keys, skip checkpoint keys
  const groups = new Map<string, WorkflowTypeGroup>();

  for await (const [key, bytes] of storage.scan('wf:')) {
    // Skip checkpoint keys (contain :ckpt)
    if (key.includes(':ckpt')) continue;

    const state = decode(bytes) as WorkflowState;

    // 2. Filter to only running or pending workflows
    if (state.status !== 'running' && state.status !== 'pending') continue;

    // 3. Group by type and track version counts
    let group = groups.get(state.type);
    if (!group) {
      group = { count: 0, versionCounts: new Map() };
      groups.set(state.type, group);
    }
    group.count++;
    group.versionCounts.set(state.version, (group.versionCounts.get(state.version) ?? 0) + 1);
  }

  // 4. Build WorkflowTypeReport for each type
  const workflowTypes: WorkflowTypeReport[] = [];

  for (const [type, group] of groups) {
    const registration = registrations[type];

    // Skip unregistered types
    if (!registration) continue;

    // Find the most common stored version
    let storedVersion = '';
    let maxCount = 0;
    for (const [version, count] of group.versionCounts) {
      if (count > maxCount) {
        maxCount = count;
        storedVersion = version;
      }
    }

    const registeredVersion = registration.version ?? DEFAULT_WORKFLOW_VERSION;
    const hasMigration = !!registration.migrate;
    const compatibility = checkVersionCompatibility(storedVersion, registeredVersion, hasMigration);

    workflowTypes.push({
      type,
      storedVersion,
      registeredVersion,
      runningCount: group.count,
      compatibility,
      hasMigration,
    });
  }

  // 5. Compute overall verdict
  let overallVerdict: VersionCheckReport['overallVerdict'] = 'safe';

  for (const typeReport of workflowTypes) {
    if (typeReport.compatibility === 'incompatible') {
      // Versions differ but no migration — unsafe
      overallVerdict = 'unsafe';
      break;
    }
    if (typeReport.compatibility === 'needs-migration') {
      overallVerdict = 'needs-migration';
    }
  }

  return { workflowTypes, overallVerdict };
}
