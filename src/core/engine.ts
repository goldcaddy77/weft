/**
 * Core workflow engine. Orchestrates workflow execution, manages lifecycle
 * events, and coordinates storage, scheduling, and signal delivery.
 *
 * Workflows and activities run inline on the main thread (no Web Workers).
 * Worker-based execution is a separate layer added later.
 *
 * @module core/engine
 */

import type { Storage as WeftStorage } from '../storage/interface.ts';
import { KEYS } from '../storage/interface.ts';
import { MemoryStorage } from '../storage/memory.ts';
import {
  createCheckpoint,
  serializeCheckpoint,
  validateCheckpointRoundTrip,
} from './checkpoint.ts';
import { decode, encode } from './codec.ts';
import type { ContextOperationRequest } from './context.ts';
import { Context } from './context.ts';
import {
  DevelopmentWarningEvent,
  SignalReceivedEvent,
  UpdateCompletedEvent,
  UpdateReceivedEvent,
  WorkflowCancelledEvent,
  WorkflowCompletedEvent,
  WorkflowFailedEvent,
  WorkflowStartedEvent,
} from './events.ts';
import type { ActivityInterceptor, WorkflowInterceptor } from './interceptor.ts';
import { composeActivityInterceptors, composeWorkflowInterceptors } from './interceptor.ts';
import { Scheduler, parseDuration } from './scheduler.ts';
import type {
  EngineOptions,
  ListFilter,
  PaginatedResult,
  StartOptions,
  WorkflowFunction,
  WorkflowRegistration,
  WorkflowState,
  WorkflowSummary,
} from './types.ts';
import { UpdateCoordinator } from './updates.ts';

