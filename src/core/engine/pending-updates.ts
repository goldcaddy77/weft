import { UpdateCompletedEvent, UpdateReceivedEvent } from '../events.ts';
import type { EngineInternals } from './internals.ts';
import { invokeUpdateHandler as invokeUpdateHandlerFromInternals } from './updates.ts';

type PendingUpdateCallbacks = {
  dispatchEvent: (event: Event) => boolean;
  broadcast: (message: { type: 'update:completed'; workflowId: string; updateId: string }) => void;
};

export async function invokeUpdateHandler(
  internals: EngineInternals,
  name: string,
  handler: (payload: unknown) => unknown,
  payload: unknown,
): Promise<unknown> {
  return invokeUpdateHandlerFromInternals(internals, name, handler, payload);
}

export async function processPendingUpdatesForHandlers(
  internals: EngineInternals,
  workflowId: string,
  callbacks: PendingUpdateCallbacks,
): Promise<void> {
  const context = internals.inlineStrategy?.getContext(workflowId);
  if (!context) return;

  const handlers = context.updateHandlers;
  if (handlers.size === 0) return;

  const pendingUpdates = await internals.updateCoordinator.getPendingUpdates(workflowId);
  if (pendingUpdates.length === 0) return;

  for (const update of pendingUpdates) {
    const handler = handlers.get(update.name);
    if (!handler) continue;

    callbacks.dispatchEvent(
      new UpdateReceivedEvent(update.updateId, workflowId, update.name, update.payload),
    );

    let result: unknown;
    let error: string | undefined;
    try {
      result = await invokeUpdateHandler(internals, update.name, handler, update.payload);
    } catch (handlerError) {
      error = handlerError instanceof Error ? handlerError.message : String(handlerError);
    }

    const responseOperations = internals.updateCoordinator.buildResponseOperations(
      update.updateId,
      workflowId,
      result,
      error,
      update.idempotencyKey,
    );
    await internals.storage.batch(responseOperations);

    callbacks.dispatchEvent(
      new UpdateCompletedEvent(update.updateId, workflowId, update.name, result, error),
    );
    callbacks.broadcast({ type: 'update:completed', workflowId, updateId: update.updateId });
  }
}
