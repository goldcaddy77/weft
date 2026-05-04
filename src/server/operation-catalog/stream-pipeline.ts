import { z } from 'zod';

import type { OperationFault } from '../operation-fault.ts';
import { classifyEngineError, transportToPolicyKey } from './pipeline-helpers.ts';
import {
  checkAccess,
  checkAuthorization,
  checkTransport,
  parseAndApplyUnknownKeyPolicy,
  tracePipeline,
} from './pipeline-stages.ts';
import {
  type DispatchContext,
  type DispatchResult,
  type ErasedOperation,
  type SubscriptionOperationInvocation,
} from './types.ts';

/**
 * Error thrown when an element emitted by a subscription or stream fails
 * per-element schema validation.
 */
export class SubscriptionElementValidationError extends Error {
  constructor(public readonly fault: OperationFault) {
    super('subscription element failed schema validation');
    this.name = 'SubscriptionElementValidationError';
  }
}

/**
 * Execute a `kind: 'stream'` operation and return a schema-validating
 * async iterable for its emitted elements.
 */
export async function executeStream<Element>(
  operationName: string,
  rawInput: unknown,
  context: DispatchContext,
): Promise<DispatchResult<AsyncIterable<Element>>> {
  const prepared = await prepareLongLivedOperation(operationName, rawInput, context, 'stream');
  if (!prepared.ok) return prepared;
  const { operation, input } = prepared.value;

  let invocation: unknown;
  try {
    invocation = await operation.invoke({
      input,
      principal: context.principal,
      engine: context.engine,
      transport: context.transport,
    });
  } catch (error) {
    return failure(classifyEngineError(error));
  }
  tracePipeline(context.pipelineTrace, 'invoked');

  if (!isAsyncIterable(invocation)) {
    return failure({ code: 'EngineFailure', message: 'internal error', data: {} });
  }

  const eventSchema = requireEventSchema(operation);
  if (!eventSchema.ok) return eventSchema;
  tracePipeline(context.pipelineTrace, 'output-validated');
  return {
    ok: true,
    value: validateElements<Element>(invocation, eventSchema.value),
  };
}

/**
 * Execute a `kind: 'subscription'` operation and return its validated
 * subscribe envelope, schema-validating element iterable, and close hook.
 */
export async function executeSubscription<Element, Envelope>(
  operationName: string,
  rawInput: unknown,
  context: DispatchContext,
): Promise<
  DispatchResult<{
    envelope: Envelope;
    iterable: AsyncIterable<Element>;
    close: () => Promise<void>;
  }>
> {
  const prepared = await prepareLongLivedOperation(
    operationName,
    rawInput,
    context,
    'subscription',
  );
  if (!prepared.ok) return prepared;
  const { operation, input } = prepared.value;

  let invocation: unknown;
  try {
    invocation = await operation.invoke({
      input,
      principal: context.principal,
      engine: context.engine,
      transport: context.transport,
    });
  } catch (error) {
    return failure(classifyEngineError(error));
  }
  tracePipeline(context.pipelineTrace, 'invoked');

  if (!isSubscriptionInvocation(invocation)) {
    return failure({ code: 'EngineFailure', message: 'internal error', data: {} });
  }

  const envelope = validateOutput<Envelope>(operation.outputSchema, invocation.envelope);
  if (!envelope.ok) return envelope;
  const eventSchema = requireEventSchema(operation);
  if (!eventSchema.ok) return eventSchema;
  tracePipeline(context.pipelineTrace, 'output-validated');

  return {
    ok: true,
    value: {
      envelope: envelope.value,
      iterable: validateElements<Element>(invocation.iterable, eventSchema.value),
      close: invocation.close,
    },
  };
}

async function prepareLongLivedOperation(
  operationName: string,
  rawInput: unknown,
  context: DispatchContext,
  expectedKind: 'stream' | 'subscription',
): Promise<DispatchResult<{ operation: ErasedOperation; input: unknown }>> {
  const pipelineTrace = context.pipelineTrace;
  const operation = context.registry.get(operationName);
  if (operation === undefined) {
    return failure({
      code: 'MethodNotFound',
      message: `unknown operation: ${operationName}`,
      data: { method: operationName },
    });
  }
  tracePipeline(pipelineTrace, 'looked-up');

  if ((operation.kind ?? 'unary') !== expectedKind) {
    return failure({
      code: 'Unprocessable',
      message: `operation "${operation.name}" is not ${expectedKind}`,
      data: { reason: `operation kind is "${operation.kind ?? 'unary'}"` },
    });
  }

  const transportFailure = checkTransport(operation, context);
  if (transportFailure !== null) return transportFailure;
  tracePipeline(pipelineTrace, 'transport-checked');

  const accessFailure = checkAccess(operation, context);
  if (accessFailure !== null) return accessFailure;
  tracePipeline(pipelineTrace, 'access-checked');

  const parseOutcome = parseAndApplyUnknownKeyPolicy(
    operation,
    rawInput,
    transportToPolicyKey(context.transport),
    pipelineTrace,
  );
  if (parseOutcome.kind === 'failure') return failure(parseOutcome.fault);

  const authorizationFailure = await checkAuthorization(operation, parseOutcome.input, context);
  if (authorizationFailure !== null) return authorizationFailure;
  tracePipeline(pipelineTrace, 'authorized');

  return { ok: true, value: { operation, input: parseOutcome.input } };
}

function requireEventSchema(operation: ErasedOperation): DispatchResult<z.ZodType> {
  if (operation.eventSchema !== undefined) {
    return { ok: true, value: operation.eventSchema };
  }
  return failure({
    code: 'EngineFailure',
    message: 'internal error',
    data: {},
  });
}

async function* validateElements<Element>(
  iterable: AsyncIterable<unknown>,
  eventSchema: z.ZodType,
): AsyncIterable<Element> {
  for await (const element of iterable) {
    let parsed: ReturnType<typeof eventSchema.safeParse>;
    try {
      parsed = eventSchema.safeParse(element);
    } catch {
      throw new SubscriptionElementValidationError(elementValidationFault());
    }
    if (!parsed.success) {
      throw new SubscriptionElementValidationError(elementValidationFault());
    }
    yield parsed.data as Element;
  }
}

function validateOutput<Output>(outputSchema: z.ZodType, output: unknown): DispatchResult<Output> {
  let outputParse: ReturnType<typeof outputSchema.safeParse>;
  try {
    outputParse = outputSchema.safeParse(output);
  } catch {
    return failure({ code: 'EngineFailure', message: 'internal error', data: {} });
  }
  if (!outputParse.success) {
    return failure({ code: 'EngineFailure', message: 'internal error', data: {} });
  }
  return { ok: true, value: outputParse.data as Output };
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return (
    value !== null &&
    typeof value === 'object' &&
    Symbol.asyncIterator in value &&
    typeof value[Symbol.asyncIterator] === 'function'
  );
}

function isSubscriptionInvocation(
  value: unknown,
): value is SubscriptionOperationInvocation<unknown, unknown> {
  if (value === null || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return (
    Object.hasOwn(record, 'envelope') &&
    isAsyncIterable(record['iterable']) &&
    typeof record['close'] === 'function'
  );
}

function elementValidationFault(): OperationFault {
  return { code: 'EngineFailure', message: 'internal error', data: {} };
}

function failure(fault: OperationFault): DispatchResult<never> {
  return { ok: false, fault };
}
