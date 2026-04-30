import type { WeftAgentEventMap } from '../ai/events.ts';
import type { ConstraintViolation } from './constraint.ts';

/**
 * Fired on the {@link Engine} when a new workflow execution begins. Listen via
 * `engine.addEventListener('workflow:started', handler)` and read
 * `e.workflowId`, `e.workflowType`, and `e.input` directly off the event.
 *
 * @example
 * ```ts
 * import { Engine, WorkflowStartedEvent } from 'weft';
 *
 * const engine = new Engine();
 * engine.addEventListener('workflow:started', (e: Event) => {
 *   const ev = e as WorkflowStartedEvent;
 *   console.log('started', ev.workflowId, ev.workflowType);
 * });
 * engine.register('ping', async function* () { return 'pong'; });
 * await engine.start('ping', null);
 * ```
 */
export class WorkflowStartedEvent extends Event {
  static readonly type = 'workflow:started' as const;
  readonly workflowId: string;
  readonly workflowType: string;
  readonly input: unknown;

  constructor(workflowId: string, workflowType: string, input: unknown) {
    super(WorkflowStartedEvent.type);
    this.workflowId = workflowId;
    this.workflowType = workflowType;
    this.input = input;
  }
}

/**
 * Fired on the {@link Engine} when a workflow finishes successfully. Contains
 * the `result` and wall-clock `duration` in milliseconds. Read `e.workflowId`,
 * `e.result`, and `e.duration` directly off the event object.
 *
 * @example
 * ```ts
 * import { Engine, WorkflowCompletedEvent } from 'weft';
 *
 * const engine = new Engine();
 * engine.addEventListener('workflow:completed', (e: Event) => {
 *   const ev = e as WorkflowCompletedEvent;
 *   console.log('completed in', ev.duration, 'ms, result:', ev.result);
 * });
 * engine.register('ping', async function* () { return 'pong'; });
 * await (await engine.start('ping', null)).result();
 * ```
 */
export class WorkflowCompletedEvent extends Event {
  static readonly type = 'workflow:completed' as const;
  readonly workflowId: string;
  readonly result: unknown;
  readonly duration: number;

  constructor(workflowId: string, result: unknown, duration: number) {
    super(WorkflowCompletedEvent.type);
    this.workflowId = workflowId;
    this.result = result;
    this.duration = duration;
  }
}

/**
 * Fired on the {@link Engine} when a workflow terminates with an unhandled error.
 * The `error` property holds the thrown `Error` object. Listen to diagnose
 * failures without polling `handle.state()`.
 *
 * @example
 * ```ts
 * import { Engine, WorkflowFailedEvent } from 'weft';
 *
 * const engine = new Engine();
 * engine.addEventListener('workflow:failed', (e: Event) => {
 *   const ev = e as WorkflowFailedEvent;
 *   console.error('workflow', ev.workflowId, 'failed:', ev.error.message);
 * });
 * engine.register('boom', async function* () { throw new Error('oops'); });
 * await engine.start('boom', null).then(h => h.result()).catch(() => undefined);
 * ```
 */
export class WorkflowFailedEvent extends Event {
  static readonly type = 'workflow:failed' as const;
  readonly workflowId: string;
  readonly error: Error;

  constructor(workflowId: string, error: Error) {
    super(WorkflowFailedEvent.type);
    this.workflowId = workflowId;
    this.error = error;
  }
}

/**
 * Fired on the {@link Engine} when a workflow is cancelled via
 * `engine.cancel(workflowId)` or `handle.cancel()`. Contains only
 * `e.workflowId` since there is no result or error.
 *
 * @example
 * ```ts
 * import { Engine, WorkflowCancelledEvent } from 'weft';
 *
 * const engine = new Engine();
 * engine.addEventListener('workflow:cancelled', (e: Event) => {
 *   const ev = e as WorkflowCancelledEvent;
 *   console.log('cancelled', ev.workflowId);
 * });
 * engine.register('slow', async function* (_ctx: import('weft').WorkflowContext, _input: unknown) {
 *   await new Promise(() => {}); // never resolves
 * });
 * const handle = await engine.start('slow', null);
 * await handle.cancel();
 * ```
 */
export class WorkflowCancelledEvent extends Event {
  static readonly type = 'workflow:cancelled' as const;
  readonly workflowId: string;

