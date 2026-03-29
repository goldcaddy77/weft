/**
 * HTTP client for a remote Weft server. Communicates over the REST API
 * exposed by {@link handleRequest}.
 *
 * Implements the same {@link WeftClient} interface as {@link LocalClient},
 * so switching from server mode to library mode is a constructor change.
 *
 * @module client/index
 */

import type { BudgetPolicyOptions } from '../ai/budget-policy.ts';
import type {
  CoordinatedUpdateResult,
  ListFilter,
  PaginatedResult,
  SearchAttributeValue,
  StartOptions,
  SubmitReviewOptions,
  WorkflowEvent,
  WorkflowState,
  WorkflowSummary,
} from '../core/types.ts';
import type { ClientHandle, UpdateResult, WeftClient } from './interface.ts';

// ---------------------------------------------------------------------------
// Re-exports so consumers can import everything from `weft/client`
// ---------------------------------------------------------------------------

export type { ClientHandle, UpdateResult, WeftClient } from './interface.ts';

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/** Configuration for the HTTP client. */
export interface HttpClientOptions {
  /** Base URL of the Weft server (e.g. `http://localhost:3000`). */
  baseUrl: string;
  /** Optional headers to include on every request (e.g. auth tokens). */
  headers?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Error
// ---------------------------------------------------------------------------

/** Error thrown when the server returns a non-2xx response. */
export class HttpClientError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'HttpClientError';
    this.status = status;
  }
}

// ---------------------------------------------------------------------------
// Internal fetch helper
// ---------------------------------------------------------------------------

