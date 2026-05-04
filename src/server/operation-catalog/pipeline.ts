import { z } from 'zod';

import { evaluateAccess } from '../authorization.ts';
import type { OperationFault } from '../operation-fault.ts';
import {
  SUPPORTED_TRANSPORTS,
  UNSAFE_PROTOTYPE_KEYS,
  classifyEngineError,
  extractTopLevelObjectKeys,
  flattenZodIssues,
  sanitizeTopLevel,
  transportToAvailabilityKey,
  transportToPolicyKey,
} from './pipeline-helpers.ts';
import {
  type AuthorizationDecision,
  type DispatchContext,
  type DispatchResult,
  type ErasedOperation,
  type PipelineTrace,
  type PipelineTraceMarker,
  type UnknownKeyDisposition,
  type UnknownKeyPolicy,
} from './types.ts';

type ParseOutcome = { kind: 'ok'; input: unknown } | { kind: 'failure'; fault: OperationFault };

type PreParseOutcome =
  | {
      kind: 'ok';
      input: unknown;
      passthroughExtras: ReadonlyArray<readonly [string, unknown]>;
    }
  | { kind: 'failure'; fault: OperationFault };

/**
 * Single dispatch pipeline. Every transport calls this — there is no other
 * path to an operation invocation.
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
    return failure(classifyEngineError(error));
  }
  tracePipeline(pipelineTrace, 'invoked');
  const outputResult = validateAndReturnOutput<Output>(operation.outputSchema, output);
  if (outputResult.ok) tracePipeline(pipelineTrace, 'output-validated');
  return outputResult;
}

function checkTransport(
  operation: ErasedOperation,
  context: DispatchContext,
): DispatchResult<never> | null {
  if (operation.transports[transportToAvailabilityKey(context.transport)]) return null;

  const supported = SUPPORTED_TRANSPORTS.filter(
    (transport) => operation.transports[transportToAvailabilityKey(transport)],
  );
  return failure({
    code: 'UnsupportedTransport',
    message: `operation "${operation.name}" does not support transport "${context.transport}"`,
    data: { transport: context.transport, supported },
  });
}

function checkAccess(
  operation: ErasedOperation,
  context: DispatchContext,
): DispatchResult<never> | null {
  const access = evaluateAccess(operation.access, context.principal);
  if (access.allowed) return null;

  if (access.classification === 'unauthorized') {
    return failure({
      code: 'Unauthorized',
      message: access.reason,
      data: { reason: access.reason },
    });
  }
  return failure({
    code: 'Forbidden',
    message: access.reason,
    data: { reason: access.reason },
  });
}

async function checkAuthorization(
  operation: ErasedOperation,
  input: unknown,
  context: DispatchContext,
): Promise<DispatchResult<never> | null> {
  if (operation.authorize === undefined) return null;

  let decision: unknown;
  try {
    decision = await operation.authorize({
      input,
      principal: context.principal,
      engine: context.engine,
      transport: context.transport,
    });
  } catch {
    return failure({ code: 'EngineFailure', message: 'internal error', data: {} });
  }
  if (!isAuthorizationDecision(decision)) {
    return failure({ code: 'EngineFailure', message: 'internal error', data: {} });
  }
  if (!decision.allowed) {
    return failure({
      code: 'Forbidden',
      message: decision.reason,
      data: { reason: decision.reason },
    });
  }
  return null;
}

/**
 * Input parsing stage: apply the catalog's top-level unknown-key policy,
 * run the schema's `safeParse`, and re-attach passthrough extras onto a
 * prototype-safe null-prototype object.
 */
function parseAndApplyUnknownKeyPolicy(
  operation: ErasedOperation,
  rawInput: unknown,
  policyKey: keyof UnknownKeyPolicy,
  pipelineTrace?: PipelineTrace,
): ParseOutcome {
  const policy = operation.unknownKeyPolicy[policyKey];
  const knownKeys = readKnownTopLevelKeys(operation);
  if (knownKeys.kind === 'failure') return knownKeys;

  const preParse = buildPreParseInput(rawInput, policy, knownKeys.keys);
  if (preParse.kind === 'failure') return preParse;

  const parseResult = safeParseInput(operation.inputSchema, preParse.input);
  if (parseResult.kind === 'failure') return parseResult;
  tracePipeline(pipelineTrace, 'parsed');

  const parsed = parseResult.input as Record<string, unknown>;
  if (policy !== 'passthrough') {
    tracePipeline(pipelineTrace, 'unknown-key-policy-applied');
    return { kind: 'ok', input: parsed };
  }

  const passthroughOutput = buildPassthroughOutput(parsed, preParse.passthroughExtras);
  tracePipeline(pipelineTrace, 'unknown-key-policy-applied');
  return { kind: 'ok', input: passthroughOutput };
}