  constructor(workflowId: string) {
    super(WorkflowCancelledEvent.type);
    this.workflowId = workflowId;
  }
}

/**
 * Fired on the {@link Engine} when a workflow exceeds its execution or run
 * timeout. Read `e.timeoutType` (`'execution'` or `'run'`) and `e.elapsed`
 * (milliseconds) to understand which limit was hit.
 *
 * @example
 * ```ts
 * import { Engine, WorkflowTimedOutEvent } from 'weft';
 *
 * const engine = new Engine();
 * engine.addEventListener('workflow:timed-out', (e: Event) => {
 *   const ev = e as WorkflowTimedOutEvent;
 *   console.log(ev.workflowId, 'timed out after', ev.elapsed, 'ms (', ev.timeoutType, ')');
 * });
 * ```
 */
export class WorkflowTimedOutEvent extends Event {
  static readonly type = 'workflow:timed-out' as const;
  readonly workflowId: string;
  readonly timeoutType: 'execution' | 'run';
  readonly elapsed: number;

  constructor(workflowId: string, timeoutType: 'execution' | 'run', elapsed: number) {
    super(WorkflowTimedOutEvent.type);
    this.workflowId = workflowId;
    this.timeoutType = timeoutType;
    this.elapsed = elapsed;
  }
}

/**
 * Fired whenever a workflow resumes execution — after a signal, update, sleep,
 * activity completion, or process restart recovery.
 *
 * @example
 * ```ts
 * import { Engine, WorkflowResumedEvent } from 'weft';
 *
 * const engine = new Engine();
 * engine.addEventListener('workflow:resumed', (e: Event) => {
 *   const ev = e as WorkflowResumedEvent;
 *   console.log('resumed', ev.workflowId, 'from step', ev.fromStep);
 * });
 * ```
 */
export class WorkflowResumedEvent extends Event {
  static readonly type = 'workflow:resumed' as const;
  readonly workflowId: string;
  readonly fromStep: number;

  constructor(workflowId: string, fromStep: number) {
    super(WorkflowResumedEvent.type);
    this.workflowId = workflowId;
    this.fromStep = fromStep;
  }
}

/**
 * Fired on the {@link Engine} when an activity begins execution. Use to
 * trace activity scheduling latency. Read `e.operationId`, `e.workflowId`,
 * `e.activityName`, and `e.attempt` directly off the event.
 *
 * @example
 * ```ts
 * import { Engine, ActivityStartedEvent } from 'weft';
 *
 * const engine = new Engine();
 * engine.addEventListener('activity:started', (e: Event) => {
 *   const ev = e as ActivityStartedEvent;
 *   console.log('activity started:', ev.activityName, 'attempt', ev.attempt);
 * });
 * ```
 */
export class ActivityStartedEvent extends Event {
  static readonly type = 'activity:started' as const;
  readonly operationId: string;
  readonly workflowId: string;
  readonly activityName: string;
  readonly attempt: number;

  constructor(operationId: string, workflowId: string, activityName: string, attempt: number) {
    super(ActivityStartedEvent.type);
    this.operationId = operationId;
    this.workflowId = workflowId;
    this.activityName = activityName;
    this.attempt = attempt;
  }
}

/**
 * Fired on the {@link Engine} when an activity execution completes successfully.
 * Read `e.operationId`, `e.workflowId`, `e.activityName`, and `e.duration`
 * (milliseconds) to observe activity latency.
 *
 * @example
 * ```ts
 * import { Engine, ActivityCompletedEvent } from 'weft';
 *
 * const engine = new Engine();
 * engine.addEventListener('activity:completed', (e: Event) => {
 *   const ev = e as ActivityCompletedEvent;
 *   console.log(ev.activityName, 'completed in', ev.duration, 'ms');
 * });
 * ```
 */
export class ActivityCompletedEvent extends Event {
  static readonly type = 'activity:completed' as const;
  readonly operationId: string;
  readonly workflowId: string;
  readonly activityName: string;
  readonly duration: number;

  constructor(operationId: string, workflowId: string, activityName: string, duration: number) {
    super(ActivityCompletedEvent.type);
    this.operationId = operationId;
    this.workflowId = workflowId;
    this.activityName = activityName;
    this.duration = duration;
  }
}

