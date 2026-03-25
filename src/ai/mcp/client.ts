import type { ToolDefinition } from '../providers/types';
import type { MCPAuthConfig } from './authentication';

import { buildAuthHeaders } from './authentication';

export interface MCPClientOptions {
  serverUrl: string;
  auth?: MCPAuthConfig;
  timeout?: number;
}

const DEFAULT_TIMEOUT = 30_000;

export class MCPClient {
  #options: MCPClientOptions;

  constructor(options: MCPClientOptions) {
    this.#options = options;
  }

  /** Discover available tools from the MCP server. */
  async discoverTools(): Promise<ToolDefinition[]> {
    const response = await this.#fetch('/tools', { method: 'GET' });

    if (!response.ok) {
      throw new MCPServerUnavailableError(this.#options.serverUrl);
    }

    const body = (await response.json()) as { tools: ToolDefinition[] };
    return body.tools;
  }

  /** Invoke a tool on the MCP server. */
  async invokeTool(toolName: string, input: unknown, signal?: AbortSignal): Promise<unknown> {
    const timeout = this.#options.timeout ?? DEFAULT_TIMEOUT;
    const timeoutController = new AbortController();
    const timer = setTimeout(() => timeoutController.abort(), timeout);

    const combinedSignal = signal
      ? AbortSignal.any([signal, timeoutController.signal])
      : timeoutController.signal;

    try {
      const response = await this.#fetch('/tools/invoke', {
        method: 'POST',
        body: JSON.stringify({ name: toolName, input }),
        signal: combinedSignal,
      });

      if (!response.ok) {
        throw new MCPServerUnavailableError(this.#options.serverUrl);
      }

      const body = (await response.json()) as { result: unknown };
      return body.result;
    } catch (error) {
      if (
        error instanceof DOMException &&
        error.name === 'AbortError' &&
        timeoutController.signal.aborted
      ) {
        throw new MCPToolTimeoutError(toolName, timeout);
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Health check the MCP server. */
  async healthCheck(): Promise<boolean> {
    try {
      const response = await this.#fetch('/health', { method: 'GET' });
      return response.ok;
    } catch {
      return false;
    }
  }

  async #fetch(path: string, init: RequestInit): Promise<Response> {
    const url = `${this.#options.serverUrl}${path}`;
    const authHeaders = this.#options.auth ? buildAuthHeaders(this.#options.auth) : {};

    return fetch(url, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        ...authHeaders,
        ...(init.headers as Record<string, string> | undefined),
      },
    });
  }
}

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
