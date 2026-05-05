import { z } from 'zod';

import {
  WorkflowAlreadyExistsError,
  WorkflowNotFoundError,
  WorkflowNotRegisteredError,
} from '../../core/engine/errors.ts';
import type { FlattenedZodIssue, OperationFault, TransportKind } from '../operation-fault.ts';
import type { TransportAvailability, UnknownKeyPolicy } from './types.ts';

export const SUPPORTED_TRANSPORTS: ReadonlyArray<TransportKind> = [
  'http-rest',
  'jsonRpcHttp',
  'jsonRpcWebSocket',
  'jsonRpcStdio',
];

export const UNSAFE_PROTOTYPE_KEYS: ReadonlySet<string> = new Set([
  '__proto__',
  'prototype',
  'constructor',
]);

export function transportToPolicyKey(transport: TransportKind): keyof UnknownKeyPolicy {
  return transport === 'http-rest' ? 'http' : 'jsonRpc';
}

export function transportToAvailabilityKey(transport: TransportKind): keyof TransportAvailability {
  switch (transport) {
    case 'http-rest':
      return 'http';
    case 'jsonRpcHttp':
      return 'jsonRpcHttp';
    case 'jsonRpcWebSocket':
      return 'jsonRpcWebSocket';
    case 'jsonRpcStdio':
      return 'jsonRpcStdio';
  }
}

/**
 * Extract the top-level keys of an object schema. The registry validates at
 * construction time that every `inputSchema` is a `z.ZodObject`.
 */
export function extractTopLevelObjectKeys(schema: z.ZodType): ReadonlySet<string> {
  if (!(schema instanceof z.ZodObject)) {
    throw new Error(
      'extractTopLevelObjectKeys called with a non-object schema — the operation registry should have rejected this at construction',
    );
  }
  return new Set(Object.keys(schema.shape).filter((key) => !UNSAFE_PROTOTYPE_KEYS.has(key)));
}

/**
 * Build a prototype-safe shallow projection of `rawInput` containing only
 * keys present in `knownKeys`.
 */
export function sanitizeTopLevel(
  rawInput: Record<string, unknown>,
  knownKeys: ReadonlySet<string>,
): Record<string, unknown> {
  const out: Record<string, unknown> = Object.create(null);
  for (const key of Object.keys(rawInput)) {
    if (UNSAFE_PROTOTYPE_KEYS.has(key)) continue;
    if (knownKeys.has(key)) {
      out[key] = rawInput[key];
    }
  }
  return out;
}

export function flattenZodIssues(
  issues: ReadonlyArray<{
    path: ReadonlyArray<PropertyKey>;
    message: string;
    code: string;
  }>,
): ReadonlyArray<FlattenedZodIssue> {
  return issues.map((issue) => ({
    path: issue.path.map((segment) =>
      typeof segment === 'string' || typeof segment === 'number' ? segment : String(segment),
    ),
    message: issue.message,
    code: issue.code,
  }));
}

/**
 * Translate a thrown value from `invoke` into a transport-neutral
 * OperationFault.
 *
 * Typed engine errors (`WorkflowAlreadyExistsError`,
 * `WorkflowNotFoundError`, `WorkflowNotRegisteredError`) are matched first
 * so the fault classification is robust against future error-message
 * rewording. Plain `Error` instances fall through to the message-pattern
 * heuristics, which exist as a last-resort generic catch-all.
 */
export function classifyEngineError(error: unknown): OperationFault {
  if (isOperationFault(error)) {
    return error;
  }
  if (error instanceof WorkflowAlreadyExistsError) {
    return {
      code: 'Conflict',
      message: 'conflict',
      data: { reason: 'resource already exists' },
    };
  }
  if (error instanceof WorkflowNotFoundError || error instanceof WorkflowNotRegisteredError) {
    return {
      code: 'NotFound',
      message: 'not found',
      data: { resource: 'workflow' },
    };
  }
  if (error instanceof Error) {
    return classifyErrorMessage(error);
  }
  return { code: 'EngineFailure', message: 'internal error', data: {} };
}

function classifyErrorMessage(error: Error): OperationFault {
  let rawMessage: unknown;
  try {
    rawMessage = error.message;
  } catch {
    return { code: 'EngineFailure', message: 'internal error', data: {} };
  }
  if (typeof rawMessage !== 'string') {
    return { code: 'EngineFailure', message: 'internal error', data: {} };
  }
  const message = rawMessage.toLowerCase();
  if (message.includes('not found')) {
    return {
      code: 'NotFound',
      message: 'not found',
      data: { resource: 'unknown' },
    };
  }
  if (message.includes('already exists')) {
    return {
      code: 'Conflict',
      message: 'conflict',
      data: { reason: 'resource already exists' },
    };
  }
  if (message.includes('timeout') || message.includes('timed out')) {
    return {
      code: 'Timeout',
      message: 'operation timed out',
      data: {},
    };
  }
  return { code: 'EngineFailure', message: 'internal error', data: {} };
}

const FAULT_CODES = {
  Unauthorized: true,
  Forbidden: true,
  NotFound: true,
  Conflict: true,
  Unprocessable: true,
  Timeout: true,
  RateLimited: true,
  NotImplemented: true,
  UnsupportedTransport: true,
  SubscriptionOverflow: true,
  InvalidParams: true,
  MethodNotFound: true,
  EngineFailure: true,
} as const satisfies Readonly<Record<OperationFault['code'], true>>;

function isOperationFault(value: unknown): value is OperationFault {
  if (typeof value !== 'object' || value === null) return false;
  let code: unknown;
  let message: unknown;
  let data: unknown;
  try {
    code = (value as { code?: unknown }).code;
    message = (value as { message?: unknown }).message;
    data = (value as { data?: unknown }).data;
  } catch {
    return false;
  }
  return (
    typeof code === 'string' &&
    typeof message === 'string' &&
    typeof data === 'object' &&
    data !== null &&
    !Array.isArray(data) &&
    Object.hasOwn(FAULT_CODES, code)
  );
}