/**
 * Fired on the {@link Engine} when an activity execution throws an error.
 * Check `e.attempt` to distinguish first-attempt failures from retries.
 * Read `e.error` for the thrown error object. `attempt` is 1-indexed —
 * `attempt === 1` is the first execution; `attempt > 1` indicates a retry.
 *
 * @example
 * ```ts
 * import { Engine, ActivityFailedEvent } from 'weft';
 *
 * const engine = new Engine();
 * engine.addEventListener('activity:failed', (e: Event) => {
 *   const ev = e as ActivityFailedEvent;
 *   console.error(ev.activityName, 'attempt', ev.attempt, 'failed:', ev.error.message);
 * });
 * ```
 */
export class ActivityFailedEvent extends Event {
  static readonly type = 'activity:failed' as const;
  readonly operationId: string;
  readonly workflowId: string;
  readonly activityName: string;
  readonly error: Error;
  readonly attempt: number;

  constructor(
    operationId: string,
    workflowId: string,
    activityName: string,
    error: Error,
    attempt: number,
  ) {
    super(ActivityFailedEvent.type);
    this.operationId = operationId;
    this.workflowId = workflowId;
    this.activityName = activityName;
    this.error = error;
    this.attempt = attempt;
  }
}

/**
 * Fired on the {@link Engine} for each token streamed from an LLM during an
 * agent workflow. Read `e.workflowId`, `e.token`, and `e.model` to stream
 * tokens to clients in real time.
 *
 * @example
 * ```ts
 * import { Engine, TokenEvent } from 'weft';
 *
 * const engine = new Engine();
 * engine.addEventListener('agent:token', (e: Event) => {
 *   const ev = e as TokenEvent;
 *   console.log(ev.token);
 * });
 * ```
 */
export class TokenEvent extends Event {
  static readonly type = 'agent:token' as const;
  readonly workflowId: string;
  readonly token: string;
  readonly model: string;

  constructor(workflowId: string, token: string, model: string) {
    super(TokenEvent.type);
    this.workflowId = workflowId;
    this.token = token;
    this.model = model;
  }
}

/**
 * Fired on the {@link Engine} when a signal is delivered to a workflow via
 * `engine.signal` or `handle.signal`. Read `e.workflowId`, `e.signalName`,
 * and `e.payload` to observe signal delivery.
 *
 * @example
 * ```ts
 * import { Engine, SignalReceivedEvent } from 'weft';
 *
 * const engine = new Engine();
 * engine.addEventListener('signal:received', (e: Event) => {
 *   const ev = e as SignalReceivedEvent;
 *   console.log(ev.workflowId, 'received signal', ev.signalName);
 * });
 * ```
 */
export class SignalReceivedEvent extends Event {
  static readonly type = 'signal:received' as const;
  readonly workflowId: string;
  readonly signalName: string;
  readonly payload: unknown;

  constructor(workflowId: string, signalName: string, payload: unknown) {
    super(SignalReceivedEvent.type);
    this.workflowId = workflowId;
    this.signalName = signalName;
    this.payload = payload;
  }
}

/**
 * Fired on the {@link Engine} when a pending `waitForSignal` operation in a
 * workflow is resolved by the delivered signal. Emitted after the signal
 * unblocks the workflow and resumes execution.
 *
 * @example
 * ```ts
 * import { Engine, SignalDeliveredEvent } from 'weft';
 *
 * const engine = new Engine();
 * engine.addEventListener('signal:delivered', (e: Event) => {
 *   const ev = e as SignalDeliveredEvent;
 *   console.log('signal', ev.signalName, 'delivered to', ev.workflowId);
 * });
 * ```
 */
export class SignalDeliveredEvent extends Event {
  static readonly type = 'signal:delivered' as const;
  readonly workflowId: string;
  readonly signalName: string;

  constructor(workflowId: string, signalName: string) {
    super(SignalDeliveredEvent.type);
    this.workflowId = workflowId;
    this.signalName = signalName;
  }
}

/**
 * Fired on the {@link Engine} when a workflow's search attributes are updated
 * via `engine.setAttributes` or `ctx.setAttribute`. Read `e.changes` for the
 * map of attribute keys to their new values.
 *
 * @example
 * ```ts
 * import { Engine, AttributesChangedEvent } from 'weft';
 *
 * const engine = new Engine();
 * engine.addEventListener('attributes:changed', (e: Event) => {
 *   const ev = e as AttributesChangedEvent;
 *   console.log('attributes changed for', ev.workflowId, ev.changes);
 * });
 * ```
 */
