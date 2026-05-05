/**
 * Regression test for tenant propagation in worker-execution mode.
 *
 * Before Item 1 shipped, the `Engine` constructor threw when both
 * `workerExecution` and `tenantResolver` were configured because the worker
 * protocol dropped `tenant` across `postMessage`. This suite verifies the
 * full stack: (1) the constructor does not throw, (2) the resolved tenant
 * reaches the worker-side handler via its `ctx` argument, (3) the
 * workflow author's per-tenant resolver selects the correct tool set for
 * each tenant, and (4) an unexpected tenant still fails the workflow's
 * tenant guard — proving the tenant field is populated, not silently
 * `undefined`.
 *
 * The worker fixture at `src/workers/test-agent-tenant-worker.ts` inlines
 * a `pickToolsForTenant` helper and a stub provider because `ctx.agent()`
 * only exists on the engine-side `Context` class. The engine still
 * receives a matching workflow registration so `engine.start()` can
 * proceed — but the actual handler execution happens in the worker.
 *
 * @module ai/agent-worker-tenant-isolation
 */

import { afterEach, describe, expect, it } from 'bun:test';

import { Engine } from '../core/engine.ts';
import type { WorkflowContext } from '../core/types.ts';

const testAgentTenantWorkerUrl = new URL('../workers/test-agent-tenant-worker.ts', import.meta.url);

describe('agent tenant isolation in worker-execution mode', () => {
  let engine: Engine | undefined;

  afterEach(async () => {
    if (engine) {
      await engine[Symbol.asyncDispose]();
      engine = undefined;
    }
  });

  it('constructs an engine with both workerExecution and tenantResolver configured', () => {
    engine = new Engine({
      workerExecution: {
        workerUrl: testAgentTenantWorkerUrl,
        concurrency: 1,
      },
      tenantResolver: {
        resolve: (_id, input) => {
          if (input && typeof input === 'object' && 'tenantId' in input) {
            return { id: String((input as Record<string, unknown>)['tenantId']) };
          }
          return undefined;
        },
      },
    });
    expect(engine).toBeInstanceOf(Engine);
  });

  it('propagates tenant context to the worker so pickToolsForTenant picks the right tool set', async () => {
    engine = new Engine({
      workerExecution: {
        workerUrl: testAgentTenantWorkerUrl,
        concurrency: 1,
      },
      tenantResolver: {
        resolve: (_id, input) => {
          if (input && typeof input === 'object' && 'tenantId' in input) {
            return { id: String((input as Record<string, unknown>)['tenantId']) };
          }
          return undefined;
        },
      },
    });

    // Engine-side registration is required for `start()` to proceed. The
    // handler body here is unreachable in worker mode — the worker runs
    // its own matching handler from `test-agent-tenant-worker.ts` — but
    // the registration entry must exist so the engine accepts the type.
    engine.register('tenant-guarded', async function* (_ctx: WorkflowContext, _input: unknown) {
      throw new Error('engine-side handler should not run in worker mode');
    });

    const aHandle = await engine.start('tenant-guarded', { tenantId: 'tenant-a' });
    const aResult = (await aHandle.result()) as { tenantId?: string; tools: string[] };
    expect(aResult.tenantId).toBe('tenant-a');
    expect(aResult.tools).toEqual(['toolA']);

    const bHandle = await engine.start('tenant-guarded', { tenantId: 'tenant-b' });
    const bResult = (await bHandle.result()) as { tenantId?: string; tools: string[] };
    expect(bResult.tenantId).toBe('tenant-b');
    expect(bResult.tools).toEqual(['toolB']);
  });

  it('fails the workflow via validateInput when tenant is outside the allow-list', async () => {
    engine = new Engine({
      workerExecution: {
        workerUrl: testAgentTenantWorkerUrl,
        concurrency: 1,
      },
      tenantResolver: {
        resolve: (_id, input) => {
          if (input && typeof input === 'object' && 'tenantId' in input) {
            return { id: String((input as Record<string, unknown>)['tenantId']) };
          }
          return undefined;
        },
      },
    });

    engine.register('tenant-guarded', async function* (_ctx: WorkflowContext, _input: unknown) {
      throw new Error('engine-side handler should not run in worker mode');
    });

    const handle = await engine.start('tenant-guarded', { tenantId: 'unexpected' });
    // Attach catch synchronously so the test runner never sees an
    // unhandled rejection, then await the typed error.
    const resultPromise = handle.result().catch((error: unknown) => error);
    const caught = await resultPromise;
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain('bad tenant: unexpected');
  });
});
