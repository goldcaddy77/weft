import { describe, expect, it } from 'bun:test';

import type { Context } from './context.ts';
import { Engine } from './engine.ts';
import { generateResumeToken, isResumeRequestBody } from './suspend.ts';
import type { WorkflowContext } from './types.ts';

// ---------------------------------------------------------------------------
// Unit: helpers
// ---------------------------------------------------------------------------

describe('generateResumeToken', () => {
  it('returns a unique, prefixed string', () => {
    const a = generateResumeToken();
    const b = generateResumeToken();
    expect(a).toMatch(/^suspend-[0-9a-f-]+$/);
    expect(b).toMatch(/^suspend-[0-9a-f-]+$/);
    expect(a).not.toBe(b);
  });
});

describe('isResumeRequestBody', () => {
  it('accepts a body with a string token', () => {
    expect(isResumeRequestBody({ token: 'x' })).toBe(true);
    expect(isResumeRequestBody({ token: 'x', result: { ok: true } })).toBe(true);
  });

  it('rejects missing or non-string tokens', () => {
    expect(isResumeRequestBody({})).toBe(false);
    expect(isResumeRequestBody({ token: 42 })).toBe(false);
    expect(isResumeRequestBody(null)).toBe(false);
    expect(isResumeRequestBody(undefined)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Integration: ctx.suspendUntil() resumes via signal delivery
// ---------------------------------------------------------------------------

describe('ctx.suspendUntil', () => {
  it('pauses a workflow and resumes when a matching signal arrives', async () => {
    const engine = new Engine();
    const token = 'resume-token-abc';

    engine.register('await-webhook', async function* (ctx: WorkflowContext) {
      const payload = yield* (ctx as Context).suspendUntil<{ status: string }>({
        resumeToken: token,
      });
      return payload.status;
    });

    const handle = await engine.start('await-webhook', null);

    // Attach the rejection/resolution handler synchronously so the await
    // below never sees an unhandled promise if the engine settles early.
    const resultPromise = handle.result();

    // Let the workflow reach the yield.
    await Bun.sleep(10);

    // Deliver the resume "signal" with the payload.
    await engine.signal(handle.id, token, { status: 'ready' });

    const result = await resultPromise;
    expect(result).toBe('ready');
  });

  it('multiple suspensions in the same workflow use distinct tokens', async () => {
    const engine = new Engine();

    engine.register('multi-suspend', async function* (ctx: WorkflowContext) {
      const context = ctx as Context;
      const first = yield* context.suspendUntil<{ value: number }>({
        resumeToken: 'token-one',
      });
      const second = yield* context.suspendUntil<{ value: number }>({
        resumeToken: 'token-two',
      });
      return first.value + second.value;
    });

    const handle = await engine.start('multi-suspend', null);
    const resultPromise = handle.result();

    await Bun.sleep(10);
    await engine.signal(handle.id, 'token-one', { value: 3 });
    await Bun.sleep(10);
    await engine.signal(handle.id, 'token-two', { value: 4 });

    const result = await resultPromise;
    expect(result).toBe(7);
  });
});
