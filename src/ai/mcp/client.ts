import type { ToolDefinition } from '../providers/types';
import type { SyncMCPAuthConfig } from './authentication';
import type { MCPTransport } from './transport';

import { buildAuthHeaders } from './authentication';
import { MCPTransportError } from './transport';
import { HttpTransport } from './transport-http';

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/**
 * Options to construct an HttpTransport automatically from a server URL.
 *
 * @example Connect to a publicly accessible MCP server
 * ```ts
 * import { MCPClient, type MCPClientUrlOptions } from 'weft';
 *
 * const options: MCPClientUrlOptions = {
 *   serverUrl: 'https://tools.example.com/mcp',
 *   auth: { type: 'bearer', token: process.env['MCP_TOKEN'] ?? '' },
 *   timeout: 15_000,
 * };
 *
 * const client = new MCPClient(options);
 * const tools = await client.discoverTools();
 * ```
 */
export type MCPClientUrlOptions = {
  serverUrl: string;
  /** OAuth2 is not supported via URL options — use a transport with pre-fetched headers. */
  auth?: SyncMCPAuthConfig;
  timeout?: number;
};

/**
 * Options to supply a pre-constructed transport to an {@link MCPClient}.
 *
 * Use this when you need full control over transport configuration — for example
 * to inject OAuth2 dynamic headers or to use a stdio transport for a local process.
 *
 * @example Attach a pre-built transport with dynamic headers
 * ```ts
 * import { MCPClient, type MCPClientTransportOptions, type MCPTransport } from 'weft';
 *
 * // Bring your own transport (e.g. an HttpTransport with OAuth2 headers).
 * declare const myTransport: MCPTransport;
 *
 * const options: MCPClientTransportOptions = { transport: myTransport, timeout: 20_000 };
 * const client = new MCPClient(options);
 * const tools = await client.discoverTools();
 * console.log('Discovered tools:', tools.length);
 * ```
 */
export type MCPClientTransportOptions = {
  transport: MCPTransport;
  timeout?: number | undefined;
};

/**
 * Union type for constructing an {@link MCPClient}. Use `MCPClientUrlOptions`
 * to connect by server URL (with optional auth), or `MCPClientTransportOptions`
 * to supply a pre-built transport for OAuth2 dynamic headers, stdio processes,
 * or SSE streams. TypeScript narrows on the presence of `transport` vs `serverUrl`.
 *
 * @example Connect via URL with bearer auth
 * ```ts
 * import { MCPClient, type MCPClientOptions } from 'weft';
 *
 * const options: MCPClientOptions = {
 *   serverUrl: 'https://tools.example.com/mcp',
 *   auth: { type: 'bearer', token: process.env['MCP_TOKEN'] ?? '' },
 *   timeout: 15_000,
 * };
 *
 * const client = new MCPClient(options);
 * const tools = await client.discoverTools();
 * console.log(tools.length, 'tools discovered');
 * ```
 */
export type MCPClientOptions = MCPClientUrlOptions | MCPClientTransportOptions;

const DEFAULT_TIMEOUT = 30_000;

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

/**
 * Connects to a Model Context Protocol server to discover and invoke tools.
 * Accepts either a server URL (with optional auth) or a pre-built
 * {@link MCPTransport}. Implements `Disposable` — use `using client = new MCPClient(...)`
 * or call `client[Symbol.dispose]()` to release transport resources when done.
 *
 * @example Discover tools from an MCP server
 * ```ts
 * import { MCPClient } from 'weft';
 *
 * using client = new MCPClient({
 *   serverUrl: 'https://tools.example.com/mcp',
 *   auth: { type: 'bearer', token: process.env['MCP_TOKEN'] ?? '' },
 * });
 *
 * const tools = await client.discoverTools();
 * console.log('Available tools:', tools.map((t) => t.name));
 * ```
 *
 * @example Invoke a specific tool
 * ```ts
 * import { MCPClient } from 'weft';
 *
 * using client = new MCPClient({ serverUrl: 'https://tools.example.com/mcp' });
 * const result = await client.invokeTool('search', { query: 'weft workflows' });
 * console.log(result);
 * ```
 */
export class MCPClient implements Disposable {
  #transport: MCPTransport;
  #timeout: number;
  #serverUrl: string;

