export type MCPAuthConfig =
  | { type: 'bearer'; token: string }
  | { type: 'api-key'; headerName: string; apiKey: string }
  | { type: 'none' };

const RESERVED_HEADERS = new Set(['content-type', 'authorization', 'host']);

/** Build authentication headers for MCP server requests. */
export function buildAuthHeaders(auth: MCPAuthConfig): Record<string, string> {
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