export class AttributesChangedEvent extends Event {
  static readonly type = 'attributes:changed' as const;
  readonly workflowId: string;
  readonly changes: Record<string, unknown>;

  constructor(workflowId: string, changes: Record<string, unknown>) {
    super(AttributesChangedEvent.type);
    this.workflowId = workflowId;
    this.changes = changes;
  }
}

/**
 * Fired on the {@link Engine} when an update request is received for a workflow.
 * Contains the `updateId`, `name`, and `payload`. Precedes a corresponding
 * {@link UpdateCompletedEvent} once the workflow handler processes the update.
 *
 * @example
 * ```ts
 * import { Engine, UpdateReceivedEvent } from 'weft';
 *
 * const engine = new Engine();
 * engine.addEventListener('update:received', (e: Event) => {
 *   const ev = e as UpdateReceivedEvent;
 *   console.log('update', ev.name, 'received for', ev.workflowId, '(id:', ev.updateId, ')');
 * });
 * ```
 */
export class UpdateReceivedEvent extends Event {
  static readonly type = 'update:received' as const;
  readonly updateId: string;
  readonly workflowId: string;
  readonly name: string;
  readonly payload: unknown;

  constructor(updateId: string, workflowId: string, name: string, payload: unknown) {
    super(UpdateReceivedEvent.type);
    this.updateId = updateId;
    this.workflowId = workflowId;
    this.name = name;
    this.payload = payload;
  }
}

/**
 * Fired on the {@link Engine} when a workflow update handler returns a result
 * (or throws an error). Check `e.error` to distinguish success from failure;
 * on success, `e.result` holds the handler's return value.
 *
 * @example
 * ```ts
 * import { Engine, UpdateCompletedEvent } from 'weft';
 *
 * const engine = new Engine();
 * engine.addEventListener('update:completed', (e: Event) => {
 *   const ev = e as UpdateCompletedEvent;
 *   if (ev.error) {
 *     console.error('update', ev.name, 'failed:', ev.error);
 *   } else {
 *     console.log('update', ev.name, 'result:', ev.result);
 *   }
 * });
 * ```
 */
export class UpdateCompletedEvent extends Event {
  static readonly type = 'update:completed' as const;
  readonly updateId: string;
  readonly workflowId: string;
  readonly name: string;
  readonly result: unknown;
  readonly error: string | undefined;

  constructor(updateId: string, workflowId: string, name: string, result: unknown, error?: string) {
    super(UpdateCompletedEvent.type);
    this.updateId = updateId;
    this.workflowId = workflowId;
    this.name = name;
    this.result = result;
    this.error = error;
  }
}

/**
 * Fired on the {@link Engine} when a serialized checkpoint exceeds the
 * configured size threshold ({@link DEFAULT_CHECKPOINT_SIZE_WARNING_THRESHOLD}).
 * Read `e.sizeBytes` and `e.step` to identify the offending workflow step.
 *
 * @example
 * ```ts
 * import { Engine, CheckpointSizeWarningEvent } from 'weft';
 *
 * const engine = new Engine({ checkpointSizeWarningThreshold: 32_000 });
 * engine.addEventListener('checkpoint:size-warning', (e: Event) => {
 *   const ev = e as CheckpointSizeWarningEvent;
 *   console.warn(ev.workflowId, 'checkpoint at step', ev.step, 'is', ev.sizeBytes, 'bytes');
 * });
 * ```
 */
export class CheckpointSizeWarningEvent extends Event {
  static readonly type = 'checkpoint:size-warning' as const;
  readonly workflowId: string;
  readonly sizeBytes: number;
  readonly step: number;

  constructor(workflowId: string, sizeBytes: number, step: number) {
    super(CheckpointSizeWarningEvent.type);
    this.workflowId = workflowId;
    this.sizeBytes = sizeBytes;
    this.step = step;
  }
}

