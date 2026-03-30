/**
 * Synchronous update request/response coordination.
 *
 * Manages the lifecycle of workflow updates with idempotency support,
 * timeout-based waiting, and automatic cleanup of expired responses.
 *
 * @module updates
 */

import type { BatchOperation, Storage } from '../storage/interface';
import { KEYS } from '../storage/interface';
import { decode, encode } from './codec';
import type { WorkflowStatus } from './types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface UpdateRequest {
  updateId: string;
  workflowId: string;
  name: string;
  payload: unknown;
  idempotencyKey?: string | undefined;
  createdAt: number;
}

export interface UpdateResponse {
  updateId: string;
  result?: unknown;
  error?: string | undefined;
  createdAt: number;
}

export interface UpdateRequestOptions {
  idempotencyKey?: string;
  timeout?: number;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class UpdateTimeoutError extends Error {
  readonly updateId: string;

  constructor(updateId: string, timeout: number) {
    super(`Update ${updateId} timed out after ${timeout}ms`);
    this.name = 'UpdateTimeoutError';
    this.updateId = updateId;
  }
}

export class WorkflowTerminalError extends Error {
  readonly workflowId: string;
  readonly status: WorkflowStatus;

  constructor(workflowId: string, status: WorkflowStatus) {
    super(
      `Cannot send update to workflow "${workflowId}": workflow is in terminal state "${status}"`,
    );
    this.name = 'WorkflowTerminalError';
    this.workflowId = workflowId;
    this.status = status;
  }
}

// ---------------------------------------------------------------------------
// Coordinator
// ---------------------------------------------------------------------------

const POLL_INTERVAL_MS = 50;
const DEFAULT_CLEANUP_TTL_MS = 5 * 60 * 1000; // 5 minutes

export class UpdateCoordinator {
  #storage: Storage;

  constructor(storage: Storage) {
    this.#storage = storage;
  }

  /** Create and persist an update request. Returns the update ID. */
  async createRequest(
    workflowId: string,
    name: string,
    payload: unknown,
    options?: UpdateRequestOptions,
  ): Promise<string> {
    const updateId = crypto.randomUUID();

    const request: UpdateRequest = {
      updateId,
      workflowId,
      name,
      payload,
      createdAt: Date.now(),
    };

    if (options?.idempotencyKey !== undefined) {
      request.idempotencyKey = options.idempotencyKey;
    }

    const key = KEYS.update(workflowId, updateId);
    await this.#storage.put(key, encode(request));

    return updateId;
  }

  /** Check idempotency: if this key was already processed, return the existing response. */
  async checkIdempotency(
    workflowId: string,
    idempotencyKey: string,
  ): Promise<UpdateResponse | null> {
    const key = KEYS.updateIdempotency(workflowId, idempotencyKey);
    const raw = await this.#storage.get(key);
    if (!raw) return null;

    const mapping = decode(raw) as { updateId: string };
    return this.getResponse(mapping.updateId);
  }

  /** Get pending update requests for a workflow. */
  async getPendingUpdates(workflowId: string): Promise<UpdateRequest[]> {
    const prefix = `upd:${workflowId}:`;
    const results: UpdateRequest[] = [];

    for await (const [, value] of this.#storage.scan(prefix)) {
      results.push(decode(value) as UpdateRequest);
    }

    return results;
  }

  /** Build batch operations for persisting an update response (to be included in checkpoint batch). */
  buildResponseOperations(
    updateId: string,
    workflowId: string,
    result: unknown,
    error?: string,
    idempotencyKey?: string,
  ): BatchOperation[] {
    const response: UpdateResponse = {
      updateId,
      result,
      createdAt: Date.now(),
    };

    if (error !== undefined) {
      response.error = error;
    }

    const operations: BatchOperation[] = [
      { type: 'delete', key: KEYS.update(workflowId, updateId) },
      { type: 'put', key: KEYS.updateResponse(updateId), value: encode(response) },
    ];

    if (idempotencyKey !== undefined) {
      operations.push({
        type: 'put',
        key: KEYS.updateIdempotency(workflowId, idempotencyKey),
        value: encode({ updateId }),
      });
    }

    return operations;
  }

  /** Retrieve a stored response by update ID. */
  async getResponse(updateId: string): Promise<UpdateResponse | null> {
    const key = KEYS.updateResponse(updateId);
    const raw = await this.#storage.get(key);
    if (!raw) return null;

    return decode(raw) as UpdateResponse;
  }

  /** Wait for an update response with timeout. Uses polling. */
  async waitForResponse(updateId: string, timeout: number): Promise<UpdateResponse> {
    const deadline = Date.now() + timeout;

    while (Date.now() < deadline) {
      const response = await this.getResponse(updateId);
      if (response) return response;

      const remaining = deadline - Date.now();
      if (remaining <= 0) break;

      await Bun.sleep(Math.min(POLL_INTERVAL_MS, remaining));
    }

    throw new UpdateTimeoutError(updateId, timeout);
  }

  /** Clean up expired responses and their orphaned idempotency mappings. */
  async cleanupExpiredResponses(ttlMs?: number): Promise<number> {
    const effectiveTtl = ttlMs ?? DEFAULT_CLEANUP_TTL_MS;
    const cutoff = Date.now() - effectiveTtl;

    const expiredResponseKeys: string[] = [];
    const expiredUpdateIds = new Set<string>();

    for await (const [key, value] of this.#storage.scan('upr:')) {
      const response = decode(value) as UpdateResponse;
      if (response.createdAt < cutoff) {
        expiredResponseKeys.push(key);
        expiredUpdateIds.add(response.updateId);
      }
    }

    if (expiredResponseKeys.length === 0) return 0;

    // Find orphaned idempotency mappings that reference expired responses
    const orphanedIdempotencyKeys: string[] = [];
    for await (const [key, value] of this.#storage.scan('upk:')) {
      const mapping = decode(value) as { updateId: string };
      if (expiredUpdateIds.has(mapping.updateId)) {
        orphanedIdempotencyKeys.push(key);
      }
    }

    const operations: BatchOperation[] = [
      ...expiredResponseKeys.map((key) => ({ type: 'delete' as const, key })),
      ...orphanedIdempotencyKeys.map((key) => ({ type: 'delete' as const, key })),
    ];

    await this.#storage.batch(operations);

    return expiredResponseKeys.length;
  }
}
