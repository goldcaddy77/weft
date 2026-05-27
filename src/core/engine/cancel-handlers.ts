import type { EngineInternals } from './internals.ts';

export type CancelHandler = () => Promise<void> | void;

export function registerCancelHandler(
  internals: EngineInternals,
  workflowId: string,
  handler: CancelHandler,
): void {
  internals.cancelHandlersByWorkflow ??= new Map();
  let handlers = internals.cancelHandlersByWorkflow.get(workflowId);
  if (handlers === undefined) {
    handlers = [];
    internals.cancelHandlersByWorkflow.set(workflowId, handlers);
  }
  handlers.push(handler);
}

export function createCancelHandlerRegistration(
  internals: EngineInternals,
  workflowId: string,
): (handler: CancelHandler) => void {
  return (handler) => registerCancelHandler(internals, workflowId, handler);
}

export function resetCancelHandlers(internals: EngineInternals, workflowId: string): void {
  internals.cancelHandlersByWorkflow ??= new Map();
  internals.cancelHandlersByWorkflow.delete(workflowId);
}

export function takeCancelHandlers(
  internals: EngineInternals,
  workflowId: string,
): CancelHandler[] {
  internals.cancelHandlersByWorkflow ??= new Map();
  const handlers = internals.cancelHandlersByWorkflow.get(workflowId) ?? [];
  internals.cancelHandlersByWorkflow.delete(workflowId);
  return handlers;
}
