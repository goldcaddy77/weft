import type { EngineInternals } from './internals.ts';

/** Resolve a workflow query from built-in progress state or exposed inline accessors. */
export async function query(
  internals: EngineInternals,
  workflowId: string,
  name: string,
  input?: unknown,
): Promise<unknown> {
  // Built-in query: return latest heartbeat details for this workflow
  if (name === 'activityProgress') {
    return internals.heartbeatDetails.get(workflowId);
  }

  const inlineStrategy = internals.inlineStrategy;
  if (!inlineStrategy) {
    throw new Error('Workflow queries are not supported when using the worker execution strategy.');
  }
  const context = inlineStrategy.getContext(workflowId);
  if (!context) {
    return undefined;
  }
  const queryHandler = context.queryHandlers.get(name);
  if (queryHandler) return queryHandler(input);
  const accessor = context.exposedAccessors.get(name);
  if (!accessor) return undefined;
  return accessor();
}
