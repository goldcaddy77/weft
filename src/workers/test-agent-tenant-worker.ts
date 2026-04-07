/**
 * Test worker entry point for the agent-tenant-isolation regression test.
 *
 * Wires a single workflow type `tenant-guarded` through
 * `initializeWorkerMessageLoop` from `workflow-worker-entry.ts`. The
 * registered handler mirrors the shape the engine builds from an
 * {@link AgentDefinition} at `src/core/engine.ts` — it runs `validateInput`
 * and `toolsForTenant` against the worker-side `ctx.tenant` and then invokes
 * a stub provider to record which tools the per-tenant resolver returned.
 *
 * The handler bypasses `ctx.agent()` (which only exists on the engine-side
 * `Context` class) and calls the stub provider directly. This narrows the
 * test surface to exactly what Item 1 fixed: the worker protocol carries
 * tenant context, and worker-side handlers can read it from their ctx arg.
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
 * Per-tenant tool resolver for the fixture agent. Mirrors the
 * `toolsForTenant` hook shape of the real `AgentDefinition`.
 */
function toolsForTenant(tenant: TenantContext | undefined): FixtureTool[] {
  if (tenant?.id === 'tenant-a') return [{ name: 'toolA' }];
  if (tenant?.id === 'tenant-b') return [{ name: 'toolB' }];
  return [];
}

/**
 * Per-tenant input validator. Fails the workflow synchronously for any
 * tenant outside the allow-list, matching the real `validateInput` hook.
 */
function validateInput(_input: unknown, tenant: TenantContext | undefined): void {
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
  validateInput(input, ctx.tenant);
  const effectiveTools = toolsForTenant(ctx.tenant);
  stubProviderChat(effectiveTools);
  const lastCall = capturedToolsPerCall.at(-1) ?? [];
  return { tenantId: ctx.tenant?.id, tools: lastCall };
});
/* eslint-enable require-yield */

// ---------------------------------------------------------------------------
// Wire up the real worker message loop
// ---------------------------------------------------------------------------

initializeWorkerMessageLoop((type) => registrations.get(type));
