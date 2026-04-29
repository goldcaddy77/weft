/**
 * Auth configurations that can produce headers synchronously.
 *
 * @example Bearer token auth for an HTTP MCP server
 * ```ts
 * import type { SyncMCPAuthConfig } from 'weft';
 * import { buildAuthHeaders } from 'weft';
 *
 * const auth: SyncMCPAuthConfig = { type: 'bearer', token: process.env['API_KEY'] ?? '' };
 * const headers = buildAuthHeaders(auth);
 * // headers → { Authorization: 'Bearer <token>' }
 * ```
 */
export type SyncMCPAuthConfig =
  | { type: 'bearer'; token: string }
  | { type: 'api-key'; headerName: string; apiKey: string }
  | { type: 'none' };

/**
 * Full auth configuration including async OAuth2 variant.
 *
 * Pass as the `auth` field on an {@link MCPToolSource} to authenticate
 * requests sent to an MCP server. Choose the variant that matches the
 * server's authentication scheme.
 *
 * @example OAuth2 client credentials for a protected MCP endpoint
 * ```ts
 * import type { MCPAuthConfig, MCPToolSource } from 'weft';
 *
 * const auth: MCPAuthConfig = {
 *   type: 'oauth2',
 *   tokenEndpoint: 'https://auth.example.com/oauth/token',
 *   clientId: process.env['CLIENT_ID'] ?? '',
 *   clientSecret: process.env['CLIENT_SECRET'] ?? '',
 *   scope: 'tools:invoke',
 * };
 *
 * const source: MCPToolSource = { mcp: 'https://mcp.example.com', auth };
 * ```
 */
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

/**
 * Build authentication headers synchronously (bearer, API key, or none).
 *
 * @example Build an API-key header for a custom endpoint
 * ```ts
 * import { buildAuthHeaders } from 'weft';
 *
 * const headers = buildAuthHeaders({
 *   type: 'api-key',
 *   headerName: 'X-API-Key',
 *   apiKey: process.env['SERVICE_KEY'] ?? '',
 * });
 * // headers → { 'X-API-Key': '<key>' }
 * ```
 */
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
