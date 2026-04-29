import { describe, expect, it } from 'bun:test';

import {
  countLiteralSegments,
  countPathParameters,
  extractRouteParameters,
  getRequiredRouteParameter,
  isOperationFaultLike,
  shouldPreferLegacyRoute,
} from './handler.ts';

describe('handler internals', () => {
  it('extracts and decodes route parameters', () => {
    expect(
      extractRouteParameters(
        ['workflowId', 'step'],
        ['/v1/workflows/alpha%2Fbeta/replay/2', 'alpha%2Fbeta', '2'],
      ),
    ).toEqual({
      workflowId: 'alpha/beta',
      step: '2',
    });
  });

  it('throws a malformed-route error when decoding fails', () => {
    expect(() =>
      extractRouteParameters(['workflowId'], ['/v1/workflows/%E0%A4%A', '%E0%A4%A']),
    ).toThrow('Malformed route parameter encoding');
  });

  it('returns required route parameters and throws when one is missing', () => {
    expect(getRequiredRouteParameter({ workflowId: 'wf-123' }, 'workflowId', 'GET /example')).toBe(
      'wf-123',
    );
    expect(() => getRequiredRouteParameter({}, 'workflowId', 'GET /example')).toThrow(
      'Missing route parameter "workflowId" for GET /example',
    );
  });

  it('counts path parameters and literal segments', () => {
    expect(countPathParameters('/v1/workflows/:id/replay/:step')).toBe(2);
    expect(countLiteralSegments('/v1/workflows/:id/replay/:step')).toBe(3);
  });

  it('prefers a legacy route with fewer path parameters', () => {
    expect(
      shouldPreferLegacyRoute(
        { binding: { path: '/v1/items/:id/:action' } as never },
        { handler: 'healthCheck', params: {}, path: '/v1/items/:id' },
      ),
    ).toBe(true);
  });

  it('prefers a legacy route with more literal segments when parameter counts tie', () => {
    expect(
      shouldPreferLegacyRoute(
        { binding: { path: '/v1/items/:id' } as never },
        { handler: 'healthCheck', params: {}, path: '/v1/items/:id/result' },
      ),
    ).toBe(true);
  });

  it('does not prefer the legacy route when there is no overlap', () => {
    expect(
      shouldPreferLegacyRoute(null, { handler: 'healthCheck', params: {}, path: '/v1/health' }),
    ).toBe(false);
  });

  it('recognizes valid operation faults and rejects invalid shapes', () => {
    expect(
      isOperationFaultLike({
        code: 'Conflict',
        message: 'conflict',
        data: { reason: 'duplicate' },
      }),
    ).toBe(true);
    expect(isOperationFaultLike(null)).toBe(false);
    expect(
      isOperationFaultLike({
        code: 'Conflict',
        message: 'conflict',
        data: null,
      }),
    ).toBe(false);
    expect(
      isOperationFaultLike({
        __proto__: { code: 'Conflict' },
        message: 'conflict',
        data: { reason: 'duplicate' },
      }),
    ).toBe(false);
    expect(
      isOperationFaultLike({
        code: 'InvalidParams',
        message: 'bad input',
        data: [],
      }),
    ).toBe(false);
    const throwingGetter = {
      code: 'Conflict',
      message: 'conflict',
      get data() {
        throw new Error('should not escape');
      },
    };
    expect(isOperationFaultLike(throwingGetter)).toBe(false);
  });
});
