import type {
  DebateOptions,
  DebateResult,
  HandoffOptions,
  HandoffResult,
  SuperviseOptions,
  SuperviseResult,
} from '../../ai/coordination/index.ts';
import type { HumanReviewOptions, HumanReviewResult } from '../../ai/human-review.ts';
import {
  cloneSessionStateStore,
  normalizeSessionStateRecord,
  SESSION_STATE_LOCAL_KEY,
} from '../session-state.ts';
import type {
  ActivityCallOptions,
  ChildWorkflowOptions,
  ChildWorkflowTarget,
  Duration,
  SearchAttributeValue,
  WorkflowContext,
  WorkflowMapOptions,
  WorkflowPipeStage,
  WorkflowPipeStageDefinition,
  WorkflowReduceInput,
  WorkflowReduceOptions,
  WorkflowSessionState,
} from '../types.ts';
import * as aiOperations from './ai-operations.ts';
import * as contextAttributes from './attributes.ts';
import * as childWorkflowPipe from './child-workflow-pipe.ts';
import * as durableOperations from './durable-operations.ts';
import { getInternals, initializeInternals } from './internals.ts';
import type { ContextOperationRequest } from './operation-request.ts';
import * as parallelOperations from './parallel-operations.ts';
import * as sagaHelpers from './saga.ts';
import * as sessionStateHelpers from './session-state.ts';
import type {
  AgentContextOptions,
  ContextOptions,
  ErasedSagaStep,
  OffloadReference,
  StreamReference,
  StreamSink,
} from './types.ts';
import * as contextUpdates from './updates.ts';
import * as contextValidation from './validation.ts';
export type { ContextOperationRequest } from './operation-request.ts';
export type {
  AgentContextOptions,
  ContextOptions,
  OffloadReference,
  SagaStep,
  StoredStreamChunk,
  StreamReference,
  StreamSink,
} from './types.ts';
/**
 * Concrete workflow execution context injected as the first argument of every
 * registered workflow generator. Implements durable operations such as `run`,
 * `sleep`, `waitForSignal`, `offload`, `stream`, `agent`, and `saga`.
 *
 * @example
 * ```ts
 * import { Context } from 'weft';
 *
 * const ctx = new Context({ workflowId: 'wf-demo', workflowType: 'demo', startedAt: Date.now(), abortController: new AbortController() });
 * void ctx;
 * ```
 */
