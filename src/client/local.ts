/**
 * In-process client that wraps an {@link Engine} instance directly.
 * Use this when running Weft as an embedded library — no network hop.
 *
 * Implements the same {@link WeftClient} interface as {@link HttpClient},
 * so switching from library mode to server mode is a constructor change.
 *
 * @module client/local
 */

import type { Engine, ScheduleHandle, WorkflowHandle } from '../core/engine.ts';
import type {
  AttributeFilterKey,
  BulkCancelResult,
  BulkDeleteResult,
  BulkSignalResult,
  BulkTagResult,
  CoordinatedUpdateResult,
  ForkOptions,
  ListFilter,
  MessageName,
  PaginatedResult,
  PurgeResult,
  QueryDefinition,
  RetentionOverview,
  ReviewListEntry,
  ReviewListFilter,
  ScheduleFilter,
  ScheduleOptions,
  ScheduleSummary,
  SearchAttributeValue,
  SignalDefinition,
  StartOptions,
  SubmitReviewOptions,
  TenantQuotaUsage,
  TypedListFilter,
  UpdateDefinition,
  WorkflowEvent,
  WorkflowReplay,
  WorkflowState,
  WorkflowSummary,
  WorkflowTimelineEntry,
} from '../core/types.ts';
import { messageName } from '../core/types.ts';
import type { ClientHandle, ClientScheduleHandle, UpdateResult, WeftClient } from './interface.ts';

// ---------------------------------------------------------------------------
// LocalHandle — wraps Engine's WorkflowHandle
// ---------------------------------------------------------------------------

class LocalHandle implements ClientHandle {
  readonly id: string;
  readonly #handle: WorkflowHandle;
  readonly #client: LocalClient;

  constructor(handle: WorkflowHandle, client: LocalClient) {
    this.id = handle.id;
    this.#handle = handle;
    this.#client = client;
  }

  async result(): Promise<unknown> {
    return this.#handle.result();
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
    this.#handle.addEventListener(type, listener, options);
  }

  removeEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | EventListenerOptions,
  ): void {
    this.#handle.removeEventListener(type, listener, options);
  }

  [Symbol.dispose](): void {
    // LocalHandle has no resources to clean up — events flow through
    // the engine's EventTarget which is managed by the engine lifecycle.
  }
}

class LocalScheduleHandle implements ClientScheduleHandle {
  readonly id: string;
  readonly #handle: ScheduleHandle;
  readonly #client: LocalClient;

  constructor(handle: ScheduleHandle, client: LocalClient) {
    this.id = handle.id;
    this.#handle = handle;
    this.#client = client;
  }

  async pause(): Promise<void> {
    return this.#client.pauseSchedule(this.id);
  }

  async resume(): Promise<void> {
    return this.#client.resumeSchedule(this.id);
  }

  async cancel(): Promise<void> {
    return this.#client.cancelSchedule(this.id);
  }

  async update(newCronExpression: string): Promise<void> {
    return this.#client.updateSchedule(this.id, newCronExpression);
  }

  async describe(): Promise<ScheduleSummary | null> {
    return this.#client.getSchedule(this.id);
  }

  [Symbol.dispose](): void {
    void this.#handle;
  }
}

// ---------------------------------------------------------------------------
// LocalClient
// ---------------------------------------------------------------------------

/**
 * In-process Weft client backed by a local {@link Engine}.
 *
 * @example
 * ```ts
 * import { Engine, MemoryStorage, LocalClient, type WorkflowContext } from 'weft';
 *
 * await using engine = new Engine({ storage: new MemoryStorage() });
 * engine.register('greet', async function* (ctx: WorkflowContext, input: { name: string }) {
 *   return `Hello, ${input.name}!`;
 * });
 *
 * const client = new LocalClient(engine);
 * const handle = await client.start('greet', { name: 'World' });
 * console.log(await handle.result()); // 'Hello, World!'
 * ```
 */
export class LocalClient implements WeftClient {
  readonly #engine: Engine;

  constructor(engine: Engine) {
    this.#engine = engine;
  }

  async start(type: string, input: unknown, options?: StartOptions): Promise<ClientHandle> {
    const handle = await this.#engine.start(type, input, options);
    return new LocalHandle(handle, this);
  }

  async schedule(
    type: string,
    input: unknown,
    cronExpression: string,
    options?: ScheduleOptions,
  ): Promise<ClientScheduleHandle> {
    const handle = await this.#engine.schedule(type, input, cronExpression, options);
    return new LocalScheduleHandle(handle, this);
  }

  async get(id: string): Promise<WorkflowState | null> {
    return this.#engine.get(id);
  }

  async getSchedule(id: string): Promise<ScheduleSummary | null> {
    return this.#engine.getSchedule(id);
  }

  async list<
    const TAttributeKeys extends readonly AttributeFilterKey[] = readonly AttributeFilterKey[],
  >(filter?: TypedListFilter<TAttributeKeys>): Promise<PaginatedResult<WorkflowSummary>> {
    return this.#engine.list(filter);
  }

  async listSchedules(filter?: ScheduleFilter): Promise<PaginatedResult<ScheduleSummary>> {
    return this.#engine.listSchedules(filter);
  }

  async cancel(id: string): Promise<void> {
    return this.#engine.cancel(id);
  }

  async pauseSchedule(id: string): Promise<void> {
    return this.#engine.pauseSchedule(id);
  }

  async resumeSchedule(id: string): Promise<void> {
    return this.#engine.resumeSchedule(id);
  }

  async cancelSchedule(id: string): Promise<void> {
    return this.#engine.cancelSchedule(id);
  }

