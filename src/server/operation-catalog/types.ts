import { z } from 'zod';

import type { AccessPolicy } from '../authorization.ts';
import type { OperationFault, TransportKind } from '../operation-fault.ts';
import type { Principal } from '../principal.ts';

/**
 * Regex for the canonical `weft.<segment>(.<segment>)+` operation-name form.
 * Mandatory `weft.` prefix and at least one additional dot-separated segment.
 */
export const OPERATION_NAME_PATTERN = /^weft\.[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*)+$/;

/** Throws if `name` does not match the canonical operation-name pattern. */
export function validateOperationName(name: string): void {
  if (!OPERATION_NAME_PATTERN.test(name)) {
    throw new Error(
      `invalid operation name "${name}" — must match weft.<segment>(.<segment>)+ where each segment starts with a lowercase ASCII letter and may contain lowercase ASCII letters or digits (e.g., "weft.workflows.start", "weft.workflows.list2")`,
    );
  }
}

/** Non-throwing variant of `validateOperationName`. */
export function isValidOperationName(name: string): boolean {
  return OPERATION_NAME_PATTERN.test(name);
}

/**
 * Per-operation transport availability flags. A `false` entry means callers
 * on that transport receive `UnsupportedTransport`, not `MethodNotFound`.
 */
export type TransportAvailability = {
  http: boolean;
  jsonRpcHttp: boolean;
  jsonRpcWebSocket: boolean;
  jsonRpcStdio: boolean;
};

/**
 * Per-transport unknown-key disposition. Top-level only; nested object
 * behavior is controlled by the zod schema's own object mode.
 */
export type UnknownKeyDisposition = 'reject' | 'strip' | 'passthrough';

export type UnknownKeyPolicy = {
  http: UnknownKeyDisposition;
  jsonRpc: UnknownKeyDisposition;
};

/**
 * Runtime shape of an operation. Unary operations return one validated
 * `outputSchema` value. Stream and subscription operations return long-lived
 * iterables whose elements are validated against `eventSchema`.
 */
export type OperationKind = 'unary' | 'stream' | 'subscription';

/** Invocation result for `kind: 'stream'` operations. */
export type StreamOperationInvocation<Element> = AsyncIterable<Element>;

/** Invocation result for `kind: 'subscription'` operations. */
export type SubscriptionOperationInvocation<Element, Envelope> = {
  readonly envelope: Envelope;
  readonly iterable: AsyncIterable<Element>;
  readonly close: () => Promise<void>;
};

export type OperationInvocationResult<Output> =
  | Output
  | StreamOperationInvocation<unknown>
  | SubscriptionOperationInvocation<unknown, Output>;

/**
 * Result of the parameter-aware `authorize` hook.
 *
 * **`reason` is wire-visible.** Hook authors must not embed secrets or
 * sensitive context in a denial reason.
 */
export type AuthorizationDecision = { allowed: true } | { allowed: false; reason: string };

/**
 * Stable audit markers emitted after each successful operation pipeline stage.
 */
export type PipelineTraceMarker =
  | 'looked-up'
  | 'transport-checked'
  | 'access-checked'
  | 'parsed'
  | 'unknown-key-policy-applied'
  | 'authorized'
  | 'invoked'
  | 'output-validated';

/**
 * Optional observer hook used by audit tests to prove a transport used the
 * full `executeOperation` pipeline.
 */
export type PipelineTrace = (marker: PipelineTraceMarker) => void;

/**
 * Context passed to both the `authorize` hook and `invoke`.
 */
export type OperationContext<Input> = {
  readonly input: Input;
  readonly principal: Principal;
  readonly engine: unknown;
  readonly transport: TransportKind;
};

export type OperationDefinition<Input, Output> = {
  readonly name: string;
  readonly kind?: OperationKind;
  readonly summary: string;
  readonly tags: ReadonlyArray<string>;
  readonly inputSchema: z.ZodType<Input>;
  /**
   * For unary operations, validates the returned value. For subscriptions,
   * validates the subscribe envelope. For streams, describes the start/SSE
   * metadata while each yielded element is validated by `eventSchema`.
   */
  readonly outputSchema: z.ZodType<Output>;
  readonly eventSchema?: z.ZodType;
  readonly access: AccessPolicy;
  readonly transports: TransportAvailability;
  readonly unknownKeyPolicy: UnknownKeyPolicy;
  readonly authorize?: (context: OperationContext<Input>) => Promise<AuthorizationDecision>;
  readonly invoke: (context: OperationContext<Input>) => Promise<OperationInvocationResult<Output>>;
};

/**
 * An operation with its Input/Output type parameters erased. The dispatcher
 * only feeds values that have been validated by the operation's own schema.
 */
export type ErasedOperation = OperationDefinition<unknown, unknown>;

/** Read-only registry of operations keyed by name. */
export type OperationRegistry = {
  get(name: string): ErasedOperation | undefined;
  list(): ReadonlyArray<ErasedOperation>;
};

/**
 * Erased operation shape accepted by `createOperationRegistry`.
 */
export type RegistrableOperation = {
  readonly name: string;
  readonly kind?: OperationKind;
  readonly summary: string;
  readonly tags: ReadonlyArray<string>;
  readonly inputSchema: z.ZodType;
  readonly outputSchema: z.ZodType;
  readonly eventSchema?: z.ZodType;
  readonly access: AccessPolicy;
  readonly transports: TransportAvailability;
  readonly unknownKeyPolicy: UnknownKeyPolicy;
  readonly authorize?: (context: OperationContext<never>) => Promise<AuthorizationDecision>;
  readonly invoke: (
    context: OperationContext<never>,
  ) => Promise<OperationInvocationResult<unknown>>;
};

export type DispatchContext = {
  readonly principal: Principal;
  readonly engine: unknown;
  readonly transport: TransportKind;
  readonly registry: OperationRegistry;
  readonly pipelineTrace?: PipelineTrace;
};

export type DispatchResult<Output> =
  | { readonly ok: true; readonly value: Output }
  | { readonly ok: false; readonly fault: OperationFault };
