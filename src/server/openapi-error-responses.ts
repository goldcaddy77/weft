/**
 * OpenAPI response helpers for catalogued operation faults.
 *
 * @module server/openapi-error-responses
 */

import type { ErasedOperation } from './operation-catalog.ts';
import { UNIVERSAL_FAULT_DEFAULTS } from './operation-catalog/raise-fault.ts';
import { FAULT_CODE_TO_HTTP_STATUS, type FaultCode } from './operation-fault.ts';

/**
 * Shared JSON error schema emitted as `#/components/schemas/Error`.
 */
export const ERROR_SCHEMA: Record<string, unknown> = {
  type: 'object',
  required: ['code', 'message'],
  properties: {
    code: { type: 'string', description: 'Machine-readable error code' },
    message: { type: 'string', description: 'Human-readable error description' },
    data: { description: 'Additional fault-specific context' },
  },
};

/**
 * Build OpenAPI error responses for an operation's declared producible faults
 * plus the universal pipeline fault defaults.
 */
export function buildErrorResponses(operation: ErasedOperation): Record<string, unknown> {
  const codes: Set<FaultCode> = new Set([
    ...UNIVERSAL_FAULT_DEFAULTS,
    ...(operation.producibleFaults ?? []),
  ]);

  const responses: Record<string, unknown> = {};
  for (const code of codes) {
    const status = String(FAULT_CODE_TO_HTTP_STATUS[code]);
    responses[status] = {
      description: code,
      content: {
        'application/json': {
          schema: { $ref: '#/components/schemas/Error' },
        },
      },
    };
  }
  return responses;
}
