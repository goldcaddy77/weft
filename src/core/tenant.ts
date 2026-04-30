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
 * `attributes` values must be structured-clone-safe — plain objects, arrays,
 * strings, numbers, booleans, and null. Functions, class instances, and DOM
 * nodes will crash worker dispatch with `DataCloneError`.
 *
 * @example
 * ```ts
 * import type { TenantContext } from 'weft';
 *
 * const tenant: TenantContext = {
 *   id: 'acme-corp',
 *   attributes: { tier: 'enterprise', region: 'us-east-1' },
 * };
 * console.log(tenant.id);               // 'acme-corp'
 * console.log(tenant.attributes?.['tier']); // 'enterprise'
 * ```
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
 * initial checkpoint is written. It receives the workflow ID, start input, and
 * workflow type string. Returning `undefined` means "this workflow runs without
 * a tenant" — useful for system workflows that belong to the platform itself
 * rather than any customer.
 *
 * Resolvers may return synchronously or asynchronously; slow resolvers delay
 * workflow start, so prefer O(1) lookups (e.g. parsing the input, hitting a
 * local cache) over network calls.
 *
 * @example
 * ```ts
 * import { Engine, type TenantResolver, type TenantContext } from 'weft';
 *
 * const resolver: TenantResolver = {
 *   resolve(_workflowId, input, _workflowType) {
 *     const record = input as Record<string, unknown>;
 *     const id = typeof record?.['tenantId'] === 'string' ? record['tenantId'] : undefined;
 *     return id ? { id } : undefined;
 *   },
 * };
 *
 * const engine = new Engine({ tenantResolver: resolver });
 * void engine;
 * ```
 */
export interface TenantResolver {
  resolve(
    workflowId: string,
    input: unknown,
    workflowType: string,
  ): TenantContext | undefined | Promise<TenantContext | undefined>;
}

/**
 * Build a resolver that reads the tenant id from a specific field on the
 * workflow input. Convenience helper for the common case where every
 * workflow input carries a `tenantId` (or similar) property.
 *
 * @example
 * ```ts
 * import { Engine, MemoryStorage, tenantFromInputField } from 'weft';
 *
 * const storage = new MemoryStorage();
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
      if (typeof value === 'string') {
        return value.length === 0 ? undefined : { id: value };
      }
      if (typeof value === 'number' && Number.isFinite(value)) {
        // Numeric tenant ids are common when ids come from auto-increment DB
        // keys; coerce to string so the rest of the engine can treat tenant
        // ids uniformly.
        return { id: String(value) };
      }
      return undefined;
    },
  };
}
