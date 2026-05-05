import type {
  MessageName,
  QueryDefinition,
  SearchAttributeValue,
  SignalDefinition,
  UpdateDefinition,
  WorkflowEvent,
} from '../core/types.ts';
import { messageName } from '../core/types.ts';
import type { HttpClient } from './http-client.ts';
import { HttpClientError, request } from './http-request.ts';
import type { ClientHandle } from './interface.ts';

export class HttpHandle implements ClientHandle {
  readonly id: string;
  readonly #client: HttpClient;
  readonly #events = new EventTarget();
  #pollTimer: ReturnType<typeof setInterval> | null = null;
  #lastEventIndex = 0;
  #pollInFlight = false;
  #closed = false;

  constructor(id: string, client: HttpClient) {
    this.id = id;
    this.#client = client;
  }

  #ensurePolling(): void {
    if (this.#closed || this.#pollTimer !== null) return;
    this.#pollTimer = setInterval(() => void this.#pollEvents(), 2_000);
    void this.#pollEvents();
  }

  static readonly #TERMINAL_EVENTS = new Set<WorkflowEvent['type']>([
    'workflow:completed',
    'workflow:failed',
    'workflow:cancelled',
    'workflow:timed-out',
  ]);

  async #pollEvents(): Promise<void> {
    if (this.#pollInFlight) return;
    this.#pollInFlight = true;
    try {
      const events = await this.#client.getEvents(this.id);
      if (events.length === 0 && this.#lastEventIndex > 0) {
        const state = await this.#client.get(this.id);
        if (state === null) {
          this.close();
          return;
        }
      }
      const newEvents = events.slice(this.#lastEventIndex);
      for (const event of newEvents) {
        this.#lastEventIndex++;
        this.#events.dispatchEvent(new CustomEvent(event.type, { detail: event.data }));
        if (HttpHandle.#TERMINAL_EVENTS.has(event.type)) {
          this.close();
          return;
        }
      }
    } catch (error) {
      console.warn('[weft] Event poll error:', error);
    } finally {
      this.#pollInFlight = false;
    }
  }

  /** Stop event polling and release resources. Cannot be restarted. */
  close(): void {
    this.#closed = true;
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

  async signal(name: SignalDefinition): Promise<void>;
  async signal<TInput>(name: SignalDefinition<TInput>, payload: TInput): Promise<void>;
  async signal(name: string, payload?: unknown): Promise<void>;
  async signal(nameOrDefinition: MessageName, payload?: unknown): Promise<void> {
    return this.#client.signal(this.id, messageName(nameOrDefinition), payload);
  }

  async update<TOutput>(
    name: UpdateDefinition<void, TOutput>,
    payload?: void,
    options?: { timeout?: number },
  ): Promise<TOutput>;
  async update<TInput, TOutput>(
    name: UpdateDefinition<TInput, TOutput>,
    payload: TInput,
    options?: { timeout?: number },
  ): Promise<TOutput>;
  async update(name: string, payload?: unknown, options?: { timeout?: number }): Promise<unknown>;
  async update(
    nameOrDefinition: MessageName,
    payload?: unknown,
    options?: { timeout?: number },
  ): Promise<unknown> {
    return this.#client.update(this.id, messageName(nameOrDefinition), payload, options);
  }

  async query<TOutput>(name: QueryDefinition<void, TOutput>): Promise<TOutput>;
  async query<TInput, TOutput>(
    name: QueryDefinition<TInput, TOutput>,
    input: TInput,
  ): Promise<TOutput>;
  async query(name: string, input?: unknown): Promise<unknown>;
  async query(nameOrDefinition: MessageName, input?: unknown): Promise<unknown> {
    return this.#client.query(this.id, messageName(nameOrDefinition), input);
  }

  async getAttributes(): Promise<Record<string, SearchAttributeValue> | null> {
    return this.#client.getAttributes(this.id);
  }

  async setAttributes(attributes: Record<string, SearchAttributeValue>): Promise<void> {
    return this.#client.setAttributes(this.id, attributes);
  }

  async addTags(...tags: string[]): Promise<void> {
    return this.#client.addTags(this.id, ...tags);
  }

  async removeTags(...tags: string[]): Promise<void> {
    return this.#client.removeTags(this.id, ...tags);
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
