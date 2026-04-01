/**
 * HTTP transport for MCP servers.
 *
 * Maps MCP JSON-RPC methods to REST endpoints:
 * - `tools/list`   → `GET  /tools`
 * - `tools/invoke`  → `POST /tools/invoke`
 * - `initialize`    → `GET  /health`
 */

import type { MCPRequest, MCPResponse, MCPTransport } from './transport';

import { MCPTransportError } from './transport';

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/** Static headers or an async factory that refreshes per-request (e.g., OAuth2 tokens). */
export type HeaderSource = Record<string, string> | (() => Promise<Record<string, string>>);

export type HttpTransportOptions = {
  serverUrl: string;
  headers?: HeaderSource | undefined;
  timeout?: number | undefined;
};

const DEFAULT_TIMEOUT = 30_000;

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

export class HttpTransport implements MCPTransport {
  #serverUrl: string;
  #headerSource: HeaderSource;
  #timeout: number;

  constructor(options: HttpTransportOptions) {
    this.#serverUrl = options.serverUrl;
    this.#headerSource = options.headers ?? {};
    this.#timeout = options.timeout ?? DEFAULT_TIMEOUT;
  }

  async send(request: MCPRequest, signal?: AbortSignal): Promise<MCPResponse> {
    const { path, init } = this.#buildRequest(request);
    const headers =
      typeof this.#headerSource === 'function' ? await this.#headerSource() : this.#headerSource;

    const timeoutController = new AbortController();
    const timer = setTimeout(() => timeoutController.abort(), this.#timeout);

    const combinedSignal = signal
      ? AbortSignal.any([signal, timeoutController.signal])
      : timeoutController.signal;

    try {
      const response = await fetch(`${this.#serverUrl}${path}`, {
        ...init,
        signal: combinedSignal,
        headers: {
          'Content-Type': 'application/json',
          ...headers,
          ...(init.headers as Record<string, string> | undefined),
        },
      });

      if (!response.ok) {
        throw new MCPTransportError(`HTTP ${response.status} from ${this.#serverUrl}${path}`);
      }

      const body = (await response.json()) as Record<string, unknown>;
      return { result: body };
    } catch (error) {
      if (error instanceof MCPTransportError) throw error;
      if (
        error instanceof DOMException &&
        error.name === 'AbortError' &&
        timeoutController.signal.aborted &&
        !signal?.aborted
      ) {
        throw new MCPTransportError(`Request timed out after ${this.#timeout}ms`, {
          cause: error,
        });
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async healthCheck(): Promise<boolean> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeout);
    try {
      const headers =
        typeof this.#headerSource === 'function' ? await this.#headerSource() : this.#headerSource;
      const response = await fetch(`${this.#serverUrl}/health`, {
        method: 'GET',
        headers: { ...headers },
        signal: controller.signal,
      });
      return response.ok;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  [Symbol.dispose](): void {
    // HTTP transport is stateless — nothing to clean up.
  }

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  /** Map MCP method names to REST paths and HTTP methods. */
  #buildRequest(request: MCPRequest): { path: string; init: RequestInit } {
    switch (request.method) {
      case 'tools/list':
        return { path: '/tools', init: { method: 'GET' } };
      case 'tools/invoke':
        return {
          path: '/tools/invoke',
          init: { method: 'POST', body: JSON.stringify(request.params) },
        };
      case 'health':
        return { path: '/health', init: { method: 'GET' } };
      default:
        return {
          path: `/${request.method}`,
          init: { method: 'POST', body: JSON.stringify(request.params) },
        };
    }
  }
}
