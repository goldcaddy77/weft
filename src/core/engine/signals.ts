import type { BatchOperation } from '../../storage/interface.ts';
import { KEYS, encodeStorageKeyComponent } from '../../storage/interface.ts';
import { decode, encode } from '../codec.ts';
import { SignalReceivedEvent } from '../events.ts';
import type { ComposedWorkflowInterceptor } from '../interceptor.ts';
import { assertPayloadWithinLimit } from '../payload-size.ts';
import type { WorkflowState } from '../types.ts';
import type { EngineInternals } from './internals.ts';
import { isTerminalWorkflowStatus } from './validation.ts';

type TrackedWaiterKeys = string | Set<string>;

export type SignalCallbacks = {
  loadWorkflowState: (workflowId: string) => Promise<WorkflowState | null | undefined>;
  dispatchEvent: (event: Event) => boolean;
  broadcast: (message: { type: 'signal:received'; workflowId: string; signalName: string }) => void;
  getComposedInterceptor: () => ComposedWorkflowInterceptor | null | undefined;
  resumeParkedInlineWorkflow: (workflowId: string) => Promise<void>;
};

export type BufferedSignalOptions = {
  emitPublicEvent?: boolean;
};

export type BufferedSignalDelivery = {
  signalName: string;
  payload: unknown;
  options?: BufferedSignalOptions;
};

export type ConsumedSignalResult =
  | { found: false }
  | {
      found: true;
      payload: unknown;
    };

const EMPTY_STORAGE_VALUE = new Uint8Array(0);

export async function signal(
  internals: EngineInternals,
  workflowId: string,
  name: string,
  payload: unknown,
  callbacks: SignalCallbacks,
): Promise<void> {
  const deliverSignal = async (
    targetWorkflowId: string,
    signalName: string,
    signalPayload: unknown,
  ): Promise<void> => {
    await bufferSignalPayloads(
      internals,
      targetWorkflowId,
      [{ signalName, payload: signalPayload }],
      callbacks,
    );
  };

  // Run signalReceived interceptor hook wrapping actual delivery
  const composed = callbacks.getComposedInterceptor();
  if (composed) {
    let deliveryPromise: Promise<void> | undefined;
    let nextCalled = false;
    try {
      composed.signalReceived(
        {
          workflowId,
          signalName: name,
          payload: payload,
          headers: new Map<string, string>(),
        },
        (interception) => {
          if (nextCalled) {
            throw new Error('signalReceived interceptor called next() more than once');
          }
          nextCalled = true;
          deliveryPromise = deliverSignal(
            interception.workflowId,
            interception.signalName,
            interception.payload,
          );
        },
      );
    } catch (error) {
      // Always await the delivery promise even if the interceptor threw after
      // calling next, to avoid orphaned unhandled promise rejections.
      if (deliveryPromise) await deliveryPromise;
      throw error;
    }
    // If interceptor blocked delivery by not calling next, return early
    if (!deliveryPromise) return;
    await deliveryPromise;
  } else {
    await deliverSignal(workflowId, name, payload);
  }
}

export function releaseSignalWaiter(
  internals: EngineInternals,
  workflowId: string,
  waiterKey: string,
  expectedResolve?: () => void,
): void {
  const currentWaiter = internals.signalWaiters.get(waiterKey);
  if (!currentWaiter) {
    return;
  }

  if (expectedResolve && currentWaiter !== expectedResolve) {
    return;
  }

  internals.signalWaiters.delete(waiterKey);
  untrackWaiterKey(internals.signalWaitersByWorkflow, workflowId, waiterKey);
}

