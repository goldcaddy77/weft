/**
 * OAuth2 client credentials token manager for MCP server authentication.
 *
 * Handles token fetching, caching, and thread-safe refresh. Multiple
 * concurrent callers share a single in-flight token request.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type OAuth2Config = {
  tokenEndpoint: string;
  clientId: string;
  clientSecret: string;
  scope?: string;
};

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

export class OAuth2TokenError extends Error {
  readonly tokenEndpoint: string;
  readonly statusCode: number | undefined;

  constructor(message: string, tokenEndpoint: string, statusCode?: number) {
    super(message);
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
      throw new OAuth2TokenError('Token endpoint returned invalid JSON', config.tokenEndpoint);
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
