/**
 * MCP transport abstraction.
 *
 * Transports handle wire-level I/O for MCP communication. The `MCPClient`
 * delegates all network operations to a transport, keeping protocol semantics
 * (tool discovery, invocation, validation) in the client layer.
 */

// ---------------------------------------------------------------------------
// Wire types (JSON-RPC 2.0 subset used by MCP)
// ---------------------------------------------------------------------------

/**
 * A JSON-RPC 2.0 request payload sent to an MCP server via any transport.
 *
 * @example Build a tool invocation request manually
 * ```ts
 * import type { MCPRequest } from 'weft';
 *
 * const request: MCPRequest = {
 *   method: 'tools/invoke',
 *   params: { name: 'search', input: { query: 'weft workflows' } },
 * };
 * ```
 */
export type MCPRequest = {
  method: string;
  params?: unknown;
};

export type MCPResponse = {
  result?: unknown;
  error?: { code: number; message: string };
};

// ---------------------------------------------------------------------------
// Transport interface
// ---------------------------------------------------------------------------

export type MCPTransport = {
  send(request: MCPRequest, signal?: AbortSignal): Promise<MCPResponse>;
  healthCheck(): Promise<boolean>;
  [Symbol.dispose](): void;
};

// ---------------------------------------------------------------------------
// Transport factory
// ---------------------------------------------------------------------------

export type TransportKind = 'http' | 'sse' | 'stdio';

/**
 * Infer the transport kind from a URL string.
 *
 * - `stdio:///path` → `'stdio'`
 * - `http(s)://...` → `'http'` (default) or `'sse'` if overridden
 *
 * @example Detect transport type before constructing a client
 * ```ts
 * import { inferTransportKind } from 'weft';
 *
 * inferTransportKind('https://tools.example.com/mcp');          // 'http'
 * inferTransportKind('stdio:///usr/local/bin/my-mcp-server');   // 'stdio'
 * inferTransportKind('https://tools.example.com/mcp', 'sse');   // 'sse' (override)
 * ```
 */
export function inferTransportKind(url: string, override?: TransportKind): TransportKind {
  if (override) return override;
  if (url.startsWith('stdio://')) return 'stdio';
  return 'http';
}

// ---------------------------------------------------------------------------
// Stdio URL parsing
// ---------------------------------------------------------------------------

type StdioTarget = {
  command: string;
  args: string[];
};

/**
 * Parse a `stdio://` URL into a command and argument list.
 *
 * Format: `stdio:///path/to/binary?arg1=value1&arg2=value2`
 * - The pathname becomes the command.
 * - Each search param becomes `--key value` in the args array.
 *
 * @example Parse a stdio URL for a local MCP server binary
 * ```ts
 * import { parseStdioUrl } from 'weft';
 *
 * const { command, args } = parseStdioUrl(
 *   'stdio:///usr/local/bin/my-mcp-server?port=8080&verbose=true',
 * );
 * // command → '/usr/local/bin/my-mcp-server'
 * // args    → ['--port', '8080', '--verbose', 'true']
 * ```
 */
export function parseStdioUrl(url: string): StdioTarget {
  if (!url.startsWith('stdio://')) {
    throw new MCPTransportError(`Expected stdio:// URL, got: ${url}`);
  }

  const parsed = new URL(url);
  const command = decodeURIComponent(parsed.pathname);

  if (!command || command === '/') {
    throw new MCPTransportError(`Missing command path in stdio URL: ${url}`);
  }

  const args: string[] = [];
  for (const [key, value] of parsed.searchParams) {
    args.push(`--${key}`, value);
  }

  return { command, args };
}

// ---------------------------------------------------------------------------
// Error
// ---------------------------------------------------------------------------

export class MCPTransportError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'MCPTransportError';
  }
}
