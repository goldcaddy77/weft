export type MCPAuthConfig =
  | { type: 'bearer'; token: string }
  | { type: 'api-key'; headerName: string; apiKey: string }
  | { type: 'none' };

/** Build authentication headers for MCP server requests. */
export function buildAuthHeaders(auth: MCPAuthConfig): Record<string, string> {
  switch (auth.type) {
    case 'bearer':
      return { Authorization: `Bearer ${auth.token}` };
    case 'api-key':
      return { [auth.headerName]: auth.apiKey };
    case 'none':
      return {};
  }
}