function tracePipeline(
  pipelineTrace: PipelineTrace | undefined,
  marker: PipelineTraceMarker,
): void {
  if (pipelineTrace === undefined) return;
  pipelineTrace(marker);
}

function readKnownTopLevelKeys(
  operation: ErasedOperation,
): { kind: 'ok'; keys: ReadonlySet<string> } | { kind: 'failure'; fault: OperationFault } {
  try {
    return { kind: 'ok', keys: extractTopLevelObjectKeys(operation.inputSchema) };
  } catch {
    return {
      kind: 'failure',
      fault: { code: 'EngineFailure', message: 'internal error', data: {} },
    };
  }
}

function buildPreParseInput(
  rawInput: unknown,
  policy: UnknownKeyDisposition,
  knownKeys: ReadonlySet<string>,
): PreParseOutcome {
  if (!isPlainObject(rawInput)) {
    return { kind: 'ok', input: rawInput, passthroughExtras: [] };
  }

  const rawRecord = rawInput;
  const unknownTopLevel = Object.keys(rawRecord).filter((key) => !knownKeys.has(key));
  if (unknownTopLevel.length === 0) {
    return { kind: 'ok', input: rawInput, passthroughExtras: [] };
  }

  if (policy === 'reject') {
    return {
      kind: 'failure',
      fault: {
        code: 'InvalidParams',
        message: 'unrecognized top-level keys',
        data: {
          issues: [
            {
              path: [],
              message: `unrecognized top-level keys: ${unknownTopLevel.join(', ')}`,
              code: 'unrecognized_keys',
            },
          ],
        },
      },
    };
  }

  return {
    kind: 'ok',
    input: sanitizeTopLevel(rawRecord, knownKeys),
    passthroughExtras: collectPassthroughExtras(rawRecord, unknownTopLevel, policy),
  };
}

function collectPassthroughExtras(
  rawInput: Record<string, unknown>,
  unknownTopLevel: ReadonlyArray<string>,
  policy: UnknownKeyDisposition,
): ReadonlyArray<readonly [string, unknown]> {
  if (policy !== 'passthrough') return [];
  return unknownTopLevel
    .filter((key) => !UNSAFE_PROTOTYPE_KEYS.has(key))
    .map((key) => [key, rawInput[key]] as const);
}

function buildPassthroughOutput(
  parsed: Record<string, unknown>,
  passthroughExtras: ReadonlyArray<readonly [string, unknown]>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = Object.create(null);
  for (const [key, value] of Object.entries(parsed)) {
    if (UNSAFE_PROTOTYPE_KEYS.has(key)) continue;
    merged[key] = value;
  }
  for (const [key, value] of passthroughExtras) {
    if (key in merged) continue;
    merged[key] = value;
  }
  return merged;
}

function safeParseInput(inputSchema: z.ZodType, input: unknown): ParseOutcome {
  let parseResult: ReturnType<typeof inputSchema.safeParse>;
  try {
    parseResult = inputSchema.safeParse(input);
  } catch {
    return {
      kind: 'failure',
      fault: { code: 'EngineFailure', message: 'internal error', data: {} },
    };
  }
  if (!parseResult.success) {
    return {
      kind: 'failure',
      fault: {
        code: 'InvalidParams',
        message: 'invalid params',
        data: { issues: flattenZodIssues(parseResult.error.issues) },
      },
    };
  }
  return { kind: 'ok', input: parseResult.data };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
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

function isAuthorizationDecision(value: unknown): value is AuthorizationDecision {
  if (typeof value !== 'object' || value === null) return false;
  let allowed: unknown;
  try {
    allowed = (value as { allowed?: unknown }).allowed;
  } catch {
    return false;
  }
  if (allowed === true) return true;
  if (allowed !== false) return false;
  let reason: unknown;
  try {
    reason = (value as { reason?: unknown }).reason;
  } catch {
    return false;
  }
  return typeof reason === 'string';
}

function failure(fault: OperationFault): DispatchResult<never> {
  return { ok: false, fault };
}
