/**
 * Defensive recursive POJO clone used by the workflow builder and the engine's
 * per-workflow `ActivityRegistry` construction.
 *
 * `structuredClone` rejects function values, which we deliberately carry on
 * activity option subtrees (`execute`, `compensate`, `verify`) and on the
 * builder's frozen activity/signal/update/query maps. This helper preserves
 * function references verbatim and recursively clones plain objects and
 * arrays. Class instances pass through by reference; the outer container is
 * always frozen by the calling code, so reassignment cannot reach the stored
 * copy.
 *
 * Both `WorkflowBuilderImpl.execute()` and `engine.register(builderWorkflow)`
 * call this so the engine's stored copies cannot be mutated through references
 * the user retains.
 */
export function clonePlain<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    const cloned: unknown[] = value.map((item: unknown) => clonePlain(item));
    return cloned as T;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    // Class instance: pass through by reference. The outer container that
    // holds it is frozen, preventing reassignment.
    return value;
  }
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>)) {
    out[key] = clonePlain((value as Record<string, unknown>)[key]);
  }
  return out as T;
}
