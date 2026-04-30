/**
 * OAuth2 client credentials token manager for MCP server authentication.
 *
 * Handles token fetching, caching, and thread-safe refresh. Multiple
 * concurrent callers share a single in-flight token request.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * OAuth2 client credentials configuration used by {@link createOAuth2TokenManager}.
 *
 * @example Configure client credentials for a protected MCP server
 * ```ts
 * import { createOAuth2TokenManager, type OAuth2Config } from 'weft';
 *
 * const config: OAuth2Config = {
 *   tokenEndpoint: 'https://auth.example.com/oauth/token',
 *   clientId: process.env['CLIENT_ID'] ?? '',
 *   clientSecret: process.env['CLIENT_SECRET'] ?? '',
 *   scope: 'tools:invoke',
 * };
 *
 * const manager = createOAuth2TokenManager(config);
 * const token = await manager.getAccessToken();
 * ```
 */
export type OAuth2Config = {
  tokenEndpoint: string;
  clientId: string;
  clientSecret: string;
  scope?: string;
};

/**
 * Interface returned by {@link createOAuth2TokenManager}. Provides a single
 * `getAccessToken()` method that returns a cached or freshly fetched OAuth2
 * bearer token. Concurrent callers share one in-flight refresh request to avoid
 * thundering-herd token endpoint hammering.
 *
 * @example Use a token manager as a dynamic header source for an MCP transport
 * ```ts
 * import { createOAuth2TokenManager, HttpTransport, MCPClient, type OAuth2TokenManager } from 'weft';
 *
 * const manager: OAuth2TokenManager = createOAuth2TokenManager({
 *   tokenEndpoint: 'https://auth.example.com/oauth/token',
 *   clientId: process.env['CLIENT_ID'] ?? '',
 *   clientSecret: process.env['CLIENT_SECRET'] ?? '',
 * });
 *
 * const transport = new HttpTransport({
 *   serverUrl: 'https://tools.example.com/mcp',
 *   headers: async () => ({ Authorization: `Bearer ${await manager.getAccessToken()}` }),
 * });
 * ```
 */
export type OAuth2TokenManager = {
  /** Get a valid access token, refreshing if necessary. */
  getAccessToken(): Promise<string>;
};

type CachedToken = {
  accessToken: string;
  expiresAt: number;
};

// ---------------------------------------------------------------------------
// Error
// ---------------------------------------------------------------------------

/**
 * Thrown by {@link createOAuth2TokenManager} when the OAuth2 token endpoint
 * Thrown by `OAuth2TokenManager.getAccessToken()` when the OAuth2 token
 * endpoint returns an HTTP error status, invalid JSON, or a response body that
 * lacks an `access_token` field.
 *
 * @example Catch and report token fetch failures
 * ```ts
 * import { createOAuth2TokenManager, OAuth2TokenError } from 'weft';
 *
 * const manager = createOAuth2TokenManager({
 *   tokenEndpoint: 'https://auth.example.com/oauth/token',
 *   clientId: 'my-client',
 *   clientSecret: 'wrong-secret',
 * });
 *
 * try {
 *   await manager.getAccessToken();
 * } catch (error) {
 *   if (error instanceof OAuth2TokenError) {
 *     console.error(`Token fetch failed (${error.statusCode}): ${error.message}`);
 *   }
 * }
 * ```
 */
export class OAuth2TokenError extends Error {
  readonly tokenEndpoint: string;
  readonly statusCode: number | undefined;

  constructor(message: string, tokenEndpoint: string, statusCode?: number, options?: ErrorOptions) {
    super(message, options);
    this.name = 'OAuth2TokenError';
    this.tokenEndpoint = tokenEndpoint;
    this.statusCode = statusCode;
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/** Buffer before expiry to trigger proactive refresh (60 seconds). */
const EXPIRY_BUFFER_MS = 60_000;

/**
 * Create an OAuth2 token manager for the client credentials grant.
 *
 * The manager caches tokens and refreshes them proactively before expiry.
 * Concurrent callers share a single in-flight refresh request.
 *
 * @example Get an access token and build a dynamic authorization header
 * ```ts
 * import { createOAuth2TokenManager } from 'weft';
 *
 * const tokenManager = createOAuth2TokenManager({
 *   tokenEndpoint: 'https://auth.example.com/oauth/token',
 *   clientId: process.env['CLIENT_ID'] ?? '',
 *   clientSecret: process.env['CLIENT_SECRET'] ?? '',
 * });
 *
 * // Concurrent calls share one in-flight refresh; cached while token is live.
 * const token = await tokenManager.getAccessToken();
 * const headers = { Authorization: `Bearer ${token}` };
 * console.log(Object.keys(headers)); // ['Authorization']
 * ```
 */
export function createOAuth2TokenManager(config: OAuth2Config): OAuth2TokenManager {
  let cached: CachedToken | null = null;
  let inflightRefresh: Promise<string> | null = null;

  async function fetchToken(): Promise<CachedToken> {
    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: config.clientId,
      client_secret: config.clientSecret,
    });

    if (config.scope) {
      body.set('scope', config.scope);
    }

    const response = await fetch(config.tokenEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });

    if (!response.ok) {
      throw new OAuth2TokenError(
        `Token request failed with status ${response.status}`,
        config.tokenEndpoint,
        response.status,
      );
    }

    let data: Record<string, unknown>;
    try {
      data = (await response.json()) as Record<string, unknown>;
    } catch (cause) {
      throw new OAuth2TokenError(
        'Token endpoint returned invalid JSON',
        config.tokenEndpoint,
        response.status,
        { cause },
      );
    }
    const accessToken = data['access_token'];
    const expiresIn = data['expires_in'];

    if (typeof accessToken !== 'string') {
      throw new OAuth2TokenError(
        'Token response missing "access_token" field',
        config.tokenEndpoint,
      );
    }

    const ttlSeconds = typeof expiresIn === 'number' ? expiresIn : 3600;
    const expiresAt = Date.now() + ttlSeconds * 1000;

    return { accessToken, expiresAt };
  }

  async function getAccessToken(): Promise<string> {
    if (cached !== null && Date.now() < cached.expiresAt - EXPIRY_BUFFER_MS) {
      return cached.accessToken;
    }

    // Thread-safe: concurrent callers share one in-flight refresh
    if (inflightRefresh) {
      return inflightRefresh;
    }

    inflightRefresh = fetchToken()
      .then((token) => {
        cached = token;
        inflightRefresh = null;
        return token.accessToken;
      })
      .catch((error) => {
        inflightRefresh = null;
        throw error;
      });

    return inflightRefresh;
  }

  return { getAccessToken };
}
