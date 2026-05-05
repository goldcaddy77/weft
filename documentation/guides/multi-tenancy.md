# Multi-Tenancy

Multi-tenancy in Weft is a logical isolation boundary. A tenant is usually a customer, workspace, organization, or account. The engine resolves that boundary when a workflow starts, persists it with workflow state, and makes it available to workflow code as `ctx.tenant`.

The tenant context is not a security product by itself. It gives Weft a consistent tenant identity for quotas, filtering, observability, and activity propagation. Your application still owns authentication, authorization, and the resolver logic that decides which tenant a request belongs to.

## Resolving tenants

The common case is a workflow input field that carries the tenant id.

```typescript partial
import { Engine, tenantFromInputField } from 'weft';
import { BunSQLiteStorage } from 'weft/storage/bun-sqlite';

const engine = new Engine({
  storage: new BunSQLiteStorage('./weft.db'),
  tenantResolver: tenantFromInputField('customerId'),
});

engine.register('sync-customer', async function* (ctx, input: { customerId: string }) {
  return {
    customerId: input.customerId,
    tenantId: ctx.tenant?.id,
  };
});
```

`tenantFromInputField(field)` reads a string or finite number from the workflow input and returns `{ id: String(value) }`. Missing, empty, or unsupported values return `undefined`, which means the workflow runs without tenant context.

That convenience resolver is appropriate only when the workflow input has already been authorized and normalized by your application. For tenant-scoped workflows, fail closed: cross-check the input tenant against the authenticated principal before calling `engine.start()`, or use a custom resolver that throws when the tenant is missing or does not belong to the caller.

Use a custom `TenantResolver` when the tenant id comes from a signed request, a schedule, or a richer lookup.

```typescript partial
import { Engine, type TenantResolver } from 'weft';

const tenantResolver: TenantResolver = {
  async resolve(workflowId, input, workflowType) {
    const record = input as { organizationSlug?: string };
    if (!record.organizationSlug) {
      throw new Error(`Missing organization for workflow ${workflowId}`);
    }

    const organization = await lookupOrganization(record.organizationSlug);
    if (!organization || !canStartWorkflowForOrganization(organization.id)) {
      throw new Error(`Unknown organization for workflow ${workflowId}`);
    }

    return {
      id: organization.id,
      attributes: {
        slug: record.organizationSlug,
        tier: organization.tier,
        workflowType,
      },
    };
  },
};

const engine = new Engine({ tenantResolver });
```

Resolver errors fail `engine.start()` before the first checkpoint is written. That is intentional: a bad tenant boundary should stop admission rather than silently creating unscoped work.

## Tenant context in workflows

`ctx.tenant` is persisted on workflow state, so it survives recovery. Use it for decisions that belong in orchestration: choosing a queue, adding search attributes, selecting agent tools, or including tenant identity in activity input.

```typescript partial
engine.register('provision-account', async function* (ctx, input: { accountId: string }) {
  const tenantId = ctx.tenant?.id;
  if (!tenantId) {
    throw new Error('provision-account requires a tenant');
  }

  ctx.setAttribute('tenantId', tenantId);

  yield* ctx.run(createTenantResources, {
    tenantId,
    accountId: input.accountId,
  });

  return { tenantId, accountId: input.accountId, status: 'ready' };
});
```

Activities do not automatically receive `ctx.tenant` as a second context argument. If an activity needs the tenant id, pass it in the activity input or propagate it through workflow and activity interceptors. Passing it explicitly is the easiest option and keeps remote workers honest because the serialized task payload contains everything the worker needs.

## Quotas

Quotas are admission controls applied when a workflow starts with a resolved tenant. Configure them with `EngineOptions.quotas`.

```typescript partial
const engine = new Engine({
  tenantResolver: tenantFromInputField('customerId'),
  quotas: {
    maxConcurrentWorkflows: 100,
    maxWorkflowCreationRate: { count: 60, window: '1m' },
    maxStorageBytes: 50_000_000,
  },
});
```

The three limits are independent:

- **`maxConcurrentWorkflows`:** Maximum active workflows for a tenant.
- **`maxWorkflowCreationRate`:** Maximum workflow starts in a rolling window.
- **`maxStorageBytes`:** Maximum estimated workflow storage for a tenant.

When an in-process start exceeds a configured limit, `engine.start()` throws `QuotaExceededError`. Inspect `tenantId`, `quota`, `currentUsage`, `limit`, and `windowMilliseconds` to explain the failure.

```typescript partial
import { QuotaExceededError } from 'weft';

try {
  await engine.start('sync-customer', { customerId: 'acme' });
} catch (error) {
  if (error instanceof QuotaExceededError) {
    console.error(error.tenantId, error.quota, error.currentUsage, error.limit);
  }
}
```