async function request<T>(
  baseUrl: string,
  path: string,
  baseHeaders: Record<string, string>,
  options?: RequestInit,
): Promise<T> {
  const headers = new Headers(baseHeaders);

  if (options?.headers) {
    const extra = new Headers(options.headers);
    for (const [key, value] of extra) {
      headers.set(key, value);
    }
  }

  if (options?.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  const response = await fetch(`${baseUrl}/v1${path}`, { ...options, headers });

  if (!response.ok) {
    // 404 on a GET for a single resource means "not found" — return null upstream
    if (response.status === 404 && (!options?.method || options.method === 'GET')) {
      return null as T;
    }

    let message = response.statusText;
    try {
      const body = (await response.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch {
      // fall back to statusText
    }
    throw new HttpClientError(response.status, message);
  }

  if (response.status === 204) return undefined as T;

  return response.json() as Promise<T>;
}

// ---------------------------------------------------------------------------
// HttpHandle — remote workflow handle
// ---------------------------------------------------------------------------

class HttpHandle implements ClientHandle {
  readonly id: string;
  readonly #client: HttpClient;
  readonly #events = new EventTarget();
  #pollTimer: ReturnType<typeof setInterval> | null = null;
  #lastEventIndex = 0;

  constructor(id: string, client: HttpClient) {
    this.id = id;
    this.#client = client;
  }

  /** Start polling for events if not already running. */
  #ensurePolling(): void {
    if (this.#pollTimer !== null) return;
    this.#pollTimer = setInterval(() => void this.#pollEvents(), 2_000);
  }

  async #pollEvents(): Promise<void> {
    try {
      const events = await this.#client.getEvents(this.id);
      const newEvents = events.slice(this.#lastEventIndex);
      for (const event of newEvents) {
        this.#lastEventIndex++;
        this.#events.dispatchEvent(new CustomEvent(event.type, { detail: event.data }));
      }
    } catch (error) {
      if (error instanceof HttpClientError && error.status === 404) {
        // Workflow completed or deleted — stop polling.
        this.close();
      } else {
        console.warn('[weft] Event poll error:', error);
      }
    }
  }

  /** Stop event polling and release resources. */
  close(): void {
    if (this.#pollTimer !== null) {
      clearInterval(this.#pollTimer);
      this.#pollTimer = null;
    }
  }

  [Symbol.dispose](): void {
    this.close();
  }

  async result(): Promise<unknown> {
    const response = await request<{ result: unknown } | null>(
      this.#client.baseUrl,
      `/workflows/${encodeURIComponent(this.id)}/result`,
      this.#client.headers,
    );
    if (response === null) {
      throw new HttpClientError(404, `Workflow "${this.id}" not found`);
    }
    return response.result;
  }

  async cancel(): Promise<void> {
    return this.#client.cancel(this.id);
  }

  async signal(name: string, payload?: unknown): Promise<void> {
    return this.#client.signal(this.id, name, payload);
  }

  async update(name: string, payload?: unknown, options?: { timeout?: number }): Promise<unknown> {
    return this.#client.update(this.id, name, payload, options);
  }

  async query(name: string): Promise<unknown> {
    return this.#client.query(this.id, name);
  }

  addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions,
  ): void {
    this.#ensurePolling();
    this.#events.addEventListener(type, listener, options);
  }

  removeEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | EventListenerOptions,
  ): void {
    this.#events.removeEventListener(type, listener, options);
  }
}

// ---------------------------------------------------------------------------
// HttpClient
// ---------------------------------------------------------------------------

/** Remote Weft client backed by HTTP requests. */
export class HttpClient implements WeftClient {
  /** @internal Exposed for handle access. */
  readonly baseUrl: string;
  /** @internal Exposed for handle access. */
  readonly headers: Record<string, string>;

  constructor(options: HttpClientOptions) {
    // Strip trailing slash
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.headers = options.headers ?? {};
  }

  async start(type: string, input: unknown, options?: StartOptions): Promise<ClientHandle> {
    const body: Record<string, unknown> = { type, input };
    if (options?.id !== undefined) body['id'] = options.id;
    if (options?.executionTimeout !== undefined)
      body['executionTimeout'] = options.executionTimeout;
    if (options?.searchAttributes !== undefined)
      body['searchAttributes'] = options.searchAttributes;
    if (options?.idempotencyKey !== undefined) body['idempotencyKey'] = options.idempotencyKey;

    const response = await request<{ id: string }>(this.baseUrl, '/workflows', this.headers, {
      method: 'POST',
      body: JSON.stringify(body),
    });

    return new HttpHandle(response.id, this);
  }

  async get(id: string): Promise<WorkflowState | null> {
    return request<WorkflowState | null>(
      this.baseUrl,
      `/workflows/${encodeURIComponent(id)}`,
      this.headers,
    );
  }

  async list(filter?: ListFilter): Promise<PaginatedResult<WorkflowSummary>> {
    const params = new URLSearchParams();

    if (filter?.status !== undefined) {
      const statuses = Array.isArray(filter.status) ? filter.status : [filter.status];
      for (const s of statuses) {
        if (s) params.append('status', s);
      }
    }
    if (filter?.type !== undefined) params.set('type', filter.type);
    if (filter?.limit !== undefined) params.set('limit', String(filter.limit));
    if (filter?.offset !== undefined) params.set('offset', String(filter.offset));
    if (filter?.attributes !== undefined)
      params.set('attributes', JSON.stringify(filter.attributes));

    const query = params.toString();
    const path = query ? `/workflows?${query}` : '/workflows';

    return request<PaginatedResult<WorkflowSummary>>(this.baseUrl, path, this.headers);
  }

  async cancel(id: string): Promise<void> {
    return request<void>(this.baseUrl, `/workflows/${encodeURIComponent(id)}`, this.headers, {
      method: 'DELETE',
    });
  }

  async signal(id: string, name: string, payload?: unknown): Promise<void> {
    await request<unknown>(
      this.baseUrl,
      `/workflows/${encodeURIComponent(id)}/signal/${encodeURIComponent(name)}`,
      this.headers,
      {
        method: 'POST',
        body: JSON.stringify({ payload }),
      },
    );
  }

  async query(id: string, name: string): Promise<unknown> {
    const response = await request<{ result: unknown }>(
      this.baseUrl,
      `/workflows/${encodeURIComponent(id)}/query/${encodeURIComponent(name)}`,
      this.headers,
    );
    return response?.result;
  }

  async update(
    id: string,
    name: string,
    payload?: unknown,
    options?: { timeout?: number },
  ): Promise<unknown> {
    const body: Record<string, unknown> = { payload };
    if (options?.timeout !== undefined) body['timeout'] = options.timeout;

    const response = await request<{ result: unknown }>(
      this.baseUrl,
      `/workflows/${encodeURIComponent(id)}/update/${encodeURIComponent(name)}`,
      this.headers,
      {
        method: 'POST',
        body: JSON.stringify(body),
      },
    );
    return response?.result;
  }

  async resume(id: string): Promise<ClientHandle> {
    const response = await request<{ id: string }>(
      this.baseUrl,
      `/workflows/${encodeURIComponent(id)}/resume`,
      this.headers,
      { method: 'POST' },
    );
    return new HttpHandle(response.id, this);
  }

  async recoverAll(): Promise<ClientHandle[]> {
    const response = await request<{ recovered: string[] }>(
      this.baseUrl,
      '/recover',
      this.headers,
      { method: 'POST' },
    );
    return response.recovered.map((id) => new HttpHandle(id, this));
  }

  async timeout(id: string): Promise<void> {
    return request<void>(
      this.baseUrl,
      `/workflows/${encodeURIComponent(id)}/timeout`,
      this.headers,
      { method: 'POST' },
    );
  }

  async getAttributes(id: string): Promise<Record<string, SearchAttributeValue> | null> {
    return request<Record<string, SearchAttributeValue> | null>(
      this.baseUrl,
      `/workflows/${encodeURIComponent(id)}/attributes`,
      this.headers,
    );
  }

  async setAttributes(id: string, attributes: Record<string, SearchAttributeValue>): Promise<void> {
    await request<unknown>(
      this.baseUrl,
      `/workflows/${encodeURIComponent(id)}/attributes`,
      this.headers,
      {
        method: 'PATCH',
        body: JSON.stringify({ attributes }),
      },
    );
  }

  async getEvents(id: string): Promise<WorkflowEvent[]> {
    const response = await request<{ events: WorkflowEvent[] } | null>(
      this.baseUrl,
      `/workflows/${encodeURIComponent(id)}/events`,
      this.headers,
    );
    if (response === null) return [];
    return response.events;
  }

  async listReviews(): Promise<Array<Record<string, unknown>>> {
    const response = await request<{ items: Array<Record<string, unknown>> }>(
      this.baseUrl,
      '/reviews',
      this.headers,
    );
    return response.items;
  }

  async submitReview(reviewId: string, options: SubmitReviewOptions): Promise<void> {
    await request<unknown>(
      this.baseUrl,
      `/reviews/${encodeURIComponent(reviewId)}/decision`,
      this.headers,
      {
        method: 'POST',
        body: JSON.stringify(options),
      },
    );
  }

  async setBudgetPolicy(options: BudgetPolicyOptions): Promise<void> {
    await request<unknown>(this.baseUrl, '/budget-policy', this.headers, {
      method: 'PUT',
      body: JSON.stringify(options),
    });
  }

  async getBudgetPolicy(namespace: string): Promise<BudgetPolicyOptions | null> {
    return request<BudgetPolicyOptions | null>(
      this.baseUrl,
      `/budget-policy/${encodeURIComponent(namespace)}`,
      this.headers,
    );
  }

  async getStreamChunks(workflowId: string, key: string): Promise<unknown[]> {
    const response = await request<{ chunks: unknown[] }>(
      this.baseUrl,
      `/workflows/${encodeURIComponent(workflowId)}/streams/${encodeURIComponent(key)}`,
      this.headers,
    );
    return response.chunks;
  }

  async submitCoordinatedUpdate(
    id: string,
    name: string,
    payload?: unknown,
    options?: { timeout?: number; idempotencyKey?: string },
  ): Promise<CoordinatedUpdateResult> {
    const body: Record<string, unknown> = { payload };
    if (options?.timeout !== undefined) body['timeout'] = options.timeout;
    if (options?.idempotencyKey !== undefined) body['idempotencyKey'] = options.idempotencyKey;

    try {
      return await request<CoordinatedUpdateResult>(
        this.baseUrl,
        `/workflows/${encodeURIComponent(id)}/update/${encodeURIComponent(name)}`,
        this.headers,
        {
          method: 'POST',
          body: JSON.stringify(body),
        },
      );
    } catch (error) {
      // Only convert business-level rejections (400/422) into error results.
      // Transport errors (401, 500, etc.) should propagate to the caller.
      if (error instanceof HttpClientError && (error.status === 400 || error.status === 422)) {
        return { updateId: '', error: error.message };
      }
      throw error;
    }
  }

  async getUpdateResult(updateId: string): Promise<UpdateResult> {
    const response = await request<{ status: string; result?: unknown; error?: string } | null>(
      this.baseUrl,
      `/updates/${encodeURIComponent(updateId)}`,
      this.headers,
    );

    if (response === null || response.status === 'pending') return null;

    const out: NonNullable<UpdateResult> = { updateId };
    if (response.result !== undefined) out.result = response.result;
    if (response.error !== undefined) out.error = response.error;
    return out;
  }
}
