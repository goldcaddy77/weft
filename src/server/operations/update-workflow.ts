import { z } from 'zod';

import type { Engine } from '../../core/engine.ts';
import { UpdateTimeoutError, WorkflowTerminalError } from '../../core/updates.ts';
import { FAULT_CODE_TO_HTTP_STATUS, type OperationFault } from '../operation-fault.ts';
import { defineOperation } from '../operation-registry.ts';
import type { UnknownRestBinding } from '../rest-bindings.ts';

const DEFAULT_UPDATE_TIMEOUT_MS = 30_000;

const updateWorkflowInput = z.object({
  workflowId: z.string().min(1),
  updateName: z.string().min(1),
  payload: z.unknown().optional(),
  timeout: z.number().optional(),
  idempotencyKey: z.string().optional(),
});

const updateWorkflowOutput = z.object({
  updateId: z.string(),
  result: z.unknown(),
});

export type UpdateWorkflowInput = z.infer<typeof updateWorkflowInput>;
export type UpdateWorkflowOutput = z.infer<typeof updateWorkflowOutput>;

export const updateWorkflowOperation = defineOperation<UpdateWorkflowInput, UpdateWorkflowOutput>({
  name: 'weft.workflows.update',
  summary: 'Send a synchronous update to a workflow',
  tags: ['Updates'],
  inputSchema: updateWorkflowInput,
  outputSchema: updateWorkflowOutput,
  access: { kind: 'public' },
  transports: { http: true, jsonRpcHttp: true, jsonRpcWebSocket: true, jsonRpcStdio: true },
  unknownKeyPolicy: { http: 'strip', jsonRpc: 'reject' },
  invoke: async ({ input, engine }): Promise<UpdateWorkflowOutput> => {
    const typedEngine = engine as Engine;
    const timeout = input.timeout ?? DEFAULT_UPDATE_TIMEOUT_MS;
    const options: { timeout: number; idempotencyKey?: string } = { timeout };
    if (input.idempotencyKey !== undefined) {
      options.idempotencyKey = input.idempotencyKey;
    }

    try {
      const result = await typedEngine.submitCoordinatedUpdate(
        input.workflowId,
        input.updateName,
        input.payload,
        options,
      );

      if (result.error !== undefined) {
        const fault: OperationFault = {
          code: 'Unprocessable',
          message: result.error,
          data: { reason: result.error },
        };
        throw fault;
      }

      return {
        updateId: result.updateId,
        result: result.result,
      };
    } catch (error) {
      if (isOperationFault(error)) {
        throw error;
      }
      if (error instanceof WorkflowTerminalError) {
        const fault: OperationFault = {
          code: 'Unprocessable',
          message: error.message,
          data: { reason: error.message },
        };
        throw fault;
      }
      if (error instanceof UpdateTimeoutError) {
        const fault: OperationFault = {
          code: 'Timeout',
          message: error.message,
          data: {},
        };
        throw fault;
      }

      const message = error instanceof Error ? error.message : String(error);
      const fault: OperationFault = {
        code: 'EngineFailure',
        message,
        data: {},
      };
      throw fault;
    }
  },
});

function isOperationFault(error: unknown): error is OperationFault {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    'message' in error &&
    'data' in error
  );
}

function shapeUpdateWorkflowFault(fault: OperationFault): Response {
  if (fault.code === 'Unprocessable') {
    return jsonErrorResponse(fault.message, 422);
  }
  if (fault.code === 'Timeout') {
    return jsonErrorResponse(fault.message, 408);
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

export const updateWorkflowRestBinding: UnknownRestBinding = {
  method: 'POST',
  path: '/v1/workflows/:id/update/:name',
  pathParamNames: ['id', 'name'],
  operationName: 'weft.workflows.update',
  inputSources: {
    workflowId: { kind: 'path', pathParam: 'id' },
    updateName: { kind: 'path', pathParam: 'name' },
    payload: { kind: 'body-field', bodyField: 'payload' },
    timeout: { kind: 'body-field', bodyField: 'timeout' },
    idempotencyKey: { kind: 'body-field', bodyField: 'idempotencyKey' },
  },
  extractInput: async (request, pathParams) => {
    let payload: unknown;
    let timeout: number | undefined;
    let idempotencyKey: string | undefined;

    try {
      const body = await request.json();
      if (typeof body === 'object' && body !== null && !Array.isArray(body)) {
        payload = body['payload'];
        if (typeof body['timeout'] === 'number') {
          timeout = body['timeout'];
        }
        if (typeof body['idempotencyKey'] === 'string') {
          idempotencyKey = body['idempotencyKey'];
        }
      }
    } catch {
      // Legacy behavior: invalid or absent JSON body is ignored.
    }

    return {
      workflowId: pathParams['id'] ?? '',
      updateName: pathParams['name'] ?? '',
      ...(payload !== undefined ? { payload } : {}),
      ...(timeout !== undefined ? { timeout } : {}),
      ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
    };
  },
  success: { kind: 'json', status: 200 },
  shapeFault: shapeUpdateWorkflowFault,
};
