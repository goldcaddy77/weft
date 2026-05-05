import { describe, expect, it } from 'bun:test';

import type { EngineInternals } from './internals.ts';
import { getComposedActivityInterceptor } from './strategy-helpers.ts';

describe('strategy helpers', () => {
  it('returns the cached composed activity interceptor when already computed', () => {
    const internals = {
      interceptors: [{}],
      composedActivityInterceptor: null,
    } as EngineInternals;

    expect(getComposedActivityInterceptor(internals)).toBeNull();
  });
});
