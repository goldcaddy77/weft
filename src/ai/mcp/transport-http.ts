/**
 * HTTP transport for MCP servers.
 *
 * Maps MCP JSON-RPC methods to REST endpoints:
 * - `tools/list`    → `GET  /tools`
 * - `tools/invoke`  → `POST /tools/invoke`
 * - `health`        → `GET  /health`
 */

import type { MCPRequest, MCPResponse, MCPTransport } from './transport';

import { MCPTransportError } from './transport';

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/**
 * Static headers or an async factory that refreshes per-request (e.g., OAuth2 tokens).
 *
 * When a function is provided it is called before every HTTP request so that
 * short-lived credentials (OAuth2 tokens, signed URLs) are always fresh.
 *
 * @example Dynamic header source using an OAuth2 token manager
 * ```ts
 * import type { HeaderSource } from 'weft';
 * import { createOAuth2TokenManager } from 'weft';
 *
 * const manager = createOAuth2TokenManager({
 *   tokenEndpoint: 'https://auth.example.com/token',
 *   clientId: process.env['CLIENT_ID'] ?? '',
 *   clientSecret: process.env['CLIENT_SECRET'] ?? '',
 * });
 *
 * const source: HeaderSource = async () => ({
 *   Authorization: `Bearer ${await manager.getAccessToken()}`,
 * });
 * ```
 */
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

    // Only apply transport-level timeout when no external signal is provided.
    // When an external signal exists (e.g., from MCPClient), trust it to handle
    // timeouts — adding a second timer creates a race that produces wrong error types.
    let effectiveSignal = signal;
    let timer: ReturnType<typeof setTimeout> | undefined;

    if (!signal) {
      const timeoutController = new AbortController();
      timer = setTimeout(timeoutController.abort.bind(timeoutController), this.#timeout);
      effectiveSignal = timeoutController.signal;
    }

    try {
      const fetchInit: RequestInit = {
        ...init,
        headers: {
          'Content-Type': 'application/json',
          ...headers,
          ...(init.headers as Record<string, string> | undefined),
        },
      };
      if (effectiveSignal) fetchInit.signal = effectiveSignal;

      const response = await fetch(`${this.#serverUrl}${path}`, fetchInit);

      if (!response.ok) {
        throw new MCPTransportError(`HTTP ${response.status} from ${this.#serverUrl}${path}`);
      }

      let body: Record<string, unknown>;
      try {
        body = (await response.json()) as Record<string, unknown>;
      } catch (cause) {
        throw new MCPTransportError(`Invalid JSON response from ${this.#serverUrl}${path}`, {
          cause,
        });
      }
      return { result: body };
    } catch (error) {
      if (error instanceof MCPTransportError) throw error;
      if (error instanceof DOMException && error.name === 'AbortError' && !signal) {
        throw new MCPTransportError(`Request timed out after ${this.#timeout}ms`, {
          cause: error,
        });
      }
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async healthCheck(): Promise<boolean> {
    const controller = new AbortController();
    const timer = setTimeout(controller.abort.bind(controller), this.#timeout);
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
