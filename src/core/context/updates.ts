import { isAsyncGeneratorFunction, isGeneratorFunction } from '../step-context.ts';
import type { ContextInternals } from './internals.ts';

export function onUpdate(
  internals: ContextInternals,
  name: string,
  handler: (payload: unknown) => unknown,
): void {
  if (isGeneratorFunction(handler) || isAsyncGeneratorFunction(handler)) {
    throw new TypeError(
      `Update handler "${name}" cannot be a generator function. ` +
        `Use a plain function — update handlers run synchronously at checkpoint boundaries and cannot yield.`,
    );
  }
  internals.updateHandlers ??= new Map();
  internals.updateHandlers.set(name, handler);
}

export function expose(
  internals: ContextInternals,
  accessors: Record<string, () => unknown>,
): void {
  internals.exposedValues ??= new Map();
  for (const [key, accessor] of Object.entries(accessors)) {
    internals.exposedValues.set(key, accessor);
  }
}