/**
 * Fired on the {@link Engine} (in development mode) when the engine detects
 * a potentially non-deterministic value in the workflow state — such as a Date
 * object, a function, or a class instance. Read `e.message` and `e.fieldPaths`
 * to locate the offending fields.
 *
 * @example
 * ```ts
 * import { Engine, DevelopmentWarningEvent } from 'weft';
 *
 * const engine = new Engine({ development: true });
 * engine.addEventListener('development:warning', (e: Event) => {
 *   const ev = e as DevelopmentWarningEvent;
 *   console.warn('[dev]', ev.message, 'paths:', ev.fieldPaths);
 * });
 * ```
 */
export class DevelopmentWarningEvent extends Event {
  static readonly type = 'development:warning' as const;
  readonly workflowId: string;
  readonly message: string;
  readonly fieldPaths: string[];

  constructor(workflowId: string, message: string, fieldPaths: string[]) {
    super(DevelopmentWarningEvent.type);
    this.workflowId = workflowId;
    this.message = message;
    this.fieldPaths = fieldPaths;
  }
}

export class CleanupWarningEvent extends Event {
  static readonly type = 'cleanup:warning' as const;
  readonly source: string;
  readonly error: Error;
  readonly workflowId: string | undefined;

  constructor(source: string, error: Error, workflowId?: string) {
    super(CleanupWarningEvent.type);
    this.source = source;
    this.error = error;
    this.workflowId = workflowId;
  }
}

/**
 * Fired on the {@link Engine} when the engine measures its total storage
 * footprint during a retention sweep. Read `e.sizeBytes` to track storage
 * growth over time.
 *
 * @example
 * ```ts
 * import { Engine, StorageSizeReportedEvent } from 'weft';
 *
 * const engine = new Engine();
 * engine.addEventListener('storage:size-reported', (e: Event) => {
 *   const ev = e as StorageSizeReportedEvent;
 *   console.log('total storage:', ev.sizeBytes, 'bytes');
 * });
 * ```
 */
export class StorageSizeReportedEvent extends Event {
  static readonly type = 'storage:size-reported' as const;
  readonly sizeBytes: number;

  constructor(sizeBytes: number) {
    super(StorageSizeReportedEvent.type);
    this.sizeBytes = sizeBytes;
  }
}

/**
 * Fired on the {@link Engine} when a built-in alert metric breaches its
 * threshold. Read `e.metric`, `e.threshold`, `e.currentValue`, and
 * optionally `e.window` to understand which alert triggered.
 *
 * @example
 * ```ts
 * import { Engine, AlertFiredEvent } from 'weft';
 *
 * const engine = new Engine();
 * engine.addEventListener('alert:fired', (e: Event) => {
 *   const ev = e as AlertFiredEvent;
 *   console.warn('alert fired:', ev.metric, 'current:', ev.currentValue, 'threshold:', ev.threshold);
 * });
 * ```
 */
export class AlertFiredEvent extends Event {
  static readonly type = 'alert:fired' as const;
  readonly metric: string;
  readonly threshold: number;
  readonly currentValue: number;
  readonly window: string | undefined;

  constructor(metric: string, threshold: number, currentValue: number, window?: string) {
    super(AlertFiredEvent.type);
    this.metric = metric;
    this.threshold = threshold;
    this.currentValue = currentValue;
    this.window = window;
  }
}

/**
 * Fired on the {@link Engine} when a previously fired alert returns below its
 * threshold. Mirrors {@link AlertFiredEvent} — read `e.metric`,
 * `e.currentValue`, and `e.threshold` to confirm the recovery.
 *
 * @example
 * ```ts
 * import { Engine, AlertResolvedEvent } from 'weft';
 *
 * const engine = new Engine();
 * engine.addEventListener('alert:resolved', (e: Event) => {
 *   const ev = e as AlertResolvedEvent;
 *   console.log('alert resolved:', ev.metric, 'value back to', ev.currentValue);
 * });
 * ```
 */
export class AlertResolvedEvent extends Event {
  static readonly type = 'alert:resolved' as const;
  readonly metric: string;
  readonly threshold: number;
  readonly currentValue: number;
  readonly window: string | undefined;

  constructor(metric: string, threshold: number, currentValue: number, window?: string) {
    super(AlertResolvedEvent.type);
    this.metric = metric;
    this.threshold = threshold;
    this.currentValue = currentValue;
    this.window = window;
  }
}