export async function bufferSignalPayloads(
  internals: EngineInternals,
  workflowId: string,
  deliveries: BufferedSignalDelivery[],
  callbacks: SignalCallbacks,
): Promise<void> {
  if (deliveries.length === 0) {
    return;
  }

  const targetState = await callbacks.loadWorkflowState(workflowId);
  if (targetState && isTerminalWorkflowStatus(targetState.status)) {
    return;
  }

  // Reject before building any batch operation so one oversize payload aborts
  // the whole buffer with nothing written.
  for (const { payload } of deliveries) {
    assertPayloadWithinLimit(
      payload,
      internals.options.payloadSizePolicy.maxBytes,
      'signal payload',
    );
  }

  const operations: BatchOperation[] = deliveries.map(({ signalName, payload }) => ({
    type: 'put',
    key: KEYS.signal(workflowId, signalName, crypto.randomUUID()),
    value: encode(payload),
  }));
  if (!internals.workflowsNeedingTerminalCleanup.has(workflowId)) {
    internals.workflowsNeedingTerminalCleanup.add(workflowId);
    operations.push({
      type: 'put',
      key: KEYS.terminalCleanupNeeded(workflowId),
      value: EMPTY_STORAGE_VALUE,
    });
  }

  await internals.storage.batch(operations);
  deliverBufferedSignals(internals, workflowId, deliveries, callbacks);
}

function deliverBufferedSignals(
  internals: EngineInternals,
  workflowId: string,
  deliveries: BufferedSignalDelivery[],
  callbacks: SignalCallbacks,
): void {
  let shouldResumeParkedWorkflow = false;

  for (const { signalName, payload, options } of deliveries) {
    if (options?.emitPublicEvent !== false) {
      callbacks.dispatchEvent(new SignalReceivedEvent(workflowId, signalName, payload));
      callbacks.broadcast({ type: 'signal:received', workflowId, signalName });
    }

    const waiterKey = `${workflowId}:${signalName}`;
    const waiter = internals.signalWaiters.get(waiterKey);
    if (waiter) {
      releaseSignalWaiter(internals, workflowId, waiterKey, waiter);
      waiter();
      continue;
    }

    if (internals.parkedInlineWorkflows.has(workflowId)) {
      shouldResumeParkedWorkflow = true;
    }
  }

  if (shouldResumeParkedWorkflow) {
    void callbacks.resumeParkedInlineWorkflow(workflowId);
  }
}

export async function hasBufferedSignal(
  internals: EngineInternals,
  workflowId: string,
  signalName: string,
): Promise<boolean> {
  const prefix = `sig:${encodeStorageKeyComponent(workflowId)}:${signalName}:`;
  for await (const _entry of internals.storage.scan(prefix, { limit: 1 })) {
    return true;
  }

  return false;
}

export async function consumeSignal(
  internals: EngineInternals,
  workflowId: string,
  signalName: string,
): Promise<ConsumedSignalResult> {
  const prefix = `sig:${encodeStorageKeyComponent(workflowId)}:${signalName}:`;
  for await (const [key, value] of internals.storage.scan(prefix, { limit: 1 })) {
    await internals.storage.delete(key);
    return { found: true, payload: decode(value) };
  }
  return { found: false };
}

/** Register a waiter key in a workflow-keyed reverse index. */
export function trackWaiterKey(
  reverseIndex: Map<string, TrackedWaiterKeys>,
  workflowId: string,
  waiterKey: string,
): void {
  let keys = reverseIndex.get(workflowId);
  if (!keys) {
    reverseIndex.set(workflowId, waiterKey);
    return;
  }

  if (typeof keys === 'string') {
    if (keys === waiterKey) {
      return;
    }

    reverseIndex.set(workflowId, new Set([keys, waiterKey]));
    return;
  }

  keys.add(waiterKey);
}

/** Remove a waiter key from a workflow-keyed reverse index. */
export function untrackWaiterKey(
  reverseIndex: Map<string, TrackedWaiterKeys>,
  workflowId: string,
  waiterKey: string,
): void {
  const keys = reverseIndex.get(workflowId);
  if (!keys) {
    return;
  }

  if (typeof keys === 'string') {
    if (keys === waiterKey) {
      reverseIndex.delete(workflowId);
    }
    return;
  }

  keys.delete(waiterKey);
  if (keys.size === 0) {
    reverseIndex.delete(workflowId);
    return;
  }

  if (keys.size === 1) {
    const [remainingWaiterKey] = keys;
    if (remainingWaiterKey !== undefined) {
      reverseIndex.set(workflowId, remainingWaiterKey);
    }
  }
}
