import { z } from 'zod';

import type { Engine } from '../../core/engine.ts';
import {
  assertExclusiveStartWorkflowOptions,
  coerceStartWorkflowDuration,
  coerceStartWorkflowId,
  coerceStartWorkflowTags,
  coerceStartWorkflowTimestamp,
  StartWorkflowValidationError,
} from '../../core/start-workflow-validation.ts';
import { QuotaExceededError } from '../../core/tenant-quotas.ts';
import type { StartOptions } from '../../core/types.ts';
import type { OperationFault } from '../operation-fault.ts';
import { defineOperation } from '../operation-registry.ts';
import type { UnknownRestBinding } from '../rest-bindings.ts';
import { invalidParamsFault, shapeRestFault } from './operation-helpers.ts';

// Inputs are intentionally permissive at the schema boundary so legacy REST
// callers (and equivalent JSON-RPC callers) hit the same validation in
// `invoke()` rather than being rejected by Zod with a different error path.
// All field validation lives in `invoke()` to keep one cross-transport contract.
const startWorkflowInput = z.object({
  type: z.unknown(),
  input: z.unknown().optional(),
  id: z.unknown().optional(),
  executionTimeout: z.unknown().optional(),
  startAt: z.unknown().optional(),
  startAfter: z.unknown().optional(),
  tags: z.unknown().optional(),
});

const startWorkflowOutput = z.object({
  id: z.string(),
});

export type StartWorkflowInput = z.infer<typeof startWorkflowInput>;
export type StartWorkflowOutput = z.infer<typeof startWorkflowOutput>;

export const startWorkflowOperation = defineOperation<StartWorkflowInput, StartWorkflowOutput>({
  name: 'weft.workflows.start',
  summary: 'Start a new workflow',
  tags: ['Workflows'],
  inputSchema: startWorkflowInput,
  outputSchema: startWorkflowOutput,
  access: { kind: 'public' },
  transports: { http: true, jsonRpcHttp: true, jsonRpcWebSocket: true, jsonRpcStdio: true },
  unknownKeyPolicy: { http: 'strip', jsonRpc: 'reject' },
  // oxlint-disable-next-line complexity -- ID:server-operations-start-workflow-invoke-complexity
  invoke: async ({ input, engine }): Promise<StartWorkflowOutput> => {
    const typedEngine = engine as Engine;

    // Validate `type` here so REST and JSON-RPC clients share one error path.
    if (typeof input.type !== 'string' || input.type.length === 0) {
      throw invalidParamsFault('Missing required field: type');
    }
    const type = input.type;

    let options: StartOptions;
    try {
      options = buildStartWorkflowOptions(input);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw invalidParamsFault(message);
    }

    try {
      const handle = await typedEngine.start(type, input.input, options);
      return { id: handle.id };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      if (error instanceof StartWorkflowValidationError) {
        throw invalidParamsFault(message);
      }
      if (error instanceof QuotaExceededError) {
        const fault: OperationFault = {
          code: 'RateLimited',
          message,
          data: {},
        };
        throw fault;
      }
      if (message.includes('No workflow registered')) {
        throw invalidParamsFault(message);
      }
      if (message.includes('already exists')) {
        const fault: OperationFault = {
          code: 'Conflict',
          message,
          data: { reason: message },
        };
        throw fault;
      }

      const fault: OperationFault = {
        code: 'EngineFailure',
        message,
        data: {},
      };
      throw fault;
    }
  },
});

function buildStartWorkflowOptions(input: StartWorkflowInput): StartOptions {
  const options: StartOptions = {};

  if (input.id !== undefined) {
    options.id = coerceStartWorkflowId(input.id, 'Field "id"');
  }
  if (input.executionTimeout !== undefined) {
    options.executionTimeout = coerceStartWorkflowDuration(
      input.executionTimeout,
      'Field "executionTimeout"',
    );
  }
  if (input.startAt !== undefined) {
    options.startAt = coerceStartWorkflowTimestamp(input.startAt, 'Field "startAt"');
  }
  if (input.startAfter !== undefined) {
    options.startAfter = coerceStartWorkflowDuration(input.startAfter, 'Field "startAfter"');
  }
  if (input.tags !== undefined) {
    options.tags = coerceStartWorkflowTags(input.tags, 'Field "tags"');
  }

  assertExclusiveStartWorkflowOptions(options.startAt, options.startAfter);

  return options;
}

export const startWorkflowRestBinding: UnknownRestBinding = {
  method: 'POST',
  path: '/v1/workflows',
  pathParamNames: [],
  operationName: 'weft.workflows.start',
  inputSources: {
    type: { kind: 'body-field', bodyField: 'type' },
    input: { kind: 'body-field', bodyField: 'input' },
    id: { kind: 'body-field', bodyField: 'id' },
    executionTimeout: { kind: 'body-field', bodyField: 'executionTimeout' },
    startAt: { kind: 'body-field', bodyField: 'startAt' },
    startAfter: { kind: 'body-field', bodyField: 'startAfter' },
    tags: { kind: 'body-field', bodyField: 'tags' },
  },
  extractInput: async (request) => {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      throw invalidParamsFault('Invalid JSON body');
    }

    // Legacy parity: arrays are typeof 'object', so they pass this guard and
    // fall through to the "Missing required field: type" check in `invoke`
    // (the single cross-transport validator).
    if (typeof body !== 'object' || body === null) {
      throw invalidParamsFault('Request body must be a JSON object');
    }

    const record = body as Record<string, unknown>;
    return {
      type: record['type'],
      input: record['input'],
      id: record['id'],
      executionTimeout: record['executionTimeout'],
      startAt: record['startAt'],
      startAfter: record['startAfter'],
      tags: record['tags'],
    };
  },
  success: { kind: 'json', status: 201 },
  shapeFault: shapeRestFault,
};
