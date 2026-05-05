import type { AgentTool, LLMProvider } from '../../ai/agent/index.ts';
import type { ActivityDefinition, SearchAttributeSchema, SearchAttributeValue } from '../types.ts';

/**
 * A single step in a saga: an activity definition and the input to pass to it.
 *
 * `TInput` and `TOutput` are inferred from the definition so that `compensate`
 * receives correctly-typed arguments at the definition site. At the array
 * boundary inside `ctx.saga`, types are erased to `unknown` — the
 * implementation guarantees that the input passed to `execute` and `compensate`
 * always matches what was supplied in the original step object.
 *
 * @example
 * ```ts
 * import { activity, type SagaStep, type WorkflowContext } from 'weft';
 * import type { Context } from 'weft';
 *
 * const chargeCard = activity({
 *   name: 'chargeCard',
 *   execute: async (input: unknown) => ({ chargeId: 'ch-123' }),
 *   compensate: async (_input, _output) => { return; },
 * });
 *
 * const step: SagaStep<unknown, { chargeId: string }> = {
 *   definition: chargeCard,
 *   input: { amount: 99 },
 * };
 * void step;
 * ```
 */
export interface SagaStep<TInput = unknown, TOutput = unknown> {
  definition: ActivityDefinition<TInput, TOutput>;
  input: TInput;
}

// Method-syntax declarations use bivariant parameter checking under
// strictFunctionTypes, which lets ActivityDefinition<string, string>.execute
// be assigned to this erased interface.
export interface ErasedActivityDefinition {
  name: string;
  execute(input: unknown, context?: unknown): unknown;
  compensate?(input: unknown, output?: unknown): unknown;
}

export interface ErasedSagaStep {
  definition: ErasedActivityDefinition;
  input: unknown;
}

/**
 * Reference returned by `ctx.offload(key, fn)`. Store this in a local
 * variable or pass it downstream — the engine keeps the heavy payload in
 * storage and only checkpoints the lightweight reference. Retrieve the
 * original value with `ctx.load(reference)`. Offload references are plain
 * JSON-shaped objects, so they survive structured cloning, MessagePack
 * encoding, and worker postMessage transfers — return them as workflow
 * results or store them in attributes.
 *
 * @example
 * ```ts
 * import { activity, Engine, type OffloadReference } from 'weft';
 * import type { Context, WorkflowContext } from 'weft';
 *
 * const engine = new Engine();
 * engine.register('heavy', async function* (ctx: WorkflowContext, input: unknown) {
 *   const ref: OffloadReference = yield* (ctx as Context).offload(
 *     'large-payload',
 *     async () => ({ data: 'x'.repeat(100_000) }),
 *   );
 *   console.log(ref.sizeBytes);
 *   const payload = yield* (ctx as Context).load(ref);
 *   return payload;
 * });
 * void engine;
 * ```
 */
export interface OffloadReference {
  key: string;
  workflowId: string;
  sizeBytes: number;
}

/**
 * Reference to a multi-chunk stream stored via `ctx.stream(key, fn)`. Contains
 * the storage key, workflow ID, chunk count, and total byte size.
 *
 * @example
 * ```ts
 * import { Engine, type StreamReference } from 'weft';
 * import type { Context, WorkflowContext } from 'weft';
 *
 * const engine = new Engine();
 * engine.register('streamer', async function* (ctx: WorkflowContext) {
 *   const ref: StreamReference = yield* (ctx as Context).stream('tokens', async function* () {
 *     yield 'hello';
 *   });
 *   return ref.chunkCount;
 * });
 * ```
 */
export interface StreamReference {
  key: string;
  workflowId: string;
  chunkCount: number;
  totalSizeBytes: number;
}

/**
 * A single chunk persisted by `ctx.stream`. The `sequence` field is the
 * zero-based chunk index used to reassemble the stream in order on replay.
 */
export interface StoredStreamChunk<T = unknown> {
  sequence: number;
  value: T;
}

/**
 * Callback object passed to the async generator function inside `ctx.stream`.
 * Call `sink.heartbeat()` periodically to extend the stream's visibility
 * timeout and prevent the engine from marking it as stalled.
 *
 * @example
 * ```ts
 * import { Engine, type StreamSink } from 'weft';
 * import type { Context, WorkflowContext } from 'weft';
 *
 * const engine = new Engine();
 * engine.register('streamer', async function* (ctx: WorkflowContext) {
 *   yield* (ctx as Context).stream('tokens', async function* (sink: StreamSink) {
 *     sink.heartbeat({ chunk: 0 });
 *     yield 'hello';
 *   });
 * });
 * ```
 */
export interface StreamSink {
  heartbeat(details?: unknown): void;
}

export interface AgentContextOptions {
  model: string;
  prompt: string;
  provider: LLMProvider;
  tools?: AgentTool[];
  maxTurns?: number;
  systemPrompt?: string;
}

/**
 * Construction options for the {@link Context} class. Populated by the engine
 * before invoking a workflow generator; advanced consumers may construct
 * `Context` directly with these options.
 *
 * @example
 * ```ts
 * import { Context, type ContextOptions } from 'weft';
 *
 * const controller = new AbortController();
 * const options: ContextOptions = {
 *   workflowId: 'wf-demo',
 *   workflowType: 'demo',
 *   startedAt: Date.now(),
 *   abortController: controller,
 * };
 * const ctx = new Context(options);
 * void ctx;
 * ```
 */
export interface ContextOptions {
  workflowId: string;
  workflowType: string;
  startedAt: number;
  abortController: AbortController;
  deadline?: number;
  initialStep?: number;
  accumulatedResults?: Map<number, unknown>;
  locals?: Record<string, unknown>;
  searchAttributes?: Record<string, SearchAttributeValue>;
  searchAttributeSchema?: SearchAttributeSchema;
  getNow?: () => number;
  nestingDepth?: number;
  /**
   * The {@link TenantContext} resolved for this workflow, if any. Made
   * available to workflow code via `ctx.tenant`.
   */
  tenant?: import('../tenant.ts').TenantContext;
  /**
   * Reference timestamp used to compute `scheduledFireAt` for sleep operations.
   * When resuming from a checkpoint, this should be the checkpoint's `createdAt`.
   */
  sleepReferenceTime?: number;
  resolveWorkflowType?: (target: string | Function) => string;
}
