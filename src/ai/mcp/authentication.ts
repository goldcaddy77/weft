import type { OAuth2TokenManager } from './oauth2-token-manager';

/** Auth configurations that can produce headers synchronously. */
export type SyncMCPAuthConfig =
  | { type: 'bearer'; token: string }
  | { type: 'api-key'; headerName: string; apiKey: string }
  | { type: 'none' };

/** Full auth configuration including async OAuth2 variant. */
export type MCPAuthConfig =
  | SyncMCPAuthConfig
  | {
      type: 'oauth2';
      tokenEndpoint: string;
      clientId: string;
      clientSecret: string;
      scope?: string;
    };

const RESERVED_HEADERS = new Set(['content-type', 'authorization', 'host']);

/** Build authentication headers synchronously (bearer, API key, or none). */
export function buildAuthHeaders(auth: SyncMCPAuthConfig): Record<string, string> {
  switch (auth.type) {
    case 'bearer':
      return { Authorization: `Bearer ${auth.token}` };
    case 'api-key': {
      const normalizedName = auth.headerName.toLowerCase();
      if (RESERVED_HEADERS.has(normalizedName)) {
        throw new Error(`Cannot use reserved header name "${auth.headerName}" for API key auth`);
      }
      return { [auth.headerName]: auth.apiKey };
    }
    case 'none':
      return {};
  }
}

/**
 * Build authentication headers, supporting all auth types including OAuth2.
 *
 * For OAuth2, the `tokenManager` parameter is required and provides cached,
 * thread-safe access tokens.
 */
export async function buildAuthHeadersAsync(
  auth: MCPAuthConfig,
  tokenManager?: OAuth2TokenManager,
): Promise<Record<string, string>> {
  if (auth.type === 'oauth2') {
    if (!tokenManager) {
      throw new Error('OAuth2 auth requires a token manager');
    }
    const token = await tokenManager.getAccessToken();
    return { Authorization: `Bearer ${token}` };
  }

  return buildAuthHeaders(auth);
}