Over HTTP, quota failures surface as rate-limited operation faults with HTTP `429`. To observe current usage, call `engine.getQuotaUsage(tenantId)` locally or `GET /v1/tenants/:id/quota` through the server API.

```typescript partial
const usage = await engine.getQuotaUsage('acme');
console.log(usage.activeWorkflows.used, usage.activeWorkflows.limit);
```

When JWT authentication is enabled, the quota endpoint limits tenant-scoped callers to their own tenant claim. API-key callers with the `quota:read` scope can inspect the requested tenant.

## Agents and tools

Agent definitions are tenant-agnostic post-shrinkage. The workflow author scopes tools per tenant before invoking the agent — Weft no longer enforces tool isolation centrally. Use `ctx.tenant` inside the workflow body to compose the right tool set:

```typescript partial
const supportAgent = defineAgent({
  name: 'support',
  model: 'claude-sonnet-4-20250514',
  systemPrompt: 'Help the customer support team resolve tickets.',
});

function pickToolsForTenant(tenant: TenantContext | undefined): AgentToolDefinition[] {
  if (tenant?.attributes?.['tier'] === 'enterprise') {
    return [ticketSearch, contractLookup, escalationTool];
  }
  return [ticketSearch];
}

engine.register('support-workflow', async function* (ctx) {
  const result = yield* (ctx as Context).agent({
    model: supportAgent.model,
    prompt: 'Resolve the customer ticket.',
    tools: pickToolsForTenant(ctx.tenant),
  });
  return result;
});
```

See [`what-weft-owns.md`](../agents/what-weft-owns.md) for the responsibility-shift rationale and the canonical mock-provider example.

## Remote workers and interceptors

Remote workers execute named activities. If a remote activity needs tenant context, use one of two patterns:

- Put the tenant id in the activity input.
- Use a workflow interceptor to add a tenant header and an activity interceptor to validate it on the worker side.

```typescript partial
const tenantHeaderInterceptor: WorkflowInterceptor = {
  *activity(interception, next) {
    const tenantId = interception.input?.tenantId;
    if (typeof tenantId === 'string') {
      interception.headers.set('x-weft-tenant-id', tenantId);
    }

    return yield* next(interception);
  },
};
```

Headers cross the worker boundary through Weft's activity dispatch protocol. They are useful for observability and validation, but they should not replace authorization checks in your activity implementation.

## Storage isolation

Tenant context does not automatically put every tenant in a separate database. The default engine stores all workflow state in the configured storage backend and includes tenant identity in workflow state and quota keys.

If you need physical or namespace-level separation, use `ScopedStorage` or separate engine instances.

```typescript partial
import { Engine, ScopedStorage } from 'weft';

const tenantStorage = new ScopedStorage(sharedStorage, 'tenant:acme');
const engine = new Engine({ storage: tenantStorage });
```

`ScopedStorage` prefixes keys and strips the prefix when scanning. It is useful for per-tenant embedded deployments, test isolation, and administrative tools that need a narrowed storage view.

## Deployment patterns

**Single engine, many tenants:** One engine owns all tenants. This is the simplest deployment and works well when tenants share infrastructure and quotas are enough isolation.

**Engine per tenant:** Each tenant gets its own engine and storage scope. This costs more operationally, but it gives stronger blast-radius boundaries and simpler per-tenant backup or deletion.

**Hybrid:** A shared control-plane engine handles ordinary tenants, while high-value or regulated tenants get dedicated engines. Use the same `TenantResolver` shape in both places so workflow code does not care which deployment path admitted it.

## Observability and auditing

Make tenant identity visible in the places operators already look:

- Set a `tenantId` search attribute early in workflows that require tenancy.
- Add tenant fields to structured logs and traces through interceptors.
- Use `engine.getQuotaUsage()` or `GET /v1/tenants/:id/quota` for quota dashboards.
- Include tenant id in activity inputs when the activity writes to external systems.

For workflow events, traces, and metrics, see the [observability guide](./observability.md), [events guide](./events.md), and [interceptors guide](./interceptors.md).

## Common pitfalls

- **Resolver drift:** If two services derive tenant ids differently, the same customer can land in different namespaces. Keep resolver code centralized.
- **Unscoped system workflows:** Returning `undefined` is valid, but quotas do not apply. Use it deliberately for platform workflows, not because parsing failed.
- **Quota surprises:** Creation-rate limits and concurrent-workflow limits are checked at admission. A burst can fail before any workflow handler code runs.
- **Cross-tenant messages:** Validate the tenant before sending signals, updates, or administrative operations from user-facing routes.
- **Remote activity trust:** A remote worker sees serialized input and propagated headers. It does not see your original request context unless you put the required information on the task.
