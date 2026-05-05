/**
 * Test worker entry point for the agent-tenant-isolation regression test.
 *
 * Wires a single workflow type `tenant-guarded` through
 * `initializeWorkerMessageLoop` from `workflow-worker-entry.ts`. The
 * registered handler exercises the post-shrinkage tenant-tool pattern —
 * the workflow author scopes tools by `ctx.tenant` before invoking the
 * stub provider, matching the recommended pattern in
 * `documentation/agents/what-weft-owns.md`.
 *
 * The handler bypasses `ctx.agent()` (which only exists on the engine-side
 * `Context` class) and calls the stub provider directly. This narrows the
 * test surface to: the worker protocol carries tenant context, and
 * worker-side handlers can read it from their ctx arg.
 *
 * @module workers/test-agent-tenant-worker
 */

/// <reference lib="webworker" />

import type { TenantContext } from '../core/tenant.ts';
import type { WorkerWorkflowContext } from './workflow-runner.ts';
import { initializeWorkerMessageLoop } from './workflow-worker-entry.ts';

// ---------------------------------------------------------------------------
// Fixture agent definition — inlined so this file is self-contained and can
// run inside a Web Worker without cross-module side effects.
// ---------------------------------------------------------------------------

interface FixtureTool {
  name: string;
}

/**
 * Per-tenant tool resolver for the fixture agent. The workflow author
 * scopes tools by `ctx.tenant` before invoking the agent — this is the
 * post-shrinkage pattern described in `documentation/agents/what-weft-owns.md`.
 */
function pickToolsForTenant(tenant: TenantContext | undefined): FixtureTool[] {
  if (tenant?.id === 'tenant-a') return [{ name: 'toolA' }];
  if (tenant?.id === 'tenant-b') return [{ name: 'toolB' }];
  return [];
}

/**
 * Per-tenant input validator. Fails the workflow synchronously for any
 * tenant outside the allow-list. The workflow author runs this guard
 * directly inside the handler.
 */
function assertAllowedTenant(_input: unknown, tenant: TenantContext | undefined): void {
  if (tenant?.id !== 'tenant-a' && tenant?.id !== 'tenant-b') {
    throw new Error(`bad tenant: ${tenant?.id ?? 'undefined'}`);
  }
}

// ---------------------------------------------------------------------------
// Worker-side stub provider
// ---------------------------------------------------------------------------

/**
 * Stub LLM provider that records the tool array it saw on each call.
 * Module-scoped so both the handler and the workflow result can read it.
 */
const capturedToolsPerCall: string[][] = [];

function stubProviderChat(tools: FixtureTool[]): string {
  capturedToolsPerCall.push(tools.map((tool) => tool.name));
  return 'stub-response';
}

// ---------------------------------------------------------------------------
// Registrations
// ---------------------------------------------------------------------------

/* eslint-disable require-yield */
const registrations = new Map<
  string,
  (ctx: WorkerWorkflowContext, input: unknown) => AsyncGenerator
>();

/**
 * Tenant-guarded handler. Returns the tool names the provider saw for this
 * specific call so the test can assert the per-tenant override reached the
 * worker without needing cross-thread state sharing.
 */
registrations.set('tenant-guarded', async function* (ctx, input) {
  assertAllowedTenant(input, ctx.tenant);
  const effectiveTools = pickToolsForTenant(ctx.tenant);
  stubProviderChat(effectiveTools);
  const lastCall = capturedToolsPerCall.at(-1) ?? [];
  return { tenantId: ctx.tenant?.id, tools: lastCall };
});
/* eslint-enable require-yield */

// ---------------------------------------------------------------------------
// Wire up the real worker message loop
// ---------------------------------------------------------------------------

initializeWorkerMessageLoop((type) => registrations.get(type));