  async updateSchedule(id: string, newCronExpression: string): Promise<void> {
    return this.#engine.updateSchedule(id, newCronExpression);
  }

  async signal(id: string, name: SignalDefinition): Promise<void>;
  async signal<TInput>(id: string, name: SignalDefinition<TInput>, payload: TInput): Promise<void>;
  async signal(id: string, name: string, payload?: unknown): Promise<void>;
  async signal(id: string, nameOrDefinition: MessageName, payload?: unknown): Promise<void> {
    return this.#engine.signal(id, messageName(nameOrDefinition), payload);
  }

  async query<TOutput>(id: string, name: QueryDefinition<void, TOutput>): Promise<TOutput>;
  async query<TInput, TOutput>(
    id: string,
    name: QueryDefinition<TInput, TOutput>,
    input: TInput,
  ): Promise<TOutput>;
  async query(id: string, name: string, input?: unknown): Promise<unknown>;
  async query(id: string, nameOrDefinition: MessageName, input?: unknown): Promise<unknown> {
    return this.#engine.query(id, messageName(nameOrDefinition), input);
  }

  async update<TOutput>(
    id: string,
    name: UpdateDefinition<void, TOutput>,
    payload?: void,
    options?: { timeout?: number },
  ): Promise<TOutput>;
  async update<TInput, TOutput>(
    id: string,
    name: UpdateDefinition<TInput, TOutput>,
    payload: TInput,
    options?: { timeout?: number },
  ): Promise<TOutput>;
  async update(
    id: string,
    name: string,
    payload?: unknown,
    options?: { timeout?: number },
  ): Promise<unknown>;
  async update(
    id: string,
    nameOrDefinition: MessageName,
    payload?: unknown,
    options?: { timeout?: number },
  ): Promise<unknown> {
    return this.#engine.update(id, messageName(nameOrDefinition), payload, options);
  }

  async resume(id: string): Promise<ClientHandle> {
    const handle = await this.#engine.resume(id);
    return new LocalHandle(handle, this);
  }

  async recoverAll(): Promise<ClientHandle[]> {
    const handles = await this.#engine.recoverAll();
    return handles.map((handle) => new LocalHandle(handle, this));
  }

  async timeout(id: string): Promise<void> {
    return this.#engine.timeout(id);
  }

  async getAttributes(id: string): Promise<Record<string, SearchAttributeValue> | null> {
    return this.#engine.getAttributes(id);
  }

  async setAttributes(id: string, attributes: Record<string, SearchAttributeValue>): Promise<void> {
    return this.#engine.setAttributes(id, attributes);
  }

  async addTags(id: string, ...tags: string[]): Promise<void> {
    return this.#engine.addTags(id, ...tags);
  }

  async removeTags(id: string, ...tags: string[]): Promise<void> {
    return this.#engine.removeTags(id, ...tags);
  }

  async getEvents(id: string): Promise<WorkflowEvent[]> {
    return this.#engine.getEvents(id);
  }

  async getTimeline(id: string): Promise<WorkflowTimelineEntry[]> {
    return this.#engine.getTimeline(id);
  }

  async replayTo(id: string, step: number): Promise<WorkflowReplay | null> {
    return this.#engine.replayTo(id, step);
  }

  async listReviews(filter?: ReviewListFilter): Promise<ReviewListEntry[]> {
    return this.#engine.listReviews(filter);
  }

  async submitReview(reviewId: string, options: SubmitReviewOptions): Promise<void> {
    return this.#engine.submitReview(reviewId, options);
  }

  async getQuotaUsage(tenantId: string): Promise<TenantQuotaUsage> {
    return this.#engine.getQuotaUsage(tenantId);
  }

  async getStreamChunks(
    workflowId: string,
    key: string,
    options?: { after?: number },
  ): ReturnType<Engine['getStreamChunks']> {
    return this.#engine.getStreamChunks(workflowId, key, options);
  }

  async fork(id: string, options?: ForkOptions): Promise<ClientHandle> {
    const handle = await this.#engine.fork(id, options);
    return new LocalHandle(handle, this);
  }

  async getRetentionOverview(): Promise<RetentionOverview> {
    return this.#engine.getRetentionOverview();
  }

  async purge(filter?: ListFilter): Promise<PurgeResult> {
    return this.#engine.purge(filter);
  }

  async cancelAll(filter: ListFilter): Promise<BulkCancelResult> {
    return this.#engine.cancelAll(filter);
  }

  async signalAll(filter: ListFilter, name: string, payload?: unknown): Promise<BulkSignalResult> {
    return this.#engine.signalAll(filter, name, payload);
  }

  async deleteAll(filter: ListFilter): Promise<BulkDeleteResult> {
    return this.#engine.deleteAll(filter);
  }

  async tagAll(filter: ListFilter, tags: string[]): Promise<BulkTagResult> {
    return this.#engine.tagAll(filter, tags);
  }

  async untagAll(filter: ListFilter, tags: string[]): Promise<BulkTagResult> {
    return this.#engine.untagAll(filter, tags);
  }

  async submitCoordinatedUpdate(
    id: string,
    name: string,
    payload?: unknown,
    options?: { timeout?: number; idempotencyKey?: string },
  ): Promise<CoordinatedUpdateResult> {
    return this.#engine.submitCoordinatedUpdate(id, name, payload, options);
  }

  async getUpdateResult(updateId: string): Promise<UpdateResult> {
    const response = await this.#engine.getUpdateResult(updateId);
    if (response === null) return null;
    const out: NonNullable<UpdateResult> = { updateId: response.updateId, result: response.result };
    if (response.error !== undefined) out.error = response.error;
    return out;
  }
}
