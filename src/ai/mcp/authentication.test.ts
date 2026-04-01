import { describe, expect, it } from 'bun:test';

import { buildAuthHeaders } from './authentication';

describe('buildAuthHeaders', () => {
  it('produces an Authorization header for bearer tokens', () => {
    const headers = buildAuthHeaders({ type: 'bearer', token: 'my-secret-token' });

    expect(headers).toEqual({ Authorization: 'Bearer my-secret-token' });
  });

  it('produces a custom header for API key authentication', () => {
    const headers = buildAuthHeaders({
      type: 'api-key',
      headerName: 'X-API-Key',
      apiKey: 'key-123',
    });

    expect(headers).toEqual({ 'X-API-Key': 'key-123' });
  });

  it('produces empty headers when authentication is none', () => {
    const headers = buildAuthHeaders({ type: 'none' });

    expect(headers).toEqual({});
  });
});
