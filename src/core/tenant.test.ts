import { describe, expect, it } from 'bun:test';

import { Engine } from './engine.ts';
import {
  isTenantContext,
  tenantFromInputField,
  type TenantContext,
  type TenantResolver,
} from './tenant.ts';
import type { WorkflowContext } from './types.ts';

// ---------------------------------------------------------------------------
// Unit: helpers
// ---------------------------------------------------------------------------

describe('isTenantContext', () => {
  it('accepts a minimal tenant', () => {
    expect(isTenantContext({ id: 'acme' })).toBe(true);
  });

  it('accepts a tenant with attributes', () => {
    expect(isTenantContext({ id: 'acme', attributes: { tier: 'pro' } })).toBe(true);
  });

  it('rejects non-objects', () => {
    expect(isTenantContext(null)).toBe(false);
    expect(isTenantContext(undefined)).toBe(false);
    expect(isTenantContext('acme')).toBe(false);
    expect(isTenantContext(42)).toBe(false);
  });

  it('rejects objects missing a string id', () => {
    expect(isTenantContext({})).toBe(false);
    expect(isTenantContext({ id: 123 })).toBe(false);
  });

  it('rejects objects with non-object attributes', () => {
    expect(isTenantContext({ id: 'acme', attributes: 'pro' })).toBe(false);
    expect(isTenantContext({ id: 'acme', attributes: null })).toBe(false);
  });
});

describe('tenantFromInputField', () => {
  it('reads the tenant id from the configured field', () => {
    const resolver = tenantFromInputField('tenantId');
    expect(resolver.resolve('wf-1', { tenantId: 'acme' }, 'my-workflow')).toEqual({ id: 'acme' });
  });

  it('returns undefined when the field is missing', () => {
    const resolver = tenantFromInputField('tenantId');
    expect(resolver.resolve('wf-1', {}, 'my-workflow')).toBeUndefined();
  });

  it('returns undefined for non-object inputs', () => {
    const resolver = tenantFromInputField('tenantId');
    expect(resolver.resolve('wf-1', 'acme', 'my-workflow')).toBeUndefined();
    expect(resolver.resolve('wf-1', null, 'my-workflow')).toBeUndefined();
  });

  it('ignores empty string ids', () => {
    const resolver = tenantFromInputField('tenantId');
    expect(resolver.resolve('wf-1', { tenantId: '' }, 'my-workflow')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Integration: engine exposes ctx.tenant
// ---------------------------------------------------------------------------

describe('Engine with tenantResolver', () => {
  it('populates ctx.tenant for new workflows', async () => {
    const captured: Array<TenantContext | undefined> = [];
    const engine = new Engine({
      tenantResolver: {
        resolve: (_id, input) => {
          if (input === null || typeof input !== 'object') return undefined;
          const tenantId = (input as Record<string, unknown>)['tenantId'];
          return typeof tenantId === 'string'
            ? { id: tenantId, attributes: { tier: 'pro' } }
            : undefined;
        },
      },
    });

    engine.register('capture-tenant', async function* (ctx: WorkflowContext) {
      captured.push((ctx as unknown as { tenant?: TenantContext }).tenant);
      return 'done';
    });

    const handle = await engine.start('capture-tenant', { tenantId: 'acme' });
    await handle.result();

    expect(captured).toHaveLength(1);
    expect(captured[0]).toEqual({ id: 'acme', attributes: { tier: 'pro' } });
  });

  it('leaves ctx.tenant undefined when the resolver returns undefined', async () => {
    const captured: Array<TenantContext | undefined> = [];
    const engine = new Engine({
      tenantResolver: {
        resolve: () => undefined,
      },
    });

    engine.register('capture-tenant', async function* (ctx: WorkflowContext) {
      captured.push((ctx as unknown as { tenant?: TenantContext }).tenant);
      return 'done';
    });

    const handle = await engine.start('capture-tenant', { tenantId: 'acme' });
    await handle.result();
    expect(captured[0]).toBeUndefined();
  });

  it('awaits async resolvers', async () => {
    const resolver: TenantResolver = {
      resolve: async (_id, input) => {
        await Bun.sleep(1);
        if (input && typeof input === 'object' && 'tenantId' in input) {
          return { id: String((input as Record<string, unknown>)['tenantId']) };
        }
        return undefined;
      },
    };
    const engine = new Engine({ tenantResolver: resolver });
    const captured: Array<TenantContext | undefined> = [];
    engine.register('capture-tenant', async function* (ctx: WorkflowContext) {
      captured.push((ctx as unknown as { tenant?: TenantContext }).tenant);
      return 'done';
    });

    const handle = await engine.start('capture-tenant', { tenantId: 'beta' });
    await handle.result();
    expect(captured[0]).toEqual({ id: 'beta' });
  });

  it('ctx.tenant is undefined when no resolver is configured', async () => {
    const captured: Array<TenantContext | undefined> = [];
    const engine = new Engine();

    engine.register('capture-tenant', async function* (ctx: WorkflowContext) {
      captured.push((ctx as unknown as { tenant?: TenantContext }).tenant);
      return 'done';
    });

    const handle = await engine.start('capture-tenant', { tenantId: 'acme' });
    await handle.result();
    expect(captured[0]).toBeUndefined();
  });
});
