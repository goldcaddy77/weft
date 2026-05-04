/**
 * Authentication middleware for the Weft HTTP server.
 *
 * Supports three authentication methods, all optional and configurable:
 * - **API keys**: validated via `Authorization: Bearer <key>` or `X-API-Key` header
 * - **JWT**: HMAC or RSA/ECDSA signature verification with claims validation
 * - **mTLS**: mutual TLS at the transport layer (configured via Bun.serve tls options)
 *
 * @module server/authentication
 */

import type { AuthorizationScope } from '../authorization-scope.ts';
import { tryAdmitApiKey } from './api-key.ts';
import { importJWTKey, verifyJWT } from './crypto.ts';
import {
  DEFAULT_PUBLIC_PATHS,
  type AuthConfig,
  type Authenticator,
  type AuthResult,
  type JWTConfig,
} from './types.ts';

export { importJWTKey, signJWT, verifyJWT } from './crypto.ts';
export {
  DEFAULT_CLOCK_TOLERANCE,
  DEFAULT_PUBLIC_PATHS,
  type AuthConfig,
  type AuthContext,
  type Authenticator,
  type AuthMethod,
  type AuthResult,
  type JWTAlgorithm,
  type JWTConfig,
  type JWTPayload,
  type MTLSConfig,
} from './types.ts';

function extractBearerToken(request: Request): string | null {
  const authorization = request.headers.get('Authorization');
  if (authorization?.startsWith('Bearer ')) {
    return authorization.slice(7);
  }
  return null;
}

function extractApiKey(request: Request): string | null {
  const headerKey = request.headers.get('X-API-Key');
  if (headerKey) return headerKey;
  return extractBearerToken(request);
}

function validateJwtConfig(config: JWTConfig | undefined): void {
  if (config === undefined) return;

  const algorithm = config.algorithm ?? 'HS256';
  if (algorithm.startsWith('HS') && !config.secret) {
    throw new Error('JWT configuration requires "secret" for HMAC algorithms');
  }
  if ((algorithm.startsWith('RS') || algorithm.startsWith('ES')) && !config.publicKey) {
    throw new Error('JWT configuration requires "publicKey" for RSA/ECDSA algorithms');
  }
}

function assertAtLeastOneMethod(config: AuthConfig): void {
  const hasMethod =
    (config.apiKeys && config.apiKeys.length > 0) ||
    config.jwt !== undefined ||
    config.mtls !== undefined ||
    config.resolveApiKeyPrincipal !== undefined;
  if (!hasMethod) {
    throw new Error(
      'AuthConfig must specify at least one authentication method ' +
        '(apiKeys, resolveApiKeyPrincipal, jwt, or mtls)',
    );
  }
}

function assertNoConflictingMethods(config: AuthConfig): void {
  if (config.resolveApiKeyPrincipal !== undefined && config.jwt !== undefined) {
    throw new Error(
      'AuthConfig cannot combine resolveApiKeyPrincipal with jwt: ' +
        'the resolver consumes every Authorization: Bearer token before JWT verification, ' +
        'so the JWT method would be unreachable.',
    );
  }
}

function normalizePathname(request: Request): string {
  const url = new URL(request.url);
  return url.pathname.length > 1 ? url.pathname.replace(/\/+$/, '') : url.pathname;
}

type ApiKeyAdmissionOptions = {
  resolver: AuthConfig['resolveApiKeyPrincipal'];
  apiKeySet: Set<string> | null;
  defaultApiKeyScopes: ReadonlyArray<AuthorizationScope>;
};

type AuthAttempt = {
  explicitAuthAttempted: boolean;
  result: AuthResult | null;
};

async function authenticateViaApiKey(
  request: Request,
  options: ApiKeyAdmissionOptions,
): Promise<AuthAttempt> {
  const presentedKey = extractApiKey(request);
  const hasApiKeyPath = options.resolver !== undefined || options.apiKeySet !== null;
  if (!presentedKey || !hasApiKeyPath) {
    return { explicitAuthAttempted: false, result: null };
  }

  const result = await tryAdmitApiKey(
    presentedKey,
    options.resolver,
    options.apiKeySet,
    options.defaultApiKeyScopes,
  );
  return {
    explicitAuthAttempted: true,
    result: result === 'continue' ? null : result,
  };
}

