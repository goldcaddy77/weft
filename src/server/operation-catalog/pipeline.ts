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
import { type DispatchContext, type DispatchResult } from './types.ts';

/**
 * Single request/response dispatch pipeline. Every request/response transport
 * call goes through the same transport, access, input validation,
 * authorization, invocation, and output-validation stages.
 */
export async function executeOperation<Output>(
  operationName: string,
  rawInput: unknown,
  context: DispatchContext,
): Promise<DispatchResult<Output>> {
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

  let output: unknown;
  try {
    output = await operation.invoke({
      input: parseOutcome.input,
      principal: context.principal,
      engine: context.engine,
      transport: context.transport,
    });
  } catch (error) {
    return failure(classifyEngineError(error, operation));
  }
  tracePipeline(pipelineTrace, 'invoked');

  const outputResult = validateAndReturnOutput<Output>(operation.outputSchema, output);
  if (outputResult.ok) tracePipeline(pipelineTrace, 'output-validated');
  return outputResult;
}

function validateAndReturnOutput<Output>(
  outputSchema: z.ZodType,
  output: unknown,
): DispatchResult<Output> {
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

function failure(fault: OperationFault): DispatchResult<never> {
  return { ok: false, fault };
}
