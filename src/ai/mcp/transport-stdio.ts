/**
 * Stdio transport for MCP servers running as local processes.
 *
 * Communicates via JSON-RPC 2.0 over newline-delimited JSON on stdin/stdout.
 * The child process is spawned lazily on the first `send()` call and killed
 * on `dispose()`.
 */

import type { MCPRequest, MCPResponse, MCPTransport } from './transport';

import { splitNewlineDelimitedBuffer } from '../../server/json-rpc-framing.ts';
import { MCPTransportError } from './transport';

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/**
 * Options for {@link StdioTransport}. Accepts the `command` path to the MCP
 * server binary, an optional `args` array forwarded to the child process, and
 * an optional `timeout` in milliseconds for individual JSON-RPC calls.
 *
 * @example Point the transport at a locally installed MCP binary
 * ```ts
 * import { StdioTransport, type StdioTransportOptions } from 'weft/mcp/stdio';
 *
 * const options: StdioTransportOptions = {
 *   command: '/usr/local/bin/my-mcp-server',
 *   args: ['--port', '0'],
 *   timeout: 10_000,
 * };
 *
 * using transport = new StdioTransport(options);
 * ```
 */
export type StdioTransportOptions = {
  command: string;
  args?: string[] | undefined;
  timeout?: number | undefined;
};

const DEFAULT_TIMEOUT = 30_000;

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

/**
 * {@link MCPTransport} that communicates with a local MCP server process over
 * stdin/stdout using newline-delimited JSON-RPC 2.0. Spawns the child process
 * lazily on the first `send()` call and kills it on `dispose()`. Use this for
 * local tool servers such as database adapters or file-system helpers.
 *
 * **Observable behaviors beyond the basic JSON-RPC contract:**
 *
 * - The child's stderr is forwarded to a warning logger with a
 *   `[weft:mcp:stdio:stderr]` prefix — useful for surfacing server-side
 *   crashes without polluting stdout.
 * - The transport's own `timeout` (default 30s) only applies when the caller
 *   does **not** pass an `AbortSignal` to `send()`. When an external signal
 *   is provided (e.g. from {@link MCPClient}), the transport defers timeout
 *   handling to that signal — adding a second timer would race and produce
 *   the wrong error type.
 * - `healthCheck()` issues a JSON-RPC `ping` request. Servers that do not
 *   implement `ping` will surface `MethodNotFound` here; treat a failure as
 *   "this server cannot answer ping," not necessarily as "server is down."
 * - Malformed JSON lines from the child are logged as warnings and dropped;
 *   they do not reject pending calls. Pending calls rely on the abort signal
 *   or the transport-level timeout to unblock.
 *
 * @example Connect a local MCP server binary to the agent loop
 * ```ts
 * import { StdioTransport } from 'weft/mcp/stdio';
 * import { MCPClient } from 'weft';
 *
 * using transport = new StdioTransport({ command: '/usr/local/bin/my-mcp-server' });
 * using client = new MCPClient({ transport });
 *
 * const healthy = await client.healthCheck();
 * if (healthy) {
 *   const tools = await client.discoverTools();
 *   console.log('Local tools:', tools.map((t) => t.name));
 * }
 * ```
 */
export class StdioTransport implements MCPTransport {
  #command: string;
  #args: string[];
  #timeout: number;
  #process: ReturnType<typeof Bun.spawn> | null = null;
  #nextId = 1;
  #pending = new Map<number, PromiseWithResolvers<MCPResponse>>();
  #buffer = '';
  #disposed = false;
  #readLoopActive = false;
  #stderrLoopActive = false;

  constructor(options: StdioTransportOptions) {
    this.#command = options.command;
    this.#args = options.args ?? [];
    this.#timeout = options.timeout ?? DEFAULT_TIMEOUT;
  }

