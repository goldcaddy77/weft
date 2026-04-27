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
import { FAULT_CODE_TO_HTTP_STATUS, type OperationFault } from '../operation-fault.ts';
import { defineOperation } from '../operation-registry.ts';
import type { UnknownRestBinding } from '../rest-bindings.ts';

const startWorkflowInput = z.object({
  type: z.string().min(1),
  input: z.unknown().optional(),
  id: z.string().optional(),
  executionTimeout: z.union([z.string(), z.number()]).optional(),
  startAt: z.number().optional(),
  startAfter: z.union([z.string(), z.number()]).optional(),
  tags: z.array(z.unknown()).optional(),
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
  invoke: async ({ input, engine }): Promise<StartWorkflowOutput> => {
    const typedEngine = engine as Engine;

    let options: StartOptions;
    try {
      options = buildStartWorkflowOptions(input);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw invalidParamsFault(message);
    }

    try {
      const handle = await typedEngine.start(input.type, input.input, options);
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

function invalidParamsFault(message: string): OperationFault {
  return {
    code: 'InvalidParams',
    message,
    data: { issues: [] },
  };
}

function shapeStartWorkflowFault(fault: OperationFault): Response {
  if (fault.code === 'InvalidParams') {
    return jsonErrorResponse(fault.message, 400);
  }
  if (fault.code === 'RateLimited') {
    return jsonErrorResponse(fault.message, 429);
  }
  if (fault.code === 'Conflict') {
    return jsonErrorResponse(fault.message, 409);
  }
  if (fault.code === 'EngineFailure') {
    return jsonErrorResponse(fault.message, 500);
  }

  return jsonErrorResponse(fault.message, FAULT_CODE_TO_HTTP_STATUS[fault.code]);
}

function jsonErrorResponse(message: string, status: number): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
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

    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      throw invalidParamsFault('Request body must be a JSON object');
    }

    const record = body as Record<string, unknown>;
    const type = record['type'];
    if (typeof type !== 'string' || type.length === 0) {
      throw invalidParamsFault('Missing required field: type');
    }

    return {
      type,
      input: record['input'],
      id: record['id'],
      executionTimeout: record['executionTimeout'],
      startAt: record['startAt'],
      startAfter: record['startAfter'],
      tags: record['tags'],
    };
  },
  success: { kind: 'json', status: 201 },
  shapeFault: shapeStartWorkflowFault,
};
