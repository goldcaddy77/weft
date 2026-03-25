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

import type { AgentTool } from '../ai/agent.ts';
import type { BudgetOptions, BudgetState } from '../ai/budget.ts';
import { BudgetTracker } from '../ai/budget.ts';
import type { ContextStrategy } from '../ai/context-window.ts';
import type { AgentHooks } from '../ai/hooks.ts';
import type { ModelRouter } from '../ai/model-router.ts';
import type { LLMProvider } from '../ai/providers/interface.ts';
import { parseDuration } from './scheduler.ts';
import type { Duration, SearchAttributeValue, WorkflowContext } from './types.ts';

// ---------------------------------------------------------------------------
// Offload reference — returned by ctx.offload(), consumed by ctx.load()
// ---------------------------------------------------------------------------

export interface OffloadReference {
  key: string;
  workflowId: string;
  sizeBytes: number;
}

// ---------------------------------------------------------------------------
// Agent context options
// ---------------------------------------------------------------------------

export interface AgentContextOptions {
  model: string;
  prompt: string;
  provider: LLMProvider;
  tools?: AgentTool[];
  maxTurns?: number;
  systemPrompt?: string;
  budget?: BudgetOptions;
  modelRouter?: ModelRouter;
  contextStrategy?: ContextStrategy;
  hooks?: AgentHooks;
}

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
    }
  | {
      type: 'offload';
      operationId: string;
      key: string;
      fn: () => Promise<unknown>;
    }
  | {
      type: 'load';
      operationId: string;
      reference: OffloadReference;
    }
  | {
      type: 'archive';
      operationId: string;
      key: string;
      data: unknown;
    }
  | {
      type: 'run-all';
      operationId: string;
      branches: Record<string, [Function, ...unknown[]]>;
    }
  | {
      type: 'agent';
      operationId: string;
      options: AgentContextOptions;
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
  #explainMode: boolean;
  #budgetTracker: BudgetTracker | undefined;

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
    this.#explainMode = false;
    this.#budgetTracker = undefined;
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

  get explainEnabled(): boolean {
    return this.#explainMode;
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
      if (this.#explainMode) {
        console.log(
          `[weft] ctx.run(${fn.name || 'anonymous'}) → Returning cached result from step ${step}`,
        );
      }
      return this.#accumulatedResults.get(step) as TResult;
    }

    if (this.#explainMode) {
      console.log(`[weft] ctx.run(${fn.name || 'anonymous'}, ${JSON.stringify(args)})`);
      console.log(`  → Creating checkpoint at step ${step}`);
      console.log(`  → Dispatching activity "${fn.name || 'anonymous'}" to queue "default"`);
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

  *offload<T>(
    key: string,
    fn: () => Promise<T>,
  ): Generator<ContextOperationRequest, OffloadReference, unknown> {
    const step = this.#stepIndex++;

    if (this.#accumulatedResults.has(step)) {
      return this.#accumulatedResults.get(step) as OffloadReference;
    }

    if (this.#explainMode) {
      console.log(`[weft] ctx.offload("${key}")`);
      console.log(`  → Creating checkpoint at step ${step}`);
      console.log(`  → Offloading data for key "${key}" to external storage`);
    }

    const operationId = crypto.randomUUID();
    const result = yield {
      type: 'offload' as const,
      operationId,
      key,
      fn,
    };

    this.#accumulatedResults.set(step, result);
    return result as OffloadReference;
  }

  *load<T>(reference: OffloadReference): Generator<ContextOperationRequest, T, unknown> {
    const step = this.#stepIndex++;

    if (this.#accumulatedResults.has(step)) {
      return this.#accumulatedResults.get(step) as T;
    }

    if (this.#explainMode) {
      console.log(`[weft] ctx.load("${reference.key}")`);
      console.log(`  → Creating checkpoint at step ${step}`);
      console.log(`  → Loading offloaded data for key "${reference.key}"`);
    }

    const operationId = crypto.randomUUID();
    const result = yield {
      type: 'load' as const,
      operationId,
      reference,
    };

    this.#accumulatedResults.set(step, result);
    return result as T;
  }

  *archive(key: string, data: unknown): Generator<ContextOperationRequest, void, unknown> {
    const step = this.#stepIndex++;

    if (this.#accumulatedResults.has(step)) return;

    if (this.#explainMode) {
      console.log(`[weft] ctx.archive("${key}")`);
      console.log(`  → Creating checkpoint at step ${step}`);
      console.log(`  → Archiving data for key "${key}"`);
    }

    const operationId = crypto.randomUUID();
    yield {
      type: 'archive' as const,
      operationId,
      key,
      data,
    };

    this.#accumulatedResults.set(step, undefined);
  }

  *runAll<T extends Record<string, [Function, ...unknown[]]>>(
    branches: T,
  ): Generator<ContextOperationRequest, Record<keyof T, unknown>, unknown> {
    const step = this.#stepIndex++;

    if (this.#accumulatedResults.has(step)) {
      return this.#accumulatedResults.get(step) as Record<keyof T, unknown>;
    }

    if (this.#explainMode) {
      const branchNames = Object.keys(branches).join(', ');
      console.log(`[weft] ctx.runAll({ ${branchNames} })`);
      console.log(`  → Creating checkpoint at step ${step}`);
      console.log(`  → Running ${Object.keys(branches).length} named branches in parallel`);
    }

    const operationId = crypto.randomUUID();
    const result = yield {
      type: 'run-all' as const,
      operationId,
      branches,
    };

    this.#accumulatedResults.set(step, result);
    return result as Record<keyof T, unknown>;
  }

  // -------------------------------------------------------------------------
  // Explain mode
  // -------------------------------------------------------------------------

  explain(enabled: boolean = true): void {
    this.#explainMode = enabled;
  }

  *agent(options: AgentContextOptions): Generator<ContextOperationRequest, unknown, unknown> {
    const step = this.#stepIndex++;

    if (this.#accumulatedResults.has(step)) {
      return this.#accumulatedResults.get(step);
    }

    const operationId = crypto.randomUUID();
    const result = yield {
      type: 'agent' as const,
      operationId,
      options,
    };

    this.#accumulatedResults.set(step, result);
    return result;
  }

  // -------------------------------------------------------------------------
  // Budget tracking
  // -------------------------------------------------------------------------

  setBudget(options: BudgetOptions): void {
    this.#budgetTracker = new BudgetTracker(options);
  }

  budgetRemaining(): BudgetState | undefined {
    return this.#budgetTracker?.budgetRemaining();
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