  async send(request: MCPRequest, signal?: AbortSignal): Promise<MCPResponse> {
    if (this.#disposed) {
      throw new MCPTransportError('Transport has been disposed');
    }

    const process = this.#ensureProcess();
    const id = this.#nextId++;

    const jsonRpc = JSON.stringify({
      jsonrpc: '2.0',
      id,
      method: request.method,
      params: request.params,
    });

    const { promise, resolve, reject } = Promise.withResolvers<MCPResponse>();
    this.#pending.set(id, { promise, resolve, reject });

    // Suppress unhandled rejection — the promise may be rejected by the timeout/abort
    // handler while we're awaiting the stdin write, but we handle the error in catch.
    promise.catch(() => {});

    // Only apply transport-level timeout when no external signal is provided.
    // When an external signal exists (e.g., from MCPClient), trust it to handle
    // timeouts — adding a second timer creates a race that produces wrong error types.
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (!signal) {
      timer = setTimeout(() => {
        const pending = this.#pending.get(id);
        if (pending) {
          this.#pending.delete(id);
          pending.reject(new MCPTransportError(`Stdio request timed out after ${this.#timeout}ms`));
        }
      }, this.#timeout);
    }

    // External abort signal handling
    const abortHandler = signal
      ? () => {
          const pending = this.#pending.get(id);
          if (pending) {
            this.#pending.delete(id);
            pending.reject(new DOMException('The operation was aborted.', 'AbortError'));
          }
        }
      : undefined;

    if (abortHandler && signal) {
      signal.addEventListener('abort', abortHandler, { once: true });
    }

    try {
      const stdin = process.stdin as import('bun').FileSink;
      await stdin.write(jsonRpc + '\n');
      const result = await promise;
      return result;
    } catch (error) {
      // Clean up pending entry on any failure (write error, abort, etc.)
      this.#pending.delete(id);
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
      if (abortHandler && signal) {
        signal.removeEventListener('abort', abortHandler);
      }
    }
  }

  async healthCheck(): Promise<boolean> {
    try {
      const response = await this.send({ method: 'ping' });
      return response.error === undefined;
    } catch {
      return false;
    }
  }

  [Symbol.dispose](): void {
    this.#disposed = true;

    // Reject all pending requests
    for (const [id, pending] of this.#pending) {
      pending.reject(new MCPTransportError('Transport disposed'));
      this.#pending.delete(id);
    }

    // Kill the child process
    if (this.#process) {
      try {
        this.#process.kill();
      } catch {
        // Process may have already exited
      }
      this.#process = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  #ensureProcess(): ReturnType<typeof Bun.spawn> {
    if (this.#process) return this.#process;

    const proc = Bun.spawn([this.#command, ...this.#args], {
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    });

    this.#process = proc;

    // Start reading stdout for responses
    void this.#startReadLoop(proc);

    // Forward stderr to console.warn for debugging
    void this.#startStderrLoop(proc);

    // Handle unexpected exit
    void proc.exited.then(() => {
      if (this.#disposed) return undefined;
      this.#process = null;

      // Reject all pending requests
      for (const [id, pending] of this.#pending) {
        pending.reject(new MCPTransportError('Child process exited unexpectedly'));
        this.#pending.delete(id);
      }
      return undefined;
    });

    return proc;
  }

  async #startStderrLoop(proc: ReturnType<typeof Bun.spawn>): Promise<void> {
    const stderr = proc.stderr;
    if (!stderr) return;
    if (this.#stderrLoopActive) return;
    this.#stderrLoopActive = true;

    const reader = (stderr as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const text = decoder.decode(value, { stream: true }).trimEnd();
        if (text) {
          console.warn(`[weft:mcp:stdio:stderr] ${text}`);
        }
      }
      // Flush any trailing partial UTF-8 sequence from the streaming decoder
      const remaining = decoder.decode().trimEnd();
      if (remaining) {
        console.warn(`[weft:mcp:stdio:stderr] ${remaining}`);
      }
    } catch {
      // Stream closed — handled by process exit handler
    } finally {
      // Cancel the reader to release its lock on the underlying stream so the
      // stream can be garbage-collected when the child process exits or the
      // transport is disposed. Swallow any error — the stream may already be
      // errored or closed.
      reader.cancel().catch(() => {});
      this.#stderrLoopActive = false;
    }
  }

  async #startReadLoop(proc: ReturnType<typeof Bun.spawn>): Promise<void> {
    if (this.#readLoopActive) return;
    this.#readLoopActive = true;

    const stdout = proc.stdout as ReadableStream<Uint8Array>;
    const reader = stdout.getReader();
    const decoder = new TextDecoder();

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const framed = splitNewlineDelimitedBuffer(
          this.#buffer,
          decoder.decode(value, { stream: true }),
        );
        this.#buffer = framed.buffer;

        for (const line of framed.lines) {
          try {
            const message = JSON.parse(line) as {
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
            // Log malformed responses to aid debugging — the pending request
            // will still time out, but the operator gets a diagnostic signal.
            const preview = line.length > 200 ? line.slice(0, 200) + '…' : line;
            console.warn(`[weft:mcp:stdio] Ignoring malformed JSON from child process: ${preview}`);
          }
        }
      }
    } catch {
      // Stream closed or errored — handled by process exit handler
    } finally {
      // Cancel the reader to release its lock on the underlying stream so the
      // stream can be garbage-collected when the child process exits or the
      // transport is disposed. Swallow any error — the stream may already be
      // errored or closed.
      reader.cancel().catch(() => {});
      this.#readLoopActive = false;
    }
  }
}
