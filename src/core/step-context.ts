/**
 * Step-based workflow context — progressive disclosure API.
 *
 * Bridges plain async functions with the generator protocol used internally
 * by the engine. Users write `await ctx.step(name, fn)` and the compiler
 * produces a generator that yields one operation at a time.
 *
 * @module core/step-context
 */

import type { ContextOperationRequest } from './context.ts';
import type { StepWorkflowContext, WorkflowFunction } from './types.ts';

// ---------------------------------------------------------------------------
// Queued operation — one pending ctx.step() call
// ---------------------------------------------------------------------------

interface QueuedOperation {
  request: ContextOperationRequest;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
}

// ---------------------------------------------------------------------------
// StepContext
// ---------------------------------------------------------------------------

export class StepContext implements StepWorkflowContext {
  readonly workflowId: string;
  readonly signal: AbortSignal;

  #queue: QueuedOperation[] = [];
  #notifyQueue: (() => void) | undefined;
  #done = false;

  constructor(workflowId: string, signal: AbortSignal) {
    this.workflowId = workflowId;
    this.signal = signal;
  }

  async step<T>(name: string, fn: () => Promise<T> | T): Promise<T> {
    const operationId = crypto.randomUUID();
    const { promise, resolve, reject } = Promise.withResolvers<unknown>();

    this.#queue.push({
      request: {
        type: 'activity',
        operationId,
        activityName: name,
        fn: fn as Function,
        args: [],
      },
      resolve,
      reject,
    });

    this.#notifyQueue?.();

    return promise as Promise<T>;
  }

  /** Called by the generator loop to wait for the next operation. */
  async dequeue(): Promise<QueuedOperation | null> {
    if (this.#queue.length > 0) {
      return this.#queue.shift()!;
    }
    if (this.#done) return null;

    const { promise, resolve } = Promise.withResolvers<void>();
    this.#notifyQueue = resolve;
    await promise;
    this.#notifyQueue = undefined;

    if (this.#done && this.#queue.length === 0) return null;
    return this.#queue.shift() ?? null;
  }

  /** Unblocks dequeue() when the user function completes. */
  signalDone(): void {
    this.#done = true;
    this.#notifyQueue?.();
  }
}

// ---------------------------------------------------------------------------
// compileStepWorkflow — wraps a StepWorkflowFunction into a WorkflowFunction
// ---------------------------------------------------------------------------

export function compileStepWorkflow<TInput = unknown, TOutput = unknown>(
  stepFunction: (context: StepWorkflowContext, input: TInput) => Promise<TOutput>,
): WorkflowFunction<TInput, TOutput> {
  return async function* (_rawContext, input) {
    // Extract workflowId and signal from the raw context
    const rawContext = _rawContext as { workflowId: string; signal: AbortSignal };
    const stepContext = new StepContext(rawContext.workflowId, rawContext.signal);

    let workflowResult: TOutput | undefined;
    let workflowError: unknown;

    // Start the user's async function concurrently
    const userPromise = stepFunction(stepContext, input)
      .then((result) => {
        workflowResult = result;
        stepContext.signalDone();
        return undefined;
      })
      .catch((error: unknown) => {
        workflowError = error;
        stepContext.signalDone();
      });

    // Generator loop: yield operations to the engine one at a time
    while (true) {
      const queued = await stepContext.dequeue();
      if (queued === null) break;

      try {
        const result = yield queued.request;
        queued.resolve(result);
      } catch (error) {
        queued.reject(error);
      }
    }

    // Wait for the user function to fully settle
    await userPromise;

    if (workflowError !== undefined) {
      if (workflowError instanceof Error) {
        throw workflowError;
      }
      throw new Error(
        typeof workflowError === 'string' ? workflowError : JSON.stringify(workflowError),
      );
    }

    return workflowResult as TOutput;
  };
}

// ---------------------------------------------------------------------------
// Detection helper
// ---------------------------------------------------------------------------

const GeneratorFunctionPrototype = Object.getPrototypeOf(function* () {});
const AsyncGeneratorFunctionPrototype = Object.getPrototypeOf(async function* () {});

/** Returns `true` if `fn` is a sync generator function (`function*`). */
export function isGeneratorFunction(fn: Function): boolean {
  return Object.getPrototypeOf(fn) === GeneratorFunctionPrototype;
}

/** Returns `true` if `fn` is an async generator function (`async function*`). */
export function isAsyncGeneratorFunction(fn: Function): boolean {
  return Object.getPrototypeOf(fn) === AsyncGeneratorFunctionPrototype;
}
