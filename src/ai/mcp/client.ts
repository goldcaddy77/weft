import type { ToolDefinition } from '../providers/types';
import type { SyncMCPAuthConfig } from './authentication';
import type { MCPTransport } from './transport';

import { buildAuthHeaders } from './authentication';
import { MCPTransportError } from './transport';
import { HttpTransport } from './transport-http';

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/** Options to construct an HttpTransport automatically from a server URL. */
export type MCPClientUrlOptions = {
  serverUrl: string;
  /** OAuth2 is not supported via URL options — use a transport with pre-fetched headers. */
  auth?: SyncMCPAuthConfig;
  timeout?: number;
};

/** New options: bring your own transport. */
export type MCPClientTransportOptions = {
  transport: MCPTransport;
  timeout?: number | undefined;
};

export type MCPClientOptions = MCPClientUrlOptions | MCPClientTransportOptions;

const DEFAULT_TIMEOUT = 30_000;

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

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