  constructor(options: MCPClientOptions) {
    this.#timeout = options.timeout ?? DEFAULT_TIMEOUT;

    if ('transport' in options) {
      this.#transport = options.transport;
      this.#serverUrl = '(custom transport)';
    } else {
      this.#serverUrl = options.serverUrl;
      const authHeaders = options.auth ? buildAuthHeaders(options.auth) : {};
      this.#transport = new HttpTransport({
        serverUrl: options.serverUrl,
        headers: authHeaders,
        timeout: this.#timeout,
      });
    }
  }

  /** Discover available tools from the MCP server. */
  async discoverTools(): Promise<ToolDefinition[]> {
    let response;
    try {
      response = await this.#transport.send({ method: 'tools/list' });
    } catch (error) {
      if (error instanceof MCPTransportError) {
        throw new MCPServerUnavailableError(this.#serverUrl, error);
      }
      throw error;
    }

    if (response.error) {
      throw new MCPServerUnavailableError(this.#serverUrl);
    }

    const body = response.result as { tools?: unknown[] } | undefined;
    const tools = body?.tools ?? (body as unknown);

    if (!Array.isArray(tools)) {
      throw new MCPServerUnavailableError(this.#serverUrl);
    }

    const valid: ToolDefinition[] = [];
    const malformed: unknown[] = [];

    for (const entry of tools) {
      if (isToolDefinition(entry)) {
        valid.push(entry);
      } else {
        malformed.push(entry);
      }
    }

    if (malformed.length > 0) {
      const names = malformed.map((entry) => {
        const name = (entry as Record<string, unknown> | null)?.['name'];
        return typeof name === 'string' ? name : '<unknown>';
      });
      console.warn(`[MCP] ${malformed.length} malformed tool(s) filtered: ${names.join(', ')}`);
    }

    if (valid.length === 0 && tools.length > 0) {
      throw new Error(
        `All ${tools.length} tool(s) failed structural validation. Check that each tool has 'name' (string), 'description' (string), and 'inputSchema' (object).`,
      );
    }

    return valid;
  }

  /** Invoke a tool on the MCP server. */
  async invokeTool(toolName: string, input: unknown, signal?: AbortSignal): Promise<unknown> {
    const timeoutController = new AbortController();
    const timer = setTimeout(() => timeoutController.abort(), this.#timeout);

    const combinedSignal = signal
      ? AbortSignal.any([signal, timeoutController.signal])
      : timeoutController.signal;

    try {
      const response = await this.#transport.send(
        { method: 'tools/invoke', params: { name: toolName, input } },
        combinedSignal,
      );

      if (response.error) {
        throw new MCPServerUnavailableError(this.#serverUrl);
      }

      const body = response.result as { result?: unknown } | undefined;
      return body?.result ?? body;
    } catch (error) {
      if (error instanceof MCPTransportError) {
        throw new MCPServerUnavailableError(this.#serverUrl, error);
      }
      if (
        error instanceof DOMException &&
        error.name === 'AbortError' &&
        timeoutController.signal.aborted
      ) {
        throw new MCPToolTimeoutError(toolName, this.#timeout);
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Health check the MCP server. */
  async healthCheck(): Promise<boolean> {
    return this.#transport.healthCheck();
  }

  [Symbol.dispose](): void {
    this.#transport[Symbol.dispose]();
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Structural validation for MCP tool definitions received from remote servers. */
function isToolDefinition(value: unknown): value is ToolDefinition {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Record<string, unknown>)['name'] === 'string' &&
    typeof (value as Record<string, unknown>)['description'] === 'string' &&
    typeof (value as Record<string, unknown>)['inputSchema'] === 'object' &&
    (value as Record<string, unknown>)['inputSchema'] !== null &&
    !Array.isArray((value as Record<string, unknown>)['inputSchema'])
  );
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Thrown when an MCP server cannot be reached or returns an error during tool
 * discovery or invocation. Carries the `serverUrl` and an optional `cause`
 * error from the transport layer for debugging connectivity failures.
 *
 * @example Catch and inspect server unavailability
 * ```ts
 * import { MCPClient, MCPServerUnavailableError } from 'weft';
 *
 * try {
 *   using client = new MCPClient({ serverUrl: 'https://tools.example.com/mcp' });
 *   await client.discoverTools();
 * } catch (error) {
 *   if (error instanceof MCPServerUnavailableError) {
 *     console.error(`MCP server unavailable: ${error.serverUrl}`);
 *   }
 * }
 * ```
 */
export class MCPServerUnavailableError extends Error {
  readonly serverUrl: string;

  constructor(serverUrl: string, cause?: Error) {
    super(`MCP server unavailable: ${serverUrl}`);
    this.name = 'MCPServerUnavailableError';
    this.serverUrl = serverUrl;
    if (cause) {
      this.cause = cause;
    }
  }
}

/**
 * Thrown when a `tools/invoke` call to an MCP server exceeds the configured
 * timeout. Carries the `toolName` and `timeout` (ms) so callers can distinguish
 * timeouts from other tool errors and apply different retry or fallback strategies.
 *
 * @example Handle tool timeouts with a fallback
 * ```ts
 * import { MCPClient, MCPToolTimeoutError } from 'weft';
 *
 * async function runQuery(): Promise<unknown> {
 *   try {
 *     using client = new MCPClient({ serverUrl: 'https://tools.example.com/mcp', timeout: 5_000 });
 *     return await client.invokeTool('slow_query', { id: 42 });
 *   } catch (error) {
 *     if (error instanceof MCPToolTimeoutError) {
 *       console.warn(`Tool '${error.toolName}' timed out after ${error.timeout}ms`);
 *     }
 *     return null;
 *   }
 * }
 * void runQuery;
 * ```
 */
export class MCPToolTimeoutError extends Error {
  readonly toolName: string;
  readonly timeout: number;

  constructor(toolName: string, timeout: number) {
    super(`MCP tool "${toolName}" timed out after ${timeout}ms`);
    this.name = 'MCPToolTimeoutError';
    this.toolName = toolName;
    this.timeout = timeout;
  }
}
