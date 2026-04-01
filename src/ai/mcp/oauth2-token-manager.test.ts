import { afterEach, describe, expect, it } from 'bun:test';

import { OAuth2TokenError, createOAuth2TokenManager } from './oauth2-token-manager';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const originalFetch = globalThis.fetch;

function mockFetch(implementation: (...args: any[]) => Promise<Response>): void {
  const mock = Object.assign(implementation, { preconnect: (_url: string) => {} });
  globalThis.fetch = mock as typeof fetch;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const DEFAULT_CONFIG = {
  tokenEndpoint: 'https://auth.example.com/oauth/token',
  clientId: 'test-client',
  clientSecret: 'test-secret',
};

function tokenResponse(accessToken: string, expiresIn = 3600): Response {
  return new Response(JSON.stringify({ access_token: accessToken, expires_in: expiresIn }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createOAuth2TokenManager', () => {
  it('fetches an access token via client credentials grant', async () => {
    let capturedBody = '';

    mockFetch(async (_input: any, init: any) => {
      capturedBody = init?.body ?? '';
      return tokenResponse('token-abc');
    });

    const manager = createOAuth2TokenManager(DEFAULT_CONFIG);
    const token = await manager.getAccessToken();

    expect(token).toBe('token-abc');
    expect(capturedBody).toContain('grant_type=client_credentials');
    expect(capturedBody).toContain('client_id=test-client');
    expect(capturedBody).toContain('client_secret=test-secret');
  });

  it('includes scope when configured', async () => {
    let capturedBody = '';

    mockFetch(async (_input: any, init: any) => {
      capturedBody = init?.body ?? '';
      return tokenResponse('token-scoped');
    });

    const manager = createOAuth2TokenManager({ ...DEFAULT_CONFIG, scope: 'tools:read' });
    await manager.getAccessToken();

    expect(capturedBody).toContain('scope=tools%3Aread');
  });

  it('caches the token and reuses it', async () => {
    let fetchCount = 0;

    mockFetch(async () => {
      fetchCount++;
      return tokenResponse('token-cached', 7200);
    });

    const manager = createOAuth2TokenManager(DEFAULT_CONFIG);

    const first = await manager.getAccessToken();
    const second = await manager.getAccessToken();

    expect(first).toBe('token-cached');
    expect(second).toBe('token-cached');
    expect(fetchCount).toBe(1);
  });

  it('refreshes when token is near expiry', async () => {
    let fetchCount = 0;

    mockFetch(async () => {
      fetchCount++;
      return tokenResponse(`token-${fetchCount}`, 30); // 30 seconds — within 60s buffer
    });

    const manager = createOAuth2TokenManager(DEFAULT_CONFIG);

    const first = await manager.getAccessToken();
    expect(first).toBe('token-1');

    // Second call should trigger refresh because 30s < 60s buffer
    const second = await manager.getAccessToken();
    expect(second).toBe('token-2');
    expect(fetchCount).toBe(2);
  });

  it('shares a single in-flight refresh across concurrent callers', async () => {
    let fetchCount = 0;

    mockFetch(async () => {
      fetchCount++;
      // Simulate slow token endpoint
      await Bun.sleep(50);
      return tokenResponse('token-shared');
    });

    const manager = createOAuth2TokenManager(DEFAULT_CONFIG);

    // Fire 5 concurrent requests
    const results = await Promise.all([
      manager.getAccessToken(),
      manager.getAccessToken(),
      manager.getAccessToken(),
      manager.getAccessToken(),
      manager.getAccessToken(),
    ]);

    // All should get the same token from a single fetch
    expect(results.every((t) => t === 'token-shared')).toBe(true);
    expect(fetchCount).toBe(1);
  });

  it('rejects all concurrent waiters when refresh fails', async () => {
    mockFetch(async () => {
      await Bun.sleep(20);
      return new Response('Server Error', { status: 500 });
    });

    const manager = createOAuth2TokenManager(DEFAULT_CONFIG);

    const results = await Promise.allSettled([
      manager.getAccessToken(),
      manager.getAccessToken(),
      manager.getAccessToken(),
    ]);

    expect(results.every((r) => r.status === 'rejected')).toBe(true);
  });

  it('retries after a failed refresh', async () => {
    let fetchCount = 0;

    mockFetch(async () => {
      fetchCount++;
      if (fetchCount === 1) {
        return new Response('Unauthorized', { status: 401 });
      }
      return tokenResponse('token-retry');
    });

    const manager = createOAuth2TokenManager(DEFAULT_CONFIG);

    // First call fails
    await expect(manager.getAccessToken()).rejects.toThrow(OAuth2TokenError);

    // Second call should retry (not re-use the failed promise)
    const token = await manager.getAccessToken();
    expect(token).toBe('token-retry');
    expect(fetchCount).toBe(2);
  });

  it('throws OAuth2TokenError when server returns non-ok', async () => {
    mockFetch(async () => {
      return new Response('Bad Request', { status: 400 });
    });

    const manager = createOAuth2TokenManager(DEFAULT_CONFIG);

    const error = await manager.getAccessToken().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OAuth2TokenError);
    expect((error as OAuth2TokenError).statusCode).toBe(400);
    expect((error as OAuth2TokenError).tokenEndpoint).toBe(DEFAULT_CONFIG.tokenEndpoint);
  });

  it('throws OAuth2TokenError when response is missing access_token', async () => {
    mockFetch(async () => {
      return new Response(JSON.stringify({ token_type: 'bearer' }), { status: 200 });
    });

    const manager = createOAuth2TokenManager(DEFAULT_CONFIG);

    await expect(manager.getAccessToken()).rejects.toThrow(OAuth2TokenError);
  });

  it('defaults to 3600s TTL when expires_in is missing', async () => {
    let fetchCount = 0;

    mockFetch(async () => {
      fetchCount++;
      return new Response(JSON.stringify({ access_token: 'token-default-ttl' }), { status: 200 });
    });

    const manager = createOAuth2TokenManager(DEFAULT_CONFIG);

    const first = await manager.getAccessToken();
    const second = await manager.getAccessToken();

    expect(first).toBe('token-default-ttl');
    expect(second).toBe('token-default-ttl');
    expect(fetchCount).toBe(1); // Cached because 3600s > 60s buffer
  });
});
