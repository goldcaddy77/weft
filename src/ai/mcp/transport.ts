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

/**
 * The JSON-RPC 2.0 response shape returned by any {@link MCPTransport} `send()`
 * call. Contains an optional `result` for success cases and an optional `error`
 * object with a numeric `code` and human-readable `message` for failures.
 *
 * @example Check a transport response for errors
 * ```ts
 * import type { MCPResponse } from 'weft';
 * import { MCPClient } from 'weft';
 *
 * // Responses are returned by MCPClient internally; inspect them via a custom transport:
 * declare const response: MCPResponse;
 *
 * if (response.error) {
 *   console.error(`MCP error ${response.error.code}: ${response.error.message}`);
 * } else {
 *   console.log('Result:', response.result);
 * }
 * ```
 */
export type MCPResponse = {
  result?: unknown;
  error?: { code: number; message: string };
};

// ---------------------------------------------------------------------------
// Transport interface
// ---------------------------------------------------------------------------

/**
 * The interface every MCP transport must implement. `send()` performs a
 * request-response cycle with an optional `AbortSignal`. `healthCheck()` probes
 * server availability. `[Symbol.dispose]()` releases underlying resources such
 * as sockets, SSE connections, and child processes.
 *
 * @example Implement a custom in-process transport for testing
 * ```ts
 * import type { MCPTransport, MCPRequest, MCPResponse } from 'weft';
 *
 * const inProcessTransport: MCPTransport = {
 *   async send(request: MCPRequest): Promise<MCPResponse> {
 *     if (request.method === 'tools/list') return { result: { tools: [] } };
 *     return { error: { code: -32601, message: 'Method not found' } };
 *   },
 *   async healthCheck() { return true; },
 *   [Symbol.dispose]() {},
 * };
 * ```
 */
export type MCPTransport = {
  send(request: MCPRequest, signal?: AbortSignal): Promise<MCPResponse>;
  healthCheck(): Promise<boolean>;
  [Symbol.dispose](): void;
};

// ---------------------------------------------------------------------------
// Transport factory
// ---------------------------------------------------------------------------

/**
 * Discriminator for MCP transport implementations. `'http'` targets synchronous
 * REST servers, `'sse'` targets servers that push responses over Server-Sent
 * Events, and `'stdio'` targets local processes communicating over stdin/stdout.
 * Pass as the `transport` override on {@link MCPToolSource} to bypass auto-detection.
 *
 * @example Force SSE transport for a known SSE-only server
 * ```ts
 * import type { TransportKind } from 'weft';
 * import { executeAgentLoop } from 'weft';
 * import type { LLMProvider } from 'weft';
 *
 * declare const provider: LLMProvider;
 *
 * const kind: TransportKind = 'sse';
 * await executeAgentLoop(
 *   {
 *     model: 'claude-sonnet-4-5',
 *     provider,
 *     tools: [{ mcp: 'https://tools.example.com', transport: kind }],
 *   },
 *   'List available tools.',
 * );
 * ```
 */
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

/**
 * Base error class for transport-layer failures in MCP communication. Thrown
 * by {@link HttpTransport}, {@link HttpSseTransport}, and {@link StdioTransport}
 * for network errors, HTTP non-2xx responses, request timeouts, and malformed
 * JSON responses. The `MCPClient` wraps these as {@link MCPServerUnavailableError}.
 *
 * @example Catch transport errors for low-level diagnostics
 * ```ts
 * import { HttpTransport, MCPTransportError } from 'weft';
 *
 * const transport = new HttpTransport({ serverUrl: 'https://tools.example.com/mcp' });
 *
 * try {
 *   await transport.send({ method: 'tools/list' });
 * } catch (error) {
 *   if (error instanceof MCPTransportError) {
 *     console.error('Transport failure:', error.message);
 *   }
 * }
 * ```
 */
export class MCPTransportError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'MCPTransportError';
  }
}
