import { z } from 'zod';

import type { Engine } from '../../core/engine.ts';
import { FAULT_CODE_TO_HTTP_STATUS, type OperationFault } from '../operation-fault.ts';
import { defineOperation } from '../operation-registry.ts';
import type { UnknownRestBinding } from '../rest-bindings.ts';

const forkWorkflowInput = z.object({
  workflowId: z.string().min(1),
  fromStep: z.number().int().min(0).safe().optional(),
});

const forkWorkflowOutput = z.object({
  id: z.string(),
});

export type ForkWorkflowInput = z.infer<typeof forkWorkflowInput>;
export type ForkWorkflowOutput = z.infer<typeof forkWorkflowOutput>;

export const forkWorkflowOperation = defineOperation<ForkWorkflowInput, ForkWorkflowOutput>({
  name: 'weft.workflows.fork',
  summary: 'Fork a workflow from a checkpoint',
  tags: ['Workflows'],
  inputSchema: forkWorkflowInput,
  outputSchema: forkWorkflowOutput,
  access: { kind: 'public' },
  transports: { http: true, jsonRpcHttp: true, jsonRpcWebSocket: true, jsonRpcStdio: true },
  unknownKeyPolicy: { http: 'strip', jsonRpc: 'reject' },
  invoke: async ({ input, engine }): Promise<ForkWorkflowOutput> => {
    const typedEngine = engine as Engine;
    const options = input.fromStep !== undefined ? { fromStep: input.fromStep } : undefined;

    try {
      const handle = await typedEngine.fork(input.workflowId, options);
      return { id: handle.id };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      if (message.includes('fromStep') || message.includes('Checkpoint not found at step')) {
        throw invalidParamsFault(message);
      }
      if (message.includes('Checkpoint not found')) {
        const fault: OperationFault = {
          code: 'NotFound',
          message,
          data: { resource: 'checkpoint' },
        };
        throw fault;
      }
      if (message.includes('not found')) {
        const fault: OperationFault = {
          code: 'NotFound',
          message,
          data: { resource: 'workflow' },
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

function invalidParamsFault(message: string): OperationFault {
  return {
    code: 'InvalidParams',
    message,
    data: { issues: [] },
  };
}

function shapeForkWorkflowFault(fault: OperationFault): Response {
  if (fault.code === 'InvalidParams') {
    return jsonErrorResponse(fault.message, 400);
  }
  if (fault.code === 'NotFound') {
    return jsonErrorResponse(fault.message, 404);
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

export const forkWorkflowRestBinding: UnknownRestBinding = {
  method: 'POST',
  path: '/v1/workflows/:id/fork',
  pathParamNames: ['id'],
  operationName: 'weft.workflows.fork',
  inputSources: {
    workflowId: { kind: 'path', pathParam: 'id' },
    fromStep: { kind: 'body-field', bodyField: 'fromStep' },
  },
  extractInput: async (request, pathParams) => {
    const rawBody = await request.text();
    if (rawBody.trim().length === 0) {
      return { workflowId: pathParams['id'] ?? '' };
    }

    let body: unknown;
    try {
      body = JSON.parse(rawBody) as unknown;
    } catch {
      throw invalidParamsFault('Invalid JSON body');
    }

    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      throw invalidParamsFault('Request body must be a JSON object');
    }

    const record = body as Record<string, unknown>;
    const fromStep = record['fromStep'];
    if (fromStep === undefined) {
      return { workflowId: pathParams['id'] ?? '' };
    }

    if (typeof fromStep !== 'number' || !Number.isSafeInteger(fromStep) || fromStep < 0) {
      throw invalidParamsFault('Field "fromStep" must be a non-negative safe integer');
    }

    return {
      workflowId: pathParams['id'] ?? '',
      fromStep,
    };
  },
  success: { kind: 'json', status: 201 },
  shapeFault: shapeForkWorkflowFault,
};
