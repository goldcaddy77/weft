import type { MCPAuthConfig } from './authentication.ts';
import { buildAuthHeaders } from './authentication.ts';
import { createOAuth2TokenManager } from './oauth2-token-manager.ts';
import { HttpSseTransport } from './transport-http-sse.ts';
import { HttpTransport } from './transport-http.ts';
import type { MCPTransport, TransportKind } from './transport.ts';
import { inferTransportKind, parseStdioUrl } from './transport.ts';

export interface MCPTransportSource {
  mcp: string;
  auth?: MCPAuthConfig | undefined;
  timeout?: number | undefined;
  transport?: TransportKind | undefined;
}

/**
 * Dynamic import specifier split across a variable so Bun's bundler cannot
 * statically resolve it. This keeps `transport-stdio` (which uses `Bun.spawn`)
 * out of browser bundles while still loading on-demand in Bun.
 */
const STDIO_TRANSPORT_MODULE = './transport-stdio.ts';

/** Build the appropriate transport for an MCP source based on its URL and options. */
export async function createTransportForSource(source: MCPTransportSource): Promise<MCPTransport> {
  const kind = inferTransportKind(source.mcp, source.transport);

  if (kind === 'stdio') {
    if (source.auth && source.auth.type !== 'none') {
      console.warn(
        `[MCP] Auth config ignored for stdio transport: ${source.mcp}. Stdio uses process-level credentials, not HTTP headers.`,
      );
    }

    // Dynamic import with a variable specifier — Bun's bundler cannot
    // statically inline this, so `transport-stdio` stays out of browser bundles.
    const stdioModule = (await import(
      STDIO_TRANSPORT_MODULE
    )) as typeof import('./transport-stdio.ts');
    const { StdioTransport } = stdioModule;
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