async function authenticateViaJwt(
  request: Request,
  jwtKey: CryptoKey | null,
  jwtConfig: JWTConfig | undefined,
): Promise<AuthAttempt> {
  if (!jwtKey || !jwtConfig) {
    return { explicitAuthAttempted: false, result: null };
  }

  const token = extractBearerToken(request);
  if (!token) {
    return { explicitAuthAttempted: false, result: null };
  }

  if (!token.includes('.')) {
    return { explicitAuthAttempted: true, result: null };
  }

  try {
    const claims = await verifyJWT(token, jwtKey, jwtConfig);
    return { explicitAuthAttempted: true, result: { authenticated: true, method: 'jwt', claims } };
  } catch (error) {
    console.warn('JWT verification failed:', error instanceof Error ? error.message : error);
    return { explicitAuthAttempted: true, result: null };
  }
}

/**
 * Validate an `AuthConfig` eagerly, throwing on invalid combinations.
 * Called synchronously in `serve()` so misconfigurations fail fast.
 *
 * @example
 * ```ts
 * import { validateAuthConfig } from 'weft';
 *
 * // Throws if config is invalid (e.g. missing secret for HS256)
 * validateAuthConfig({
 *   apiKeys: ['secret-key-1'],
 * });
 * console.log('Config is valid');
 * ```
 */
export function validateAuthConfig(config: AuthConfig): void {
  validateJwtConfig(config.jwt);
  assertAtLeastOneMethod(config);
  assertNoConflictingMethods(config);
}

/**
 * Create an authenticator function from an auth configuration.
 *
 * The returned function checks each configured method in order:
 * 1. Public path bypass
 * 2. API key (O(1) set lookup)
 * 3. JWT (signature + claims verification)
 * 4. mTLS (transport-level — any request that reaches the handler is authenticated)
 *
 * @example
 * ```ts
 * import { createAuthenticator } from 'weft';
 *
 * const authenticate = await createAuthenticator({
 *   apiKeys: ['my-secret-key'],
 * });
 * const request = new Request('http://localhost/v1/workflows', {
 *   headers: { 'X-API-Key': 'my-secret-key' },
 * });
 * const result = await authenticate(request);
 * console.log(result.authenticated); // true
 * ```
 */
export async function createAuthenticator(config: AuthConfig): Promise<Authenticator> {
  validateAuthConfig(config);

  const apiKeySet = config.apiKeys?.length ? new Set(config.apiKeys) : null;
  const resolver = config.resolveApiKeyPrincipal;
  const defaultApiKeyScopes = config.defaultApiKeyScopes ?? [];
  const jwtKey = config.jwt ? await importJWTKey(config.jwt) : null;
  const publicPaths = new Set(config.publicPaths ?? DEFAULT_PUBLIC_PATHS);

  return async (request: Request): Promise<AuthResult> => {
    if (publicPaths.has(normalizePathname(request))) {
      return { authenticated: true, method: 'public' };
    }

    const apiKeyAttempt = await authenticateViaApiKey(request, {
      resolver,
      apiKeySet,
      defaultApiKeyScopes,
    });
    if (apiKeyAttempt.result !== null) return apiKeyAttempt.result;

    const jwtAttempt = await authenticateViaJwt(request, jwtKey, config.jwt);
    if (jwtAttempt.result !== null) return jwtAttempt.result;

    const explicitAuthAttempted =
      apiKeyAttempt.explicitAuthAttempted || jwtAttempt.explicitAuthAttempted;
    if (config.mtls && !explicitAuthAttempted) {
      return { authenticated: true, method: 'mtls' };
    }

    return { authenticated: false, error: 'No valid credentials provided' };
  };
}

/**
 * Build Bun.serve-compatible TLS options from an mTLS configuration.
 * Returns `undefined` when no mTLS is configured.
 */
export function buildTLSOptions(config: AuthConfig | undefined):
  | {
      cert: string;
      key: string;
      ca: string | string[];
      requestCert: boolean;
      rejectUnauthorized: boolean;
    }
  | undefined {
  if (!config?.mtls) return undefined;

  return {
    cert: config.mtls.cert,
    key: config.mtls.key,
    ca: config.mtls.ca,
    requestCert: true,
    rejectUnauthorized: config.mtls.rejectUnauthorized ?? true,
  };
}