/**
 * Fired on the {@link Engine} when a domain constraint's `check` function
 * returns `false`. Read `e.constraintName`, `e.scope`, and `e.onViolation`
 * to identify which constraint fired and what action the engine took.
 *
 * @example
 * ```ts
 * import { Engine, ConstraintViolatedEvent } from 'weft';
 *
 * const engine = new Engine();
 * engine.addEventListener('constraint:violated', (e: Event) => {
 *   const ev = e as ConstraintViolatedEvent;
 *   console.warn('constraint', ev.constraintName, 'violated in', ev.workflowId,
 *     'action:', ev.onViolation);
 * });
 * ```
 */
export class ConstraintViolatedEvent extends Event {
  static readonly type = 'constraint:violated' as const;
  readonly workflowId: string;
  readonly constraintName: string;
  readonly scope: string;
  readonly onViolation: ConstraintViolation;

  constructor(
    workflowId: string,
    constraintName: string,
    scope: string,
    onViolation: ConstraintViolation,
  ) {
    super(ConstraintViolatedEvent.type);
    this.workflowId = workflowId;
    this.constraintName = constraintName;
    this.scope = scope;
    this.onViolation = onViolation;
  }
}

/**
 * Record mapping each event-name string the {@link Engine} dispatches to its
 * corresponding typed `Event` subclass. Use this as the type parameter for
 * {@link TypedEventTarget} to get type-safe `addEventListener` /
 * `removeEventListener` on the engine.
 *
 * @example
 * ```ts
 * import { Engine, type TypedEventTarget, type WeftEventMap } from 'weft';
 *
 * function listenAll(engine: Engine) {
 *   (engine as TypedEventTarget<WeftEventMap>)
 *     .addEventListener('workflow:completed', (e) => {
 *       console.log('done', e.workflowId, e.result);
 *     });
 * }
 * void listenAll;
 * ```
 */
export type WeftEventMap = WeftAgentEventMap & {
  'workflow:started': WorkflowStartedEvent;
  'workflow:completed': WorkflowCompletedEvent;
  'workflow:failed': WorkflowFailedEvent;
  'workflow:cancelled': WorkflowCancelledEvent;
  'workflow:timed-out': WorkflowTimedOutEvent;
  'workflow:resumed': WorkflowResumedEvent;
  'activity:started': ActivityStartedEvent;
  'activity:completed': ActivityCompletedEvent;
  'activity:failed': ActivityFailedEvent;
  'agent:token': TokenEvent;
  'signal:received': SignalReceivedEvent;
  'signal:delivered': SignalDeliveredEvent;
  'attributes:changed': AttributesChangedEvent;
  'update:received': UpdateReceivedEvent;
  'update:completed': UpdateCompletedEvent;
  'checkpoint:size-warning': CheckpointSizeWarningEvent;
  'development:warning': DevelopmentWarningEvent;
  'cleanup:warning': CleanupWarningEvent;
  'storage:size-reported': StorageSizeReportedEvent;
  'alert:fired': AlertFiredEvent;
  'alert:resolved': AlertResolvedEvent;
  'constraint:violated': ConstraintViolatedEvent;
};

/**
 * Typed version of the `EventTarget` interface that constrains
 * `addEventListener` and `removeEventListener` to the keys and event types
 * declared in `TEventMap`. The {@link Engine} implements this interface via
 * `WeftEventMap` so callers get IntelliSense on event names and strongly-typed
 * handler arguments.
 *
 * @example
 * ```ts
 * import { Engine, type TypedEventTarget, type WeftEventMap } from 'weft';
 *
 * function addTypedListener(target: TypedEventTarget<WeftEventMap>) {
 *   target.addEventListener('workflow:started', (e) => {
 *     console.log('started:', e.workflowId);
 *   });
 * }
 * const engine = new Engine();
 * addTypedListener(engine as TypedEventTarget<WeftEventMap>);
 * void engine;
 * ```
 */
export interface TypedEventTarget<TEventMap extends Record<string, Event>> {
  addEventListener<K extends keyof TEventMap & string>(
    type: K,
    listener: (event: TEventMap[K]) => void,
    options?: boolean | AddEventListenerOptions,
  ): void;
  addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions,
  ): void;
  removeEventListener<K extends keyof TEventMap & string>(
    type: K,
    listener: (event: TEventMap[K]) => void,
    options?: boolean | EventListenerOptions,
  ): void;
  removeEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | EventListenerOptions,
  ): void;
}
