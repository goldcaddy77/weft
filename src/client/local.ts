/**
 * In-process client that wraps an {@link Engine} instance directly.
 * Use this when running Weft as an embedded library — no network hop.
 *
 * Implements the same {@link WeftClient} interface as {@link HttpClient},
 * so switching from library mode to server mode is a constructor change.
 *
 * @module client/local
 */

import type { BudgetPolicyOptions } from '../ai/budget-policy.ts';
import type { Engine, ScheduleHandle, WorkflowHandle } from '../core/engine.ts';
import type {
  BulkCancelResult,
  BulkDeleteResult,
  BulkSignalResult,
  BulkTagResult,
  CoordinatedUpdateResult,
  ForkOptions,
  ListFilter,
  PaginatedResult,
  PurgeResult,
  RetentionOverview,
  ScheduleFilter,
  ScheduleOptions,
  ScheduleSummary,
  SearchAttributeValue,
  StartOptions,
  SubmitReviewOptions,
  TenantQuotaUsage,
  WorkflowEvent,
  WorkflowReplay,
  WorkflowState,
  WorkflowSummary,
  WorkflowTimelineEntry,
} from '../core/types.ts';
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

  async signal(name: string, payload?: unknown): Promise<void> {
    return this.#client.signal(this.id, name, payload);
  }

  async update(name: string, payload?: unknown, options?: { timeout?: number }): Promise<unknown> {
    return this.#client.update(this.id, name, payload, options);
  }

  async query(name: string): Promise<unknown> {
    return this.#client.query(this.id, name);
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

/** In-process Weft client backed by a local {@link Engine}. */
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

  async list(filter?: ListFilter): Promise<PaginatedResult<WorkflowSummary>> {
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

  async signal(id: string, name: string, payload?: unknown): Promise<void> {
    return this.#engine.signal(id, name, payload);
  }

  async query(id: string, name: string): Promise<unknown> {
    return this.#engine.query(id, name);
  }

  async update(
    id: string,
    name: string,
    payload?: unknown,
    options?: { timeout?: number },
  ): Promise<unknown> {
    return this.#engine.update(id, name, payload, options);
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

  async listReviews(): Promise<Array<Record<string, unknown>>> {
    return this.#engine.listReviews();
  }

  async submitReview(reviewId: string, options: SubmitReviewOptions): Promise<void> {
    return this.#engine.submitReview(reviewId, options);
  }

  async setBudgetPolicy(options: BudgetPolicyOptions): Promise<void> {
    return this.#engine.setBudgetPolicy(options);
  }

  async getBudgetPolicy(namespace: string): Promise<BudgetPolicyOptions | null> {
    return this.#engine.getBudgetPolicy(namespace);
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

  async cancelAll(filter?: ListFilter): Promise<BulkCancelResult> {
    return this.#engine.cancelAll(filter);
  }

  async signalAll(
    filter: ListFilter | undefined,
    name: string,
    payload?: unknown,
  ): Promise<BulkSignalResult> {
    return this.#engine.signalAll(filter, name, payload);
  }

  async deleteAll(filter?: ListFilter): Promise<BulkDeleteResult> {
    return this.#engine.deleteAll(filter);
  }

  async tagAll(filter: ListFilter | undefined, tags: string[]): Promise<BulkTagResult> {
    return this.#engine.tagAll(filter, tags);
  }

  async untagAll(filter: ListFilter | undefined, tags: string[]): Promise<BulkTagResult> {
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
