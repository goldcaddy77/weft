import type { WorkerOutboundMessage } from './types.ts';

export function emitWorkerMessageToEngine(
  handler: ((message: WorkerOutboundMessage) => void | Promise<void>) | null,
  message: WorkerOutboundMessage,
): boolean | Promise<boolean> {
  try {
    const emitResult = handler?.(message);
    if (emitResult instanceof Promise) {
      return emitResult.then(
        () => false,
        () => true,
      );
    }
    return false;
  } catch {
    return true;
  }
}

export function isParkableWaitSignalCheckpoint(
  message: Extract<WorkerOutboundMessage, { type: 'checkpoint' }>,
): boolean {
  const operationRequest = message.operationRequest as Record<string, unknown>;
  return operationRequest['type'] === 'wait-signal' || operationRequest['kind'] === 'signal-wait';
}
