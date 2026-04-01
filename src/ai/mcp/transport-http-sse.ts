/**
 * HTTP+SSE transport for MCP servers.
 *
 * Requests are sent via POST to a JSON-RPC endpoint. Responses arrive via
 * a persistent Server-Sent Events stream. Correlation uses JSON-RPC `id`
 * fields. The SSE connection is established lazily on the first `send()`.
 */

import type { MCPRequest, MCPResponse, MCPTransport } from './transport';

import { MCPTransportError } from './transport';

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export type HttpSseTransportOptions = {
  serverUrl: string;
  headers?: Record<string, string> | undefined;
  timeout?: number | undefined;
};

const DEFAULT_TIMEOUT = 30_000;

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

export class HttpSseTransport implements MCPTransport {
  #serverUrl: string;
  #headers: Record<string, string>;
  #timeout: number;
  #nextId = 1;
  #pending = new Map<number, PromiseWithResolvers<MCPResponse>>();
  #sseReader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  #sseBuffer = '';
  #connected = false;
  #disposed = false;
  #connectPromise: Promise<void> | null = null;

  constructor(options: HttpSseTransportOptions) {
    this.#serverUrl = options.serverUrl;
    this.#headers = options.headers ?? {};
    this.#timeout = options.timeout ?? DEFAULT_TIMEOUT;
  }

  async send(request: MCPRequest, signal?: AbortSignal): Promise<MCPResponse> {
    if (this.#disposed) {
      throw new MCPTransportError('Transport has been disposed');
    }

    // Ensure SSE connection is established
    await this.#ensureConnected();

    const id = this.#nextId++;
    const { promise, resolve, reject } = Promise.withResolvers<MCPResponse>();
    this.#pending.set(id, { promise, resolve, reject });

    // Timeout handling
    const timeoutId = setTimeout(() => {
      const pending = this.#pending.get(id);
      if (pending) {
        this.#pending.delete(id);
        pending.reject(new MCPTransportError(`SSE request timed out after ${this.#timeout}ms`));
      }
    }, this.#timeout);

    // External abort signal handling
    const abortHandler = signal
      ? () => {
          const pending = this.#pending.get(id);
          if (pending) {
            this.#pending.delete(id);
            clearTimeout(timeoutId);
            pending.reject(new DOMException('The operation was aborted.', 'AbortError'));
          }
        }
      : undefined;

    if (abortHandler && signal) {
      signal.addEventListener('abort', abortHandler, { once: true });
    }

    try {
      // Send request via POST
      const fetchInit: RequestInit = {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...this.#headers,
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id,
          method: request.method,
          params: request.params,
        }),
      };
      if (signal) fetchInit.signal = signal;

      const response = await fetch(`${this.#serverUrl}/jsonrpc`, fetchInit);

      if (!response.ok) {
        this.#pending.delete(id);
        clearTimeout(timeoutId);
        throw new MCPTransportError(`HTTP ${response.status} from ${this.#serverUrl}/jsonrpc`);
      }

      // Wait for the response to arrive via SSE
      const result = await promise;
      clearTimeout(timeoutId);
      return result;
    } catch (error) {
      clearTimeout(timeoutId);
      this.#pending.delete(id);
      throw error;
    } finally {
      if (abortHandler && signal) {
        signal.removeEventListener('abort', abortHandler);
      }
    }
  }

  async healthCheck(): Promise<boolean> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeout);
    try {
      const response = await fetch(`${this.#serverUrl}/health`, {
        method: 'GET',
        headers: { ...this.#headers },
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
    this.#disposed = true;
    this.#connected = false;

    // Reject all pending requests
    for (const [id, pending] of this.#pending) {
      pending.reject(new MCPTransportError('Transport disposed'));
      this.#pending.delete(id);
    }

    // Close the SSE stream
    if (this.#sseReader) {
      try {
        void this.#sseReader.cancel();
      } catch {
        // Reader may already be closed
      }
      this.#sseReader = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Internal: SSE connection
  // ---------------------------------------------------------------------------

  async #ensureConnected(): Promise<void> {
    if (this.#connected) return;

    // Share a single connection attempt across concurrent callers
    if (this.#connectPromise) {
      return this.#connectPromise;
    }

    this.#connectPromise = this.#connect();
    try {
      await this.#connectPromise;
    } finally {
      this.#connectPromise = null;
    }
  }

  async #connect(): Promise<void> {
    const response = await fetch(`${this.#serverUrl}/sse`, {
      method: 'GET',
      headers: {
        Accept: 'text/event-stream',
        ...this.#headers,
      },
    });

    if (!response.ok || !response.body) {
      throw new MCPTransportError(`Failed to establish SSE connection to ${this.#serverUrl}/sse`);
    }

    this.#sseReader = response.body.getReader();
    this.#connected = true;
    this.#sseBuffer = '';

    // Start reading the SSE stream in the background
    void this.#readLoop();
  }

  async #readLoop(): Promise<void> {
    const decoder = new TextDecoder();

    try {
      while (this.#sseReader && !this.#disposed) {
        const { done, value } = await this.#sseReader.read();
        if (done) break;

        this.#sseBuffer += decoder.decode(value, { stream: true });
        this.#processBuffer();
      }
    } catch {
      // Stream closed or errored
    } finally {
      this.#connected = false;

      if (!this.#disposed) {
        // Reject pending requests on unexpected disconnect
        for (const [id, pending] of this.#pending) {
          pending.reject(new MCPTransportError('SSE connection closed'));
          this.#pending.delete(id);
        }
      }
    }
  }

  #processBuffer(): void {
    // SSE events are separated by double newlines
    let eventEnd: number;
    while ((eventEnd = this.#sseBuffer.indexOf('\n\n')) !== -1) {
      const eventText = this.#sseBuffer.slice(0, eventEnd);
      this.#sseBuffer = this.#sseBuffer.slice(eventEnd + 2);

      // Parse SSE event: extract `data:` lines
      const dataLines: string[] = [];
      for (const line of eventText.split('\n')) {
        if (line.startsWith('data:')) {
          dataLines.push(line.slice(5).trimStart());
        }
      }

      if (dataLines.length === 0) continue;

      const data = dataLines.join('\n');
      try {
        const message = JSON.parse(data) as {
          id?: number;
          result?: unknown;
          error?: { code: number; message: string };
        };

        if (typeof message.id === 'number') {
          const pending = this.#pending.get(message.id);
          if (pending) {
            this.#pending.delete(message.id);
            const response: MCPResponse = { result: message.result };
            if (message.error) response.error = message.error;
            pending.resolve(response);
          }
        }
      } catch {
        // Ignore non-JSON events
      }
    }
  }
}
