/**
 * Workflow execution context.
 *
 * The Context class is the `ctx` parameter passed to workflow generator functions.
 * Each durable method is a generator that yields a {@link ContextOperationRequest}
 * descriptor. The Engine feeds results back via `generator.next(result)`.
 *
 * The Context does NOT execute activities or interact with storage directly.
 *
 * @module context
 */

import { parseDuration } from './scheduler.ts';
import type { Duration, SearchAttributeValue, WorkflowContext } from './types.ts';

// ---------------------------------------------------------------------------
// Operation request descriptors
// ---------------------------------------------------------------------------

export type ContextOperationRequest =
  | {
      type: 'activity';
      operationId: string;
      activityName: string;
      fn: Function;
      args: unknown[];
      callerStack?: string;
      options?: Record<string, unknown>;
    }
  | {
      type: 'sleep';
      operationId: string;
      duration: number;
      scheduledFireAt: number;
    }
  | {
      type: 'wait-signal';
      operationId: string;
      signalName: string;
    }
  | {
      type: 'wait-update';
      operationId: string;
      updateName: string;
    }
  | {
      type: 'parallel';
      operationId: string;
      operations: ContextOperationRequest[];
    }
  | {
      type: 'race';
      operationId: string;
      operations: ContextOperationRequest[];
    }
  | {
      type: 'memo';
      operationId: string;
      key: string;
      fn: () => unknown;
    }
  | {
      type: 'child-workflow';
      operationId: string;
      workflowType: string;
      input: unknown;
      options?: Record<string, unknown>;
    };

// ---------------------------------------------------------------------------
// Context options
// ---------------------------------------------------------------------------

export interface ContextOptions {
  workflowId: string;
  workflowType: string;
  startedAt: number;
  abortController: AbortController;
  deadline?: number;
  initialStep?: number;
  accumulatedResults?: Map<number, unknown>;
  searchAttributes?: Record<string, SearchAttributeValue>;
  getNow?: () => number;
}

// ---------------------------------------------------------------------------
// Context class
// ---------------------------------------------------------------------------

export class Context implements WorkflowContext {
  readonly workflowId: string;
  readonly workflowType: string;
  readonly startedAt: number;
  readonly signal: AbortSignal;

  #stepIndex: number;
  #accumulatedResults: Map<number, unknown>;
  #searchAttributes: Record<string, SearchAttributeValue>;
  #pendingAttributeChanges: Record<string, SearchAttributeValue>;
  #updateHandlers: Map<string, (payload: unknown) => unknown>;
  #exposedValues: Map<string, () => unknown>;
  #memoCache: Map<string, unknown>;
  #deadline: number | undefined;
  #getNow: () => number;

  constructor(options: ContextOptions) {
    this.workflowId = options.workflowId;
    this.workflowType = options.workflowType;
    this.startedAt = options.startedAt;
    this.signal = options.abortController.signal;

    this.#stepIndex = options.initialStep ?? 0;
    this.#accumulatedResults = options.accumulatedResults ?? new Map();
    this.#searchAttributes = options.searchAttributes ? { ...options.searchAttributes } : {};
    this.#pendingAttributeChanges = {};
    this.#updateHandlers = new Map();
    this.#exposedValues = new Map();
    this.#memoCache = new Map();
    this.#deadline = options.deadline;
    this.#getNow = options.getNow ?? Date.now;
  }

  // -------------------------------------------------------------------------
  // Getters
  // -------------------------------------------------------------------------