export class Context implements WorkflowContext {
  readonly workflowId: string;
  readonly workflowType: string;
  readonly startedAt: number;
  readonly signal: AbortSignal;
  constructor(options: ContextOptions) {
    this.workflowId = options.workflowId;
    this.workflowType = options.workflowType;
    this.startedAt = options.startedAt;
    this.signal = options.abortController.signal;
    const initialSessionState = normalizeSessionStateRecord(
      options.locals?.[SESSION_STATE_LOCAL_KEY],
    );
    initializeInternals(this, options, initialSessionState);
  }
  get tenant(): import('../tenant.ts').TenantContext | undefined {
    return getInternals(this).tenant;
  }
  get executionTimeRemaining(): number {
    const internals = getInternals(this);
    if (internals.deadline === undefined) return Infinity;
    return Math.max(0, internals.deadline - internals.getNow());
  }
  get stepIndex(): number {
    return getInternals(this).stepIndex;
  }
  get nestingDepth(): number {
    return getInternals(this).nestingDepth;
  }
  get accumulatedResults(): Map<number, unknown> {
    const internals = getInternals(this);
    internals.accumulatedResults ??= new Map();
    return internals.accumulatedResults;
  }
  get checkpointLocals(): Record<string, unknown> {
    return getInternals(this).checkpointLocals;
  }
  get pendingAttributeChanges(): Record<string, SearchAttributeValue> {
    const internals = getInternals(this);
    internals.pendingAttributeChanges ??= {};
    return internals.pendingAttributeChanges;
  }
  get exposedAccessors(): Map<string, () => unknown> {
    const internals = getInternals(this);
    internals.exposedValues ??= new Map();
    return internals.exposedValues;
  }
  get updateHandlers(): Map<string, (payload: unknown) => unknown> {
    const internals = getInternals(this);
    internals.updateHandlers ??= new Map();
    return internals.updateHandlers;
  }
  get explainEnabled(): boolean {
    return getInternals(this).explainMode;
  }
  get checkpointAccumulatedResults(): Array<[number, unknown]> {
    const accumulatedResults = getInternals(this).accumulatedResults;
    return accumulatedResults ? Array.from(accumulatedResults.entries()) : [];
  }
  get checkpointPendingAttributeChanges(): Record<string, SearchAttributeValue> | undefined {
    const pendingAttributeChanges = getInternals(this).pendingAttributeChanges;
    return pendingAttributeChanges ? { ...pendingAttributeChanges } : undefined;
  }
  get hasPendingAttributeChanges(): boolean {
    const pendingAttributeChanges = getInternals(this).pendingAttributeChanges;
    return pendingAttributeChanges !== undefined && Object.keys(pendingAttributeChanges).length > 0;
  }
  get hasUpdateHandlers(): boolean {
    const updateHandlers = getInternals(this).updateHandlers;
    return updateHandlers !== undefined && updateHandlers.size > 0;
  }
  get hasExposedAccessors(): boolean {
    const exposedValues = getInternals(this).exposedValues;
    return exposedValues !== undefined && exposedValues.size > 0;
  }
  // oxlint-disable-next-line complexity -- ID:core-context-create-speculative-child-complexity
  createSpeculativeChild(): Context {
    const internals = getInternals(this);
    const childOptions: ContextOptions = {
      workflowId: this.workflowId,
      workflowType: this.workflowType,
      startedAt: this.startedAt,
      abortController: internals.abortController,
      getNow: internals.getNow,
      initialStep: internals.stepIndex,
      ...(internals.accumulatedResults !== undefined
        ? { accumulatedResults: new Map(internals.accumulatedResults) }
        : {}),
      locals: internals.checkpointLocals,
      searchAttributes: internals.searchAttributes,
      nestingDepth: internals.nestingDepth,
      ...(internals.deadline !== undefined ? { deadline: internals.deadline } : {}),
      ...(internals.searchAttributeSchema !== undefined
        ? { searchAttributeSchema: internals.searchAttributeSchema }
        : {}),
      ...(internals.tenant !== undefined ? { tenant: internals.tenant } : {}),
      ...(internals.sleepReferenceTime !== undefined
        ? { sleepReferenceTime: internals.sleepReferenceTime }
        : {}),
      ...(internals.resolveWorkflowType !== undefined
        ? { resolveWorkflowType: internals.resolveWorkflowType }
        : {}),
    };
    const child = new Context(childOptions);
    const childInternals = getInternals(child);
    childInternals.pendingAttributeChanges =
      internals.pendingAttributeChanges !== undefined
        ? { ...internals.pendingAttributeChanges }
        : undefined;
    childInternals.updateHandlers =
      internals.updateHandlers !== undefined ? new Map(internals.updateHandlers) : undefined;
    childInternals.exposedValues =
      internals.exposedValues !== undefined ? new Map(internals.exposedValues) : undefined;
    childInternals.memoCache =
      internals.memoCache !== undefined ? new Map(internals.memoCache) : undefined;
    childInternals.explainMode = internals.explainMode;
    return child;
  }
  commitSpeculativeChild(child: Context): void {
    const internals = getInternals(this);
    const childInternals = getInternals(child);
    internals.stepIndex = childInternals.stepIndex;
    internals.accumulatedResults =
      childInternals.accumulatedResults !== undefined
        ? new Map(childInternals.accumulatedResults)
        : undefined;
    internals.sessionState = cloneSessionStateStore(childInternals.sessionState);
    internals.checkpointLocals = sessionStateHelpers.createCheckpointLocals(
      internals.sessionState,
      childInternals.checkpointLocals,
    );
    internals.searchAttributes = { ...childInternals.searchAttributes };
    internals.pendingAttributeChanges =
      childInternals.pendingAttributeChanges !== undefined
        ? { ...childInternals.pendingAttributeChanges }
        : undefined;
    internals.updateHandlers =
      childInternals.updateHandlers !== undefined
        ? new Map(childInternals.updateHandlers)
        : undefined;
    internals.exposedValues =
      childInternals.exposedValues !== undefined
        ? new Map(childInternals.exposedValues)
        : undefined;
    internals.memoCache =
      childInternals.memoCache !== undefined ? new Map(childInternals.memoCache) : undefined;
    internals.sleepReferenceTime = childInternals.sleepReferenceTime;
  }
  sessionState<T>(key: string, initialValue?: T): WorkflowSessionState<T> {
    return sessionStateHelpers.sessionState(this, getInternals(this), key, initialValue);
  }
  run<TArguments extends unknown[], TResult>(
    fn: (...args: TArguments) => Promise<TResult> | TResult,
    ...rest: TArguments
  ): Generator<ContextOperationRequest, TResult, unknown>;
  run<TArguments extends unknown[], TResult>(
    fn: (...args: TArguments) => Promise<TResult> | TResult,
    ...rest: [...TArguments, ActivityCallOptions]
  ): Generator<ContextOperationRequest, TResult, unknown>;
  // oxlint-disable-next-line complexity -- ID:core-context-fn-complexity
  *run<TResult>(
    fn: (...args: unknown[]) => Promise<TResult> | TResult,
    ...rest: unknown[]
  ): Generator<ContextOperationRequest, TResult, unknown> {
    let options: ActivityCallOptions | undefined;
    if (rest.length > 0 && sessionStateHelpers.isActivityCallOptions(rest[rest.length - 1])) {
      options = rest.pop() as ActivityCallOptions;
    }
    const args = rest;
    const internals = getInternals(this);
    const step = internals.stepIndex++;
    if (internals.accumulatedResults?.has(step)) {
      if (internals.explainMode) {
        console.log(
          `[weft] ctx.run(${fn.name || 'anonymous'}) → Returning cached result from step ${step}`,
        );
      }
      return internals.accumulatedResults.get(step) as TResult;
    }
    const queue = options?.queue ?? 'default';
    if (internals.explainMode) {
      console.log(`[weft] ctx.run(${fn.name || 'anonymous'}, ${JSON.stringify(args)})`);
      console.log(`  → Creating checkpoint at step ${step}`);
      console.log(`  → Dispatching activity "${fn.name || 'anonymous'}" to queue "${queue}"`);
    }
    const operationId = crypto.randomUUID();
    const callerStack = contextValidation.captureCallerStack();
    const result = yield {
      type: 'activity',
      operationId,
      activityName: fn.name || 'anonymous',
      fn,
      args,
      callerStack,
      ...(options !== undefined ? { options: options as Record<string, unknown> } : {}),
    };
    this.accumulatedResults.set(step, result);
    return result as TResult;
  }
  *sleep(duration: Duration): Generator<ContextOperationRequest, void, unknown> {
    return yield* durableOperations.sleep(this, getInternals(this), duration);
  }
  *suspendUntil<T = unknown>(resumeToken: string): Generator<ContextOperationRequest, T, unknown> {
    return yield* this.waitForSignal<T>(resumeToken);
  }
  *waitForSignal<T = unknown>(name: string): Generator<ContextOperationRequest, T, unknown> {
    return yield* durableOperations.waitForSignal<T>(this, getInternals(this), name);
  }
  *waitForUpdate<T = unknown>(
    name: string,
  ): Generator<
    ContextOperationRequest,
    { payload: T; respond: (result: unknown) => void },
    unknown
  > {
    return yield* durableOperations.waitForUpdate<T>(this, getInternals(this), name);
  }
  *humanReview(
    options: HumanReviewOptions,
  ): Generator<ContextOperationRequest, HumanReviewResult, unknown> {
    return yield* durableOperations.humanReview(this, getInternals(this), options);
  }
  *all(
    operations: Generator<ContextOperationRequest, unknown, unknown>[],
  ): Generator<ContextOperationRequest, unknown[], unknown> {
    return yield* parallelOperations.all(this, getInternals(this), operations);
  }
  *race(
    operations: Generator<ContextOperationRequest, unknown, unknown>[],
  ): Generator<ContextOperationRequest, unknown, unknown> {
    return yield* parallelOperations.race(this, getInternals(this), operations);
  }
  *memo<T>(key: string, fn: () => T | Promise<T>): Generator<ContextOperationRequest, T, unknown> {
    return yield* parallelOperations.memo(this, getInternals(this), key, fn);
  }
  *offload<T>(
    key: string,
    fn: () => Promise<T>,
  ): Generator<ContextOperationRequest, OffloadReference, unknown> {
    return yield* durableOperations.offload(this, getInternals(this), key, fn);
  }
  *stream(
    key: string,
    fn: (sink: StreamSink) => AsyncGenerator<unknown, void, unknown>,
  ): Generator<ContextOperationRequest, StreamReference, unknown> {
    return yield* durableOperations.stream(this, getInternals(this), key, fn);
  }
  *load<T>(reference: OffloadReference): Generator<ContextOperationRequest, T, unknown> {
    return yield* durableOperations.load<T>(this, getInternals(this), reference);
  }
  *archive(key: string, data: unknown): Generator<ContextOperationRequest, void, unknown> {
    return yield* durableOperations.archive(this, getInternals(this), key, data);
  }
  *runAll<T extends Record<string, [Function, ...unknown[]]>>(
    branches: T,
  ): Generator<ContextOperationRequest, Record<keyof T, unknown>, unknown> {
    return yield* parallelOperations.runAll(this, getInternals(this), branches);
  }
  *saga<TFinalOutput = unknown>(
    steps: ErasedSagaStep[],
  ): Generator<ContextOperationRequest, TFinalOutput, unknown> {
    return yield* sagaHelpers.saga<TFinalOutput>(this, steps);
  }
  *startChild<TResult = unknown>(
    workflowType: string,
    input: unknown,
    options?: ChildWorkflowOptions,
  ): Generator<ContextOperationRequest, TResult, unknown> {
    return yield* childWorkflowPipe.startChild<TResult>(
      this,
      getInternals(this),
      workflowType,
      input,
      options,
    );
  }
  pipe<TInput, TOutput>(
    stages: [WorkflowPipeStageDefinition<TInput, TOutput>],
    input: TInput,
  ): Generator<ContextOperationRequest, TOutput, unknown>;
  pipe<TInput, TIntermediate, TOutput>(
    stages: [
      WorkflowPipeStageDefinition<TInput, TIntermediate>,
      WorkflowPipeStageDefinition<TIntermediate, TOutput>,
    ],
    input: TInput,
  ): Generator<ContextOperationRequest, TOutput, unknown>;
  pipe<TInput, TFirst, TSecond, TOutput>(
    stages: [
      WorkflowPipeStageDefinition<TInput, TFirst>,
      WorkflowPipeStageDefinition<TFirst, TSecond>,
      WorkflowPipeStageDefinition<TSecond, TOutput>,
    ],
    input: TInput,
  ): Generator<ContextOperationRequest, TOutput, unknown>;
  pipe<TInput, TFirst, TSecond, TThird, TOutput>(
    stages: [
      WorkflowPipeStageDefinition<TInput, TFirst>,
      WorkflowPipeStageDefinition<TFirst, TSecond>,
      WorkflowPipeStageDefinition<TSecond, TThird>,
      WorkflowPipeStageDefinition<TThird, TOutput>,
    ],
    input: TInput,
  ): Generator<ContextOperationRequest, TOutput, unknown>;
  *pipe<TResult = unknown>(
    stages: Array<WorkflowPipeStage | ChildWorkflowTarget>,
    input: unknown,
  ): Generator<ContextOperationRequest, TResult, unknown> {
    return yield* childWorkflowPipe.pipe<TResult>(this, getInternals(this), stages, input);
  }
  *map<TItem, TResult>(
    items: readonly TItem[],
    workflowType: ChildWorkflowTarget<TItem, TResult>,
    options?: WorkflowMapOptions,
  ): Generator<ContextOperationRequest, TResult[], unknown> {
    return yield* childWorkflowPipe.map(this, getInternals(this), items, workflowType, options);
  }
  *reduce<TItem, TAccumulator>(
    items: readonly TItem[],
    workflowType: ChildWorkflowTarget<WorkflowReduceInput<TAccumulator, TItem>, TAccumulator>,
    initialValue: TAccumulator,
    options?: WorkflowReduceOptions,
  ): Generator<ContextOperationRequest, TAccumulator, unknown> {
    return yield* childWorkflowPipe.reduce(
      this,
      getInternals(this),
      items,
      workflowType,
      initialValue,
      options,
    );
  }
  explain(enabled: boolean = true): void {
    getInternals(this).explainMode = enabled;
  }
  *agent(options: AgentContextOptions): Generator<ContextOperationRequest, unknown, unknown> {
    return yield* aiOperations.agent(this, getInternals(this), options);
  }
  *speculate<TResult>(
    execute: (
      context: Context,
    ) =>
      | Generator<ContextOperationRequest, TResult, unknown>
      | AsyncGenerator<unknown, TResult, unknown>,
  ): Generator<ContextOperationRequest, TResult, unknown> {
    return yield* aiOperations.speculate<TResult>(this, getInternals(this), execute);
  }
  *handoff(options: HandoffOptions): Generator<ContextOperationRequest, HandoffResult, unknown> {
    return yield* aiOperations.handoff(this, getInternals(this), options);
  }
  *debate(options: DebateOptions): Generator<ContextOperationRequest, DebateResult, unknown> {
    return yield* aiOperations.debate(this, getInternals(this), options);
  }
  *supervise(
    options: SuperviseOptions,
  ): Generator<ContextOperationRequest, SuperviseResult, unknown> {
    return yield* aiOperations.supervise(this, getInternals(this), options);
  }
  setAttribute(key: string, value: SearchAttributeValue): void {
    contextAttributes.setAttribute(getInternals(this), key, value);
  }
  setAttributes(attributes: Record<string, SearchAttributeValue>): void {
    contextAttributes.setAttributes(getInternals(this), attributes);
  }
  getAttribute<T extends SearchAttributeValue = SearchAttributeValue>(key: string): T | undefined {
    return contextAttributes.getAttribute<T>(getInternals(this), key);
  }
  getAttributes(): Readonly<Record<string, SearchAttributeValue>> {
    return contextAttributes.getAttributes(getInternals(this));
  }
  onUpdate(name: string, handler: (payload: unknown) => unknown): void {
    contextUpdates.onUpdate(getInternals(this), name, handler);
  }
  expose(accessors: Record<string, () => unknown>): void {
    contextUpdates.expose(getInternals(this), accessors);
  }
  streamUrl(reference: StreamReference): string {
    return `/v1/workflows/${encodeURIComponent(reference.workflowId)}/streams/${encodeURIComponent(reference.key)}`;
  }
}
