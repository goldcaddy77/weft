import { KEYS, encodeStorageKeyComponent } from '../../storage/interface.ts';
import type { EngineInternals } from './internals.ts';

function createAgentResumeSignalName(stepIndex: number, resumeToken: string): string {
  return `agent-resume:${String(stepIndex).padStart(10, '0')}:${resumeToken}`;
}

function signalStoragePrefix(workflowId: string, signalName: string): string {
  return `sig:${encodeStorageKeyComponent(workflowId)}:${signalName}:`;
}

/**
 * Repair a public resume-token signal that arrived after pending-state signal
 * mirroring scanned storage but before the pending state batch committed.
 */
export async function repairMissingSignalMirrorIfNeeded(
  internals: EngineInternals,
  workflowId: string,
  stepIndex: number,
  resumeToken: string,
): Promise<void> {
  const internalSignalName = createAgentResumeSignalName(stepIndex, resumeToken);
  const internalSignalPrefix = signalStoragePrefix(workflowId, internalSignalName);
  for await (const _entry of internals.storage.scan(internalSignalPrefix, { limit: 1 })) {
    return;
  }

  const publicSignalPrefix = signalStoragePrefix(workflowId, resumeToken);
  for await (const [, value] of internals.storage.scan(publicSignalPrefix, { limit: 1 })) {
    await internals.storage.put(
      KEYS.signal(workflowId, internalSignalName, crypto.randomUUID()),
      new Uint8Array(value),
    );
    return;
  }
}
