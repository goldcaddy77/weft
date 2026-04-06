import type { MCPAuthConfig } from './authentication.ts';
import { buildAuthHeaders } from './authentication.ts';
import { createOAuth2TokenManager } from './oauth2-token-manager.ts';
import { HttpSseTransport } from './transport-http-sse.ts';
import { HttpTransport } from './transport-http.ts';
import { StdioTransport } from './transport-stdio.ts';
import type { MCPTransport, TransportKind } from './transport.ts';
import { inferTransportKind, parseStdioUrl } from './transport.ts';

export interface MCPTransportSource {
  mcp: string;
  auth?: MCPAuthConfig | undefined;
  timeout?: number | undefined;
  transport?: TransportKind | undefined;
}

/** Build the appropriate transport for an MCP source based on its URL and options. */
export function createTransportForSource(source: MCPTransportSource): MCPTransport {
  const kind = inferTransportKind(source.mcp, source.transport);

  if (kind === 'stdio') {
    if (source.auth && source.auth.type !== 'none') {
      console.warn(
        `[MCP] Auth config ignored for stdio transport: ${source.mcp}. Stdio uses process-level credentials, not HTTP headers.`,
      );
    }

    const target = parseStdioUrl(source.mcp);
    return new StdioTransport({
      command: target.command,
      args: target.args,
      timeout: source.timeout,
    });
  }

  let headers: import('./transport-http.ts').HeaderSource = {};
  if (source.auth) {
    if (source.auth.type === 'oauth2') {
      const tokenManager = createOAuth2TokenManager(source.auth);
      headers = async () => {
        const token = await tokenManager.getAccessToken();
        return { Authorization: `Bearer ${token}` };
      };
    } else {
      headers = buildAuthHeaders(source.auth);
    }
  }

  switch (kind) {
    case 'sse':
      return new HttpSseTransport({
        serverUrl: source.mcp,
        headers,
        timeout: source.timeout,
      });
    case 'http':
      return new HttpTransport({
        serverUrl: source.mcp,
        headers,
        timeout: source.timeout,
      });
  }
}