  get executionTimeRemaining(): number {
    if (this.#deadline === undefined) return Infinity;
    return Math.max(0, this.#deadline - this.#getNow());
  }

  get stepIndex(): number {
    return this.#stepIndex;
  }

  get accumulatedResults(): Map<number, unknown> {
    return this.#accumulatedResults;
  }

  get pendingAttributeChanges(): Record<string, SearchAttributeValue> {
    return this.#pendingAttributeChanges;
  }

  get exposedAccessors(): Map<string, () => unknown> {
    return this.#exposedValues;
  }

  get updateHandlers(): Map<string, (payload: unknown) => unknown> {
    return this.#updateHandlers;
  }

  // -------------------------------------------------------------------------
  // Durable operations (generators)
  // -------------------------------------------------------------------------

  *run<TResult>(
    fn: (...args: unknown[]) => Promise<TResult> | TResult,
    ...args: unknown[]
  ): Generator<ContextOperationRequest, TResult, unknown> {
    const step = this.#stepIndex++;

    if (this.#accumulatedResults.has(step)) {
      return this.#accumulatedResults.get(step) as TResult;
    }

    const operationId = crypto.randomUUID();
    const result = yield {
      type: 'activity',
      operationId,
      activityName: fn.name || 'anonymous',
      fn,
      args,
    };

    this.#accumulatedResults.set(step, result);
    return result as TResult;
  }

  *sleep(duration: Duration): Generator<ContextOperationRequest, void, unknown> {
    const step = this.#stepIndex++;

    if (this.#accumulatedResults.has(step)) return;

    const milliseconds = parseDuration(duration);
    const operationId = crypto.randomUUID();

    yield {
      type: 'sleep',
      operationId,
      duration: milliseconds,
      scheduledFireAt: this.#getNow() + milliseconds,
    };

    this.#accumulatedResults.set(step, undefined);
  }

  *waitForSignal<T = unknown>(name: string): Generator<ContextOperationRequest, T, unknown> {
    const step = this.#stepIndex++;

    if (this.#accumulatedResults.has(step)) {
      return this.#accumulatedResults.get(step) as T;
    }

    const operationId = crypto.randomUUID();
    const result = yield {
      type: 'wait-signal',
      operationId,
      signalName: name,
    };

    this.#accumulatedResults.set(step, result);
    return result as T;
  }

  *waitForUpdate<T = unknown>(name: string): Generator<ContextOperationRequest, T, unknown> {
    const step = this.#stepIndex++;

    if (this.#accumulatedResults.has(step)) {
      return this.#accumulatedResults.get(step) as T;
    }

    const operationId = crypto.randomUUID();
    const result = yield {
      type: 'wait-update',
      operationId,
      updateName: name,
    };

    this.#accumulatedResults.set(step, result);
    return result as T;
  }

  *all(
    operations: Generator<ContextOperationRequest, unknown, unknown>[],
  ): Generator<ContextOperationRequest, unknown[], unknown> {
    const step = this.#stepIndex++;

    if (this.#accumulatedResults.has(step)) {
      return this.#accumulatedResults.get(step) as unknown[];
    }

    const subOperations: ContextOperationRequest[] = [];
    for (const generator of operations) {
      const yielded = generator.next();
      if (!yielded.done) {
        subOperations.push(yielded.value);
      }
    }

    const operationId = crypto.randomUUID();
    const result = yield {
      type: 'parallel',
      operationId,
      operations: subOperations,
    };

    this.#accumulatedResults.set(step, result);
    return result as unknown[];
  }

  *race(
    operations: Generator<ContextOperationRequest, unknown, unknown>[],
  ): Generator<ContextOperationRequest, unknown, unknown> {
    const step = this.#stepIndex++;

    if (this.#accumulatedResults.has(step)) {
      return this.#accumulatedResults.get(step);
    }

    const subOperations: ContextOperationRequest[] = [];
    for (const generator of operations) {
      const yielded = generator.next();
      if (!yielded.done) {
        subOperations.push(yielded.value);
      }
    }

    const operationId = crypto.randomUUID();
    const result = yield {
      type: 'race',
      operationId,
      operations: subOperations,
    };

    this.#accumulatedResults.set(step, result);
    return result;
  }

  *memo<T>(key: string, fn: () => T | Promise<T>): Generator<ContextOperationRequest, T, unknown> {
    const step = this.#stepIndex++;

    // Check memo cache first (covers repeated calls within the same execution)
    if (this.#memoCache.has(key)) {
      return this.#memoCache.get(key) as T;
    }

    // Check accumulated results (recovery path from checkpoint)
    if (this.#accumulatedResults.has(step)) {
      const cached = this.#accumulatedResults.get(step) as T;
      this.#memoCache.set(key, cached);
      return cached;
    }

    const operationId = crypto.randomUUID();
    const result = yield {
      type: 'memo',
      operationId,
      key,
      fn,
    };

    this.#memoCache.set(key, result);
    this.#accumulatedResults.set(step, result);
    return result as T;
  }

  // -------------------------------------------------------------------------
  // Synchronous operations (non-yielding)
  // -------------------------------------------------------------------------

  setAttribute(key: string, value: SearchAttributeValue): void {
    this.#searchAttributes[key] = value;
    this.#pendingAttributeChanges[key] = value;
  }

  setAttributes(attributes: Record<string, SearchAttributeValue>): void {
    for (const [key, value] of Object.entries(attributes)) {
      this.#searchAttributes[key] = value;
      this.#pendingAttributeChanges[key] = value;
    }
  }

  getAttribute<T extends SearchAttributeValue = SearchAttributeValue>(key: string): T | undefined {
    return this.#searchAttributes[key] as T | undefined;
  }

  getAttributes(): Readonly<Record<string, SearchAttributeValue>> {
    return { ...this.#searchAttributes };
  }

  onUpdate(name: string, handler: (payload: unknown) => unknown): void {
    this.#updateHandlers.set(name, handler);
  }

  expose(accessors: Record<string, () => unknown>): void {
    for (const [key, accessor] of Object.entries(accessors)) {
      this.#exposedValues.set(key, accessor);
    }
  }
}
