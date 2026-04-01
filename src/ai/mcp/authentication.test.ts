import { describe, expect, it } from 'bun:test';

import type { OAuth2TokenManager } from './oauth2-token-manager';

import { buildAuthHeaders, buildAuthHeadersAsync } from './authentication';

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

describe('buildAuthHeadersAsync', () => {
  it('delegates bearer/api-key/none to sync builder', async () => {
    const bearer = await buildAuthHeadersAsync({ type: 'bearer', token: 'tok' });
    expect(bearer).toEqual({ Authorization: 'Bearer tok' });

    const none = await buildAuthHeadersAsync({ type: 'none' });
    expect(none).toEqual({});
  });

  it('produces Authorization header from OAuth2 token manager', async () => {
    const mockManager: OAuth2TokenManager = {
      async getAccessToken() {
        return 'oauth-token-xyz';
      },
    };

    const headers = await buildAuthHeadersAsync(
      {
        type: 'oauth2',
        tokenEndpoint: 'https://auth.example.com/token',
        clientId: 'id',
        clientSecret: 'secret',
      },
      mockManager,
    );

    expect(headers).toEqual({ Authorization: 'Bearer oauth-token-xyz' });
  });

  it('throws when oauth2 is used without a token manager', async () => {
    await expect(
      buildAuthHeadersAsync({
        type: 'oauth2',
        tokenEndpoint: 'https://auth.example.com/token',
        clientId: 'id',
        clientSecret: 'secret',
      }),
    ).rejects.toThrow('requires a token manager');
  });
});