declare global {
  interface SymbolConstructor {
    readonly observable: unique symbol;
  }
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface RegistrationEntry {
  handler: WorkflowFunction;
  version: string;
}

interface ResolvedOptions {
  storage: WeftStorage;
  development: boolean;
  checkpointHistory: number;
  checkpointSizeWarningThreshold: number;
  maxNestingDepth: number;
  broadcastEvents: boolean;
  getNow: () => number;
}

interface WorkflowResultResolver {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Safely cast a `Function` stored on a ContextOperationRequest
 * to a callable signature.  We trust the Context layer to populate
 * `fn` with the correct reference—the Engine merely invokes it.
 */
function callActivityFunction(fn: Function, args: unknown[]): unknown {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return
  return (fn as (...a: unknown[]) => unknown)(...args);
}

function callMemoFunction(fn: Function): unknown {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return
  return (fn as () => unknown)();
}

function decodeWorkflowState(bytes: Uint8Array): WorkflowState {
  return decode(bytes) as never;
}

// ---------------------------------------------------------------------------
// WorkflowHandle
// ---------------------------------------------------------------------------

export class WorkflowHandle extends EventTarget implements AsyncDisposable {
  readonly id: string;
  readonly #engine: Engine;
  readonly #resultPromise: Promise<unknown>;

  constructor(id: string, engine: Engine, resultPromise: Promise<unknown>) {
    super();
    this.id = id;
    this.#engine = engine;
    this.#resultPromise = resultPromise;
  }

  async result(): Promise<unknown> {
    return this.#resultPromise;
  }

  async cancel(): Promise<void> {
    return this.#engine.cancel(this.id);
  }

  async signal(name: string, payload?: unknown): Promise<void> {
    return this.#engine.signal(this.id, name, payload);
  }

  async update(name: string, payload?: unknown, options?: { timeout?: number }): Promise<unknown> {
    return this.#engine.update(this.id, name, payload, options);
  }

  async *[Symbol.asyncIterator](): AsyncIterableIterator<Event> {
    let resolver: (() => void) | undefined;
    const events: Event[] = [];
    const state = { done: false };

    const listener = (event: Event) => {
      events.push(event);
      resolver?.();
    };

    const terminal = (event: Event) => {
      state.done = true;
      listener(event);
    };

    const types = [
      'workflow:completed',
      'workflow:failed',
      'workflow:cancelled',
      'activity:started',
      'activity:completed',
      'signal:received',
    ];

    for (const type of types) {
      this.addEventListener(type, listener);
    }

    // Terminal events override the listener to also set done
    this.addEventListener('workflow:completed', terminal);
    this.addEventListener('workflow:failed', terminal);
    this.addEventListener('workflow:cancelled', terminal);

    try {
      while (!state.done) {
        if (events.length === 0) {
          const { promise, resolve } = Promise.withResolvers<void>();
          resolver = resolve;
          await promise;
          resolver = undefined;
        }
        while (events.length > 0) {
          yield events.shift()!;
        }
      }
    } finally {
      for (const type of types) {
        this.removeEventListener(type, listener);
      }
      this.removeEventListener('workflow:completed', terminal);
      this.removeEventListener('workflow:failed', terminal);
      this.removeEventListener('workflow:cancelled', terminal);
    }
  }

  [Symbol.observable](): {
    subscribe: (observer: {
      next?: (event: Event) => void;
      complete?: () => void;
      error?: (error: Error) => void;
    }) => { unsubscribe: () => void };
  } {
    return {
      subscribe: (observer: {
        next?: (event: Event) => void;
        complete?: () => void;
        error?: (error: Error) => void;
      }) => {
        const listener = (event: Event) => observer.next?.(event);

        const types = [
          'workflow:completed',
          'workflow:failed',
          'workflow:cancelled',
          'activity:started',
          'activity:completed',
        ];

        for (const type of types) {
          this.addEventListener(type, listener);
        }

        const completeListener = () => observer.complete?.();
        this.addEventListener('workflow:completed', completeListener);

        const failListener = (event: Event) => {
          const failedEvent = event instanceof WorkflowFailedEvent ? event : undefined;
          if (failedEvent) {
            observer.error?.(failedEvent.error);
          }
        };
        this.addEventListener('workflow:failed', failListener);

        return {
          unsubscribe: () => {
            for (const type of types) {
              this.removeEventListener(type, listener);
            }
            this.removeEventListener('workflow:completed', completeListener);
            this.removeEventListener('workflow:failed', failListener);
          },
        };
      },
    };
  }

  async [Symbol.asyncDispose](): Promise<void> {
    // No-op for now; handles are lightweight
  }
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

export class Engine extends EventTarget implements Disposable, AsyncDisposable {
  #storage: WeftStorage;
  #registrations: Map<string, RegistrationEntry>;
  #abortController: AbortController;
  #scheduler: Scheduler;
  #options: ResolvedOptions;
  #activeGenerators: Map<string, AsyncGenerator>;
  #handleCache: Map<string, WeakRef<WorkflowHandle>>;
  #finalizationRegistry: FinalizationRegistry<string>;
  #resultResolvers: Map<string, WorkflowResultResolver>;
  #workflowAbortControllers: Map<string, AbortController>;
  #signalWaiters: Map<string, (payload: unknown) => void>;
  #sleepResolvers: Map<string, () => void>;
  #interceptors: WorkflowInterceptor[];
  #activityInterceptors: ActivityInterceptor[];
  #updateCoordinator: UpdateCoordinator;
  #activeContexts: Map<string, Context>;
  #broadcastChannel: BroadcastChannel | null;

  constructor(options?: Partial<EngineOptions> & { getNow?: () => number }) {
    super();

    const storage = options?.storage ?? new MemoryStorage();
    const getNow = options?.getNow ?? Date.now;

    this.#storage = storage;
    this.#registrations = new Map();
    this.#abortController = new AbortController();
    this.#activeGenerators = new Map();
    this.#handleCache = new Map();
    this.#resultResolvers = new Map();
    this.#workflowAbortControllers = new Map();
    this.#signalWaiters = new Map();
    this.#sleepResolvers = new Map();
    this.#interceptors = [];
    this.#activityInterceptors = [];
    this.#updateCoordinator = new UpdateCoordinator(storage);
    this.#activeContexts = new Map();
    this.#broadcastChannel = null;
    this.#finalizationRegistry = new FinalizationRegistry<string>((id) => {
      this.#handleCache.delete(id);
    });

    this.#options = {
      storage,
      development: options?.development ?? false,
      checkpointHistory: options?.checkpointHistory ?? 10,
      checkpointSizeWarningThreshold: options?.checkpointSizeWarningThreshold ?? 65_536,
      maxNestingDepth: options?.maxNestingDepth ?? 10,
      broadcastEvents: options?.broadcastEvents ?? false,
      getNow,
    };

    this.#scheduler = new Scheduler({
      storage,
      onTimerFired: (entry) => this.#handleTimerFired(entry),
      getNow,
    });
  }

  // -------------------------------------------------------------------------
  // Registration
  // -------------------------------------------------------------------------

  register(name: string, handler: WorkflowFunction): void;
  register(name: string, registration: WorkflowRegistration): void;
  register(name: string, handlerOrRegistration: WorkflowFunction | WorkflowRegistration): void {
    const isRegistration =
      typeof handlerOrRegistration === 'object' &&
      handlerOrRegistration !== null &&
      'handler' in handlerOrRegistration;

    if (isRegistration) {
      const registration = handlerOrRegistration;
      this.#registrations.set(name, {
        handler: registration.handler,
        version: registration.version ?? '1',
      });
    } else {
      this.#registrations.set(name, {
        handler: handlerOrRegistration,
        version: '1',
      });
    }
  }

  // -------------------------------------------------------------------------
  // Interceptor registration
  // -------------------------------------------------------------------------

  addInterceptor(interceptor: WorkflowInterceptor): void {
    this.#interceptors.push(interceptor);
  }

  addActivityInterceptor(interceptor: ActivityInterceptor): void {
    this.#activityInterceptors.push(interceptor);
  }

  // -------------------------------------------------------------------------
  // Start workflow
  // -------------------------------------------------------------------------

  async start(type: string, input: unknown, options?: StartOptions): Promise<WorkflowHandle> {
    const registration = this.#registrations.get(type);
    if (!registration) {
      throw new Error(`No workflow registered with name "${type}"`);
    }

    const workflowId = options?.id ?? crypto.randomUUID();

    // Check for duplicate
    const existingBytes = await this.#storage.get(KEYS.workflow(workflowId));
    if (existingBytes !== null) {
      throw new Error(`Workflow with id "${workflowId}" already exists`);
    }

    const now = this.#options.getNow();

    // Create workflow state
    const state: WorkflowState = {
      id: workflowId,
      type,
      status: 'running',
      input,
      version: registration.version,
      createdAt: now,
      updatedAt: now,
    };

    if (options?.executionTimeout !== undefined) {
      state.executionDeadline = now + parseDuration(options.executionTimeout);
    }

    // Create initial checkpoint
    const checkpoint = createCheckpoint(workflowId, registration.version);

    // Write state and checkpoint to storage
    await this.#storage.batch([
      { type: 'put', key: KEYS.workflow(workflowId), value: encode(state) },
      {
        type: 'put',
        key: KEYS.checkpoint(workflowId),
        value: serializeCheckpoint(checkpoint),
      },
    ]);

    // Set up execution deadline if needed
    if (state.executionDeadline !== undefined) {
      await this.#scheduler.schedule({
        id: `deadline:${workflowId}`,
        workflowId,
        fireAt: state.executionDeadline,
        kind: 'execution-deadline',
      });
    }

    // Dispatch started event
    this.dispatchEvent(new WorkflowStartedEvent(workflowId, type, input));

    // Create result promise
    const { promise, resolve, reject } = Promise.withResolvers<unknown>();
    this.#resultResolvers.set(workflowId, { resolve, reject });

    // Create handle
    const handle = new WorkflowHandle(workflowId, this, promise);
    this.#handleCache.set(workflowId, new WeakRef(handle));
    this.#finalizationRegistry.register(handle, workflowId);

    // Begin execution (non-blocking)
    this.#advanceWorkflow(workflowId, registration, input).catch((error: unknown) => {
      // This should not normally happen since #advanceWorkflow handles its own errors
      void this.#failWorkflow(
        workflowId,
        error instanceof Error ? error : new Error(String(error)),
      );
    });

    return handle;
  }

  // -------------------------------------------------------------------------
  // Handle retrieval
  // -------------------------------------------------------------------------

  getHandle(workflowId: string): WorkflowHandle {
    // Check cache
    const weakRef = this.#handleCache.get(workflowId);
    if (weakRef) {
      const existing = weakRef.deref();
      if (existing) return existing;
    }

    // Create a new handle. We need a result promise.
    const existingResolver = this.#resultResolvers.get(workflowId);
    let resultPromise: Promise<unknown>;

    if (existingResolver) {
      // Workflow is still running; create a new promise that chains off the resolver
      const { promise, resolve, reject } = Promise.withResolvers<unknown>();
      const originalResolve = existingResolver.resolve;
      const originalReject = existingResolver.reject;
      existingResolver.resolve = (value: unknown) => {
        originalResolve(value);
        resolve(value);
      };
      existingResolver.reject = (reason: unknown) => {
        originalReject(reason);
        reject(reason);
      };
      resultPromise = promise;
    } else {
      // Workflow may already be complete; load from storage
      resultPromise = this.#loadWorkflowResult(workflowId);
    }

    const handle = new WorkflowHandle(workflowId, this, resultPromise);
    this.#handleCache.set(workflowId, new WeakRef(handle));
    this.#finalizationRegistry.register(handle, workflowId);
    return handle;
  }

  // -------------------------------------------------------------------------
  // Listing
  // -------------------------------------------------------------------------

  async list(filter?: ListFilter): Promise<PaginatedResult<WorkflowSummary>> {
    const items: WorkflowSummary[] = [];

    for await (const [key, value] of this.#storage.scan('wf:')) {
      // Skip checkpoint and history keys
      if (key.includes(':ckpt')) continue;

      const state = decodeWorkflowState(value);

      // Apply filters
      if (filter?.status !== undefined) {
        const statuses = Array.isArray(filter.status) ? filter.status : [filter.status];
        if (!statuses.includes(state.status)) continue;
      }

      if (filter?.type !== undefined && state.type !== filter.type) continue;

      items.push({
        id: state.id,
        type: state.type,
        status: state.status,
        version: state.version,
        createdAt: state.createdAt,
        updatedAt: state.updatedAt,
      });
    }

    const offset = filter?.offset ?? 0;
    const limit = filter?.limit ?? items.length;
    const paged = items.slice(offset, offset + limit);

    return {
      items: paged,
      total: items.length,
      offset,
      limit,
    };
  }

  // -------------------------------------------------------------------------
  // Signal
  // -------------------------------------------------------------------------

  async signal(workflowId: string, name: string, payload?: unknown): Promise<void> {
    const signalId = crypto.randomUUID();
    const signalKey = KEYS.signal(workflowId, name, signalId);
    await this.#storage.put(signalKey, encode(payload));

    this.dispatchEvent(new SignalReceivedEvent(workflowId, name, payload));

    this.#broadcast({ type: 'signal:received', workflowId, signalName: name });

    // Check if workflow is waiting for this signal
    const waiterKey = `${workflowId}:${name}`;
    const waiter = this.#signalWaiters.get(waiterKey);
    if (waiter) {
      this.#signalWaiters.delete(waiterKey);
      // Consume the signal from storage
      await this.#storage.delete(signalKey);
      waiter(payload);
    }
  }

  // -------------------------------------------------------------------------
  // Update
  // -------------------------------------------------------------------------

  async update(
    workflowId: string,
    name: string,
    payload?: unknown,
    options?: { timeout?: number },
  ): Promise<unknown> {
    const timeout = options?.timeout ?? 5000;

    // Check if the workflow has an active context with an update handler
    const context = this.#activeContexts.get(workflowId);
    if (context) {
      const handler = context.updateHandlers.get(name);
      if (handler) {
        const updateId = crypto.randomUUID();
        this.dispatchEvent(new UpdateReceivedEvent(updateId, workflowId, name, payload));

        try {
          const result = handler(payload);
          this.dispatchEvent(new UpdateCompletedEvent(updateId, workflowId, name, result));
          return result;
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          this.dispatchEvent(
            new UpdateCompletedEvent(updateId, workflowId, name, undefined, errorMessage),
          );
          throw error;
        }
      }
    }

    // If no active handler, use the UpdateCoordinator with polling
    const updateId = await this.#updateCoordinator.createRequest(workflowId, name, payload);
    this.dispatchEvent(new UpdateReceivedEvent(updateId, workflowId, name, payload));

    const response = await this.#updateCoordinator.waitForResponse(updateId, timeout);

    if (response.error) {
      throw new Error(response.error);
    }

    return response.result;
  }

  // -------------------------------------------------------------------------
  // Cancel
  // -------------------------------------------------------------------------

  async cancel(workflowId: string): Promise<void> {
    // Abort the workflow
    const abortController = this.#workflowAbortControllers.get(workflowId);
    if (abortController) {
      abortController.abort();
    }

    // Clean up the generator
    const generator = this.#activeGenerators.get(workflowId);
    if (generator) {
      try {
        await generator.return(undefined);
      } catch {
        // Ignore errors during cleanup
      }
      this.#activeGenerators.delete(workflowId);
    }

    // Update state
    await this.#updateWorkflowState(workflowId, {
      status: 'cancelled',
    });

    // Clean up context
    this.#activeContexts.delete(workflowId);

    // Dispatch event
    const event = new WorkflowCancelledEvent(workflowId);
    this.dispatchEvent(event);
    this.#forwardEventToHandle(workflowId, event);

    // Reject the result promise
    const resolver = this.#resultResolvers.get(workflowId);
    if (resolver) {
      resolver.reject(new Error('Workflow cancelled'));
      this.#resultResolvers.delete(workflowId);
    }
  }

  // -------------------------------------------------------------------------
  // Disposal
  // -------------------------------------------------------------------------

  [Symbol.dispose](): void {
    this.#abortController.abort();
    this.#scheduler[Symbol.dispose]();
    this.#activeGenerators.clear();
    this.#handleCache.clear();
    this.#resultResolvers.clear();
    this.#workflowAbortControllers.clear();
    this.#signalWaiters.clear();
    this.#sleepResolvers.clear();
    this.#activeContexts.clear();
    this.#broadcastChannel?.close();
    this.#broadcastChannel = null;
  }

  async [Symbol.asyncDispose](): Promise<void> {
    this[Symbol.dispose]();
  }

  // -------------------------------------------------------------------------
  // Accessors (for TestEngine and internal use)
  // -------------------------------------------------------------------------

  get storage(): WeftStorage {
    return this.#storage;
  }

  get scheduler(): Scheduler {
    return this.#scheduler;
  }

  // -------------------------------------------------------------------------
  // Private: workflow advancement
  // -------------------------------------------------------------------------

  async #advanceWorkflow(
    workflowId: string,
    registration: RegistrationEntry,
    input: unknown,
  ): Promise<void> {
    const workflowAbort = new AbortController();
    this.#workflowAbortControllers.set(workflowId, workflowAbort);

    // Create the context
    const context = new Context({
      workflowId,
      workflowType: '',
      startedAt: this.#options.getNow(),
      abortController: workflowAbort,
      getNow: this.#options.getNow,
    });

    // Store the context for update handler lookups
    this.#activeContexts.set(workflowId, context);

    // Create the generator
    const generator = registration.handler(context, input);
    this.#activeGenerators.set(workflowId, generator);

    // Drive the generator
    await this.#driveGenerator(workflowId, generator, undefined);
  }

  async #driveGenerator(
    workflowId: string,
    generator: AsyncGenerator,
    lastResult: unknown,
  ): Promise<void> {
    try {
      // Check if cancelled
      const abortController = this.#workflowAbortControllers.get(workflowId);
      if (abortController?.signal.aborted) return;

      const iterResult = await generator.next(lastResult);

      if (iterResult.done) {
        // Workflow completed
        await this.#completeWorkflow(workflowId, iterResult.value);
        return;
      }

      // Development mode: validate checkpoint round-trip
      this.#validateDevelopmentCheckpoint(workflowId);

      // Process the yielded operation request
      const operation = iterResult.value as never as ContextOperationRequest;
      await this.#processOperation(workflowId, generator, operation);
    } catch (error) {
      await this.#failWorkflow(
        workflowId,
        error instanceof Error ? error : new Error(String(error)),
      );
    }
  }

  async #processOperation(
    workflowId: string,
    generator: AsyncGenerator,
    operation: ContextOperationRequest,
  ): Promise<void> {
    switch (operation.type) {
      case 'activity': {
        try {
          const result = await this.#executeActivity(workflowId, operation);
          await this.#driveGenerator(workflowId, generator, result);
        } catch (error) {
          // Propagate activity failure to the generator
          try {
            const iterResult = await generator.throw(error);
            if (iterResult.done) {
              await this.#completeWorkflow(workflowId, iterResult.value);
            } else {
              await this.#processOperation(
                workflowId,
                generator,
                iterResult.value as never as ContextOperationRequest,
              );
            }
          } catch (innerError) {
            await this.#failWorkflow(
              workflowId,
              innerError instanceof Error ? innerError : new Error(String(innerError)),
            );
          }
        }
        break;
      }

      case 'sleep': {
        const { promise, resolve } = Promise.withResolvers<void>();

        // Schedule via the scheduler's durable timer
        await this.#scheduler.schedule({
          id: `sleep:${operation.operationId}`,
          workflowId,
          fireAt: operation.scheduledFireAt,
          kind: 'sleep',
        });

        // Store the resolution function for when the timer fires
        this.#sleepResolvers.set(operation.operationId, resolve);

        await promise;
        await this.#driveGenerator(workflowId, generator, undefined);
        break;
      }

      case 'wait-signal': {
        // Check if signal already exists in storage
        const existingPayload = await this.#consumeSignal(workflowId, operation.signalName);
        if (existingPayload !== undefined) {
          await this.#driveGenerator(workflowId, generator, existingPayload);
          return;
        }

        // Wait for signal
        const { promise, resolve } = Promise.withResolvers<unknown>();
        const waiterKey = `${workflowId}:${operation.signalName}`;
        this.#signalWaiters.set(waiterKey, resolve);

        const payload = await promise;
        await this.#driveGenerator(workflowId, generator, payload);
        break;
      }

      case 'parallel': {
        const results = await Promise.all(
          operation.operations.map((subOperation) =>
            this.#executeSubOperation(workflowId, subOperation),
          ),
        );
        await this.#driveGenerator(workflowId, generator, results);
        break;
      }

      case 'race': {
        const result = await Promise.race(
          operation.operations.map((subOperation) =>
            this.#executeSubOperation(workflowId, subOperation),
          ),
        );
        await this.#driveGenerator(workflowId, generator, result);
        break;
      }

      case 'memo': {
        const result = await callMemoFunction(operation.fn);
        await this.#driveGenerator(workflowId, generator, result);
        break;
      }

      case 'offload': {
        const data = await (operation.fn as () => Promise<unknown>)();
        const serialized = JSON.stringify(data);
        const reference = {
          key: operation.key,
          workflowId,
          sizeBytes: new TextEncoder().encode(serialized).byteLength,
        };
        // TODO: persist offloaded data to external storage
        await this.#driveGenerator(workflowId, generator, reference);
        break;
      }

      case 'load': {
        // TODO: load offloaded data from external storage
        await this.#driveGenerator(workflowId, generator, undefined);
        break;
      }

      case 'archive': {
        // TODO: persist archived data to external storage
        await this.#driveGenerator(workflowId, generator, undefined);
        break;
      }

      case 'run-all': {
        const results: Record<string, unknown> = {};
        const entries = Object.entries(operation.branches);
        const promises = entries.map(async ([name, [fn, ...args]]) => {
          const result = await callActivityFunction(fn, args);
          results[name] = result;
        });
        await Promise.all(promises);
        await this.#driveGenerator(workflowId, generator, results);
        break;
      }

      case 'agent': {
        const { executeAgentLoop } = await import('../ai/agent.ts');
        const {
          prompt,
          budget: _budgetOptions,
          contextStrategy: _contextStrategy,
          ...rest
        } = operation.options;
        const agentResult = await executeAgentLoop(rest, prompt);
        await this.#driveGenerator(workflowId, generator, agentResult.content);
        break;
      }

      default:
        throw new Error(`Unknown operation type: ${(operation as { type: string }).type}`);
    }
  }

  async #executeSubOperation(
    _workflowId: string,
    operation: ContextOperationRequest,
  ): Promise<unknown> {
    switch (operation.type) {
      case 'activity':
        return callActivityFunction(operation.fn, operation.args);
      case 'memo':
        return callMemoFunction(operation.fn);
      default:
        throw new Error(`Unsupported sub-operation type: ${operation.type}`);
    }
  }

  async #handleTimerFired(entry: { id: string; workflowId: string; kind: string }): Promise<void> {
    if (entry.kind === 'sleep') {
      // Extract the operation ID from the timer ID (format: "sleep:<operationId>")
      const operationId = entry.id.replace('sleep:', '');
      const resolver = this.#sleepResolvers.get(operationId);
      if (resolver) {
        this.#sleepResolvers.delete(operationId);
        resolver();
      }
    } else if (entry.kind === 'execution-deadline') {
      await this.cancel(entry.workflowId);
    }
  }

  async #consumeSignal(workflowId: string, signalName: string): Promise<unknown> {
    const prefix = `sig:${workflowId}:${signalName}:`;
    for await (const [key, value] of this.#storage.scan(prefix, { limit: 1 })) {
      await this.#storage.delete(key);
      return decode(value);
    }
    return undefined;
  }

  // -------------------------------------------------------------------------
  // Private: state management
  // -------------------------------------------------------------------------

  async #completeWorkflow(workflowId: string, result: unknown): Promise<void> {
    const state = await this.#loadWorkflowState(workflowId);
    if (!state || state.status !== 'running') return;

    const now = this.#options.getNow();
    const duration = now - state.createdAt;

    await this.#updateWorkflowState(workflowId, {
      status: 'completed',
      result,
    });

    this.#activeGenerators.delete(workflowId);
    this.#workflowAbortControllers.delete(workflowId);
    this.#activeContexts.delete(workflowId);

    const event = new WorkflowCompletedEvent(workflowId, result, duration);
    this.dispatchEvent(event);
    this.#forwardEventToHandle(workflowId, event);

    this.#broadcast({ type: 'workflow:completed', workflowId });

    const resolver = this.#resultResolvers.get(workflowId);
    if (resolver) {
      resolver.resolve(result);
      this.#resultResolvers.delete(workflowId);
    }
  }

  async #failWorkflow(workflowId: string, error: Error): Promise<void> {
    await this.#updateWorkflowState(workflowId, {
      status: 'failed',
      error: error.message,
    });

    this.#activeGenerators.delete(workflowId);
    this.#workflowAbortControllers.delete(workflowId);
    this.#activeContexts.delete(workflowId);

    const event = new WorkflowFailedEvent(workflowId, error);
    this.dispatchEvent(event);
    this.#forwardEventToHandle(workflowId, event);

    const resolver = this.#resultResolvers.get(workflowId);
    if (resolver) {
      resolver.reject(error);
      this.#resultResolvers.delete(workflowId);
    }
  }

  async #updateWorkflowState(workflowId: string, updates: Partial<WorkflowState>): Promise<void> {
    const bytes = await this.#storage.get(KEYS.workflow(workflowId));
    if (!bytes) return;

    const state = decodeWorkflowState(bytes);
    const updated = {
      ...state,
      ...updates,
      updatedAt: this.#options.getNow(),
    };

    await this.#storage.put(KEYS.workflow(workflowId), encode(updated));
  }

  async #loadWorkflowState(workflowId: string): Promise<WorkflowState | null> {
    const bytes = await this.#storage.get(KEYS.workflow(workflowId));
    if (!bytes) return null;
    return decodeWorkflowState(bytes);
  }

  async #loadWorkflowResult(workflowId: string): Promise<unknown> {
    const state = await this.#loadWorkflowState(workflowId);
    if (!state) throw new Error(`Workflow "${workflowId}" not found`);
    if (state.status === 'completed') return state.result;
    if (state.status === 'failed') throw new Error(state.error ?? 'Workflow failed');
    if (state.status === 'cancelled') throw new Error('Workflow cancelled');
    throw new Error(`Workflow "${workflowId}" is still ${state.status}`);
  }

  // -------------------------------------------------------------------------
  // Private: event forwarding to handles
  // -------------------------------------------------------------------------

  #forwardEventToHandle(workflowId: string, event: Event): void {
    const weakRef = this.#handleCache.get(workflowId);
    if (!weakRef) return;
    const handle = weakRef.deref();
    if (!handle) return;
    handle.dispatchEvent(new Event(event.type));
  }

  // -------------------------------------------------------------------------
  // Private: activity execution through interceptors
  // -------------------------------------------------------------------------

  async #executeActivity(
    _workflowId: string,
    operation: Extract<ContextOperationRequest, { type: 'activity' }>,
  ): Promise<unknown> {
    // If there are activity interceptors, compose and run through them
    if (this.#activityInterceptors.length > 0) {
      const composed = composeActivityInterceptors(this.#activityInterceptors);
      return composed.execute(
        {
          activityName: operation.activityName,
          input: operation.args.length === 1 ? operation.args[0] : operation.args,
          attempt: 1,
          headers: new Map(),
        },
        async (interception) => {
          // Reconstruct args from the interception input
          const args = Array.isArray(interception.input)
            ? interception.input
            : [interception.input];
          return callActivityFunction(operation.fn, args);
        },
      );
    }

    // If there are workflow interceptors with activity hooks, compose and run
    if (this.#interceptors.length > 0) {
      const composed = composeWorkflowInterceptors(this.#interceptors);
      const interception = {
        activityName: operation.activityName,
        input: operation.args.length === 1 ? operation.args[0] : operation.args,
        attempt: 1,
        headers: new Map<string, string>(),
      };

      // The execute function is the terminal of the interceptor chain.
      // It must be a generator per the composed interceptor interface.
      // We yield a sentinel to satisfy require-yield, then return the result.
      const activityFunction = operation.fn;
      const activityArguments = operation.args;

      function* execute(): Generator<unknown, unknown, unknown> {
        const result = callActivityFunction(activityFunction, activityArguments);
        // yield to satisfy the generator contract; the engine drives this synchronously
        yield result;
        return result;
      }

      const generator = composed.activity(interception, execute);
      let current: IteratorResult<unknown, unknown> = generator.next();
      // If the interceptor chain yields (most do), the value is the activity result
      while (!current.done) {
        current = generator.next(current.value);
      }
      return current.value;
    }

    return callActivityFunction(operation.fn, operation.args);
  }

  // -------------------------------------------------------------------------
  // Private: development mode checkpoint validation
  // -------------------------------------------------------------------------

  #validateDevelopmentCheckpoint(workflowId: string): void {
    if (!this.#options.development) return;

    const context = this.#activeContexts.get(workflowId);
    if (!context) return;

    const step = context.stepIndex;
    const checkpoint = createCheckpoint(workflowId, '1');
    const result = validateCheckpointRoundTrip(checkpoint);

    if (!result.valid) {
      const fieldPaths = result.divergences.map((divergence) => divergence.path);
      const message = `Checkpoint at step ${step} has ${result.divergences.length} non-serializable field(s)`;
      this.dispatchEvent(new DevelopmentWarningEvent(workflowId, message, fieldPaths));
    }
  }

  /**
   * Post a message to the BroadcastChannel for cross-worker coordination.
   * Only active when `broadcastEvents` is enabled. Lazily creates the channel
   * on first use to avoid overhead when unused.
   */
  #broadcast(message: Record<string, unknown>): void {
    if (!this.#options.broadcastEvents) return;

    if (this.#broadcastChannel === null) {
      try {
        this.#broadcastChannel = new BroadcastChannel('weft:events');
      } catch {
        return;
      }
    }
    this.#broadcastChannel.postMessage(message);
  }
}
