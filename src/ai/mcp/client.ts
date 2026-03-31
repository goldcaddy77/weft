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
    const response = await this.#fetchWithTimeout('/tools', { method: 'GET' });

    if (!response.ok) {
      throw new MCPServerUnavailableError(this.#options.serverUrl);
    }

    const body = (await response.json()) as { tools: unknown[] };
    if (!Array.isArray(body.tools)) {
      throw new MCPServerUnavailableError(this.#options.serverUrl);
    }

    return body.tools.filter(isToolDefinition);
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
      const response = await this.#fetchWithTimeout('/health', { method: 'GET' });
      return response.ok;
    } catch {
      return false;
    }
  }

  /** Fetch with the configured timeout applied via AbortController. */
  async #fetchWithTimeout(path: string, init: RequestInit): Promise<Response> {
    const timeout = this.#options.timeout ?? DEFAULT_TIMEOUT;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      return await this.#fetch(path, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
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
