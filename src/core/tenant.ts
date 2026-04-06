/**
 * Multi-tenant context primitives.
 *
 * A workflow engine that serves more than one customer eventually needs to
 * branch behavior — different tools per tenant, different validation rules,
 * different quotas. The built-in options were: (1) read the tenant from the
 * workflow input every time, or (2) smuggle it through task queue names.
 * Both leak tenancy concerns into every call site.
 *
 * This module provides a first-class tenant slot:
 *
 * 1. Configure `tenantResolver` on the {@link Engine} once.
 * 2. On every `engine.start()`, the resolver receives the workflow id and
 *    input and returns a {@link TenantContext} (or `undefined` to run
 *    without one).
 * 3. The tenant is stored on the workflow state so it survives recovery, and
 *    surfaced to workflow code as `ctx.tenant`.
 * 4. Agents declared with {@link defineAgent} can opt in to per-tenant tool
 *    sets and input validation via `toolsForTenant` and `validateInput`.
 *
 * @module core/tenant
 */

/**
 * Opaque identifier plus free-form attributes describing which tenant is
 * running a given workflow. The attributes are free-form so callers can
 * encode things like plan tier, data residency region, feature flags, etc.
 */
export interface TenantContext {
  /** Stable identifier for the tenant. */
  readonly id: string;
  /** Free-form attributes — tier, region, feature flags, etc. */
  readonly attributes?: Readonly<Record<string, unknown>>;
}

/**
 * Resolves the {@link TenantContext} for a newly starting workflow.
 *
 * The resolver is invoked exactly once per `engine.start()` call, before the
 * initial checkpoint is written. Returning `undefined` means "this workflow
 * runs without a tenant" — useful for system workflows that belong to the
 * platform itself rather than any customer.
 *
 * Resolvers may return synchronously or asynchronously; slow resolvers delay
 * workflow start, so prefer O(1) lookups (e.g. parsing the input, hitting a
 * local cache) over network calls.
 */
export interface TenantResolver {
  resolve(
    workflowId: string,
    input: unknown,
    workflowType: string,
  ): TenantContext | undefined | Promise<TenantContext | undefined>;
}

/**
 * Type guard for plain-object tenant contexts. Used by the engine when
 * deserializing persisted workflow state so a malformed blob cannot corrupt
 * `ctx.tenant`.
 */
export function isTenantContext(value: unknown): value is TenantContext {
  if (value === null || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate['id'] !== 'string') return false;
  if (candidate['attributes'] !== undefined) {
    if (typeof candidate['attributes'] !== 'object' || candidate['attributes'] === null) {
      return false;
    }
  }
  return true;
}

/**
 * Build a resolver that reads the tenant id from a specific field on the
 * workflow input. Convenience helper for the common case where every
 * workflow input carries a `tenantId` (or similar) property.
 *
 * @example
 * ```ts
 * const engine = new Engine({
 *   storage,
 *   tenantResolver: tenantFromInputField('tenantId'),
 * });
 * ```
 */
export function tenantFromInputField(field: string): TenantResolver {
  return {
    resolve(_workflowId, input) {
      if (input === null || typeof input !== 'object') return undefined;
      const value = (input as Record<string, unknown>)[field];
      if (typeof value !== 'string' || value.length === 0) return undefined;
      return { id: value };
    },
  };
}
