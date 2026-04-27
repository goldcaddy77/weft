import { z } from 'zod';

import type { Engine } from '../../core/engine.ts';
import { FAULT_CODE_TO_HTTP_STATUS, type OperationFault } from '../operation-fault.ts';
import { defineOperation } from '../operation-registry.ts';
import type { UnknownRestBinding } from '../rest-bindings.ts';

const getWorkflowResultInput = z.object({
  workflowId: z.string().min(1),
});
const getWorkflowResultOutput = z.unknown();

export type GetWorkflowResultInput = z.infer<typeof getWorkflowResultInput>;
export type GetWorkflowResultOutput = { result: unknown };

export const getWorkflowResultOperation = defineOperation<
  GetWorkflowResultInput,
  GetWorkflowResultOutput
>({
  name: 'weft.workflows.result.get',
  summary: 'Get workflow result by id',
  tags: ['Workflows'],
  inputSchema: getWorkflowResultInput,
  outputSchema: getWorkflowResultOutput as z.ZodType<GetWorkflowResultOutput>,
  access: { kind: 'public' },
  transports: { http: true, jsonRpcHttp: true, jsonRpcWebSocket: true, jsonRpcStdio: true },
  unknownKeyPolicy: { http: 'strip', jsonRpc: 'reject' },
  invoke: async ({ input, engine }): Promise<GetWorkflowResultOutput> => {
    const e = engine as Engine;
    const state = await e.get(input.workflowId);
    if (state === null) {
      const fault: OperationFault = {
        code: 'NotFound',
        message: `Workflow "${input.workflowId}" not found`,
        data: { resource: 'workflow', identifier: input.workflowId },
      };
      throw fault;
    }

    if (state.status === 'completed') {
      return { result: state.result };
    }

    if (state.status === 'failed') {
      const message = state.error ?? 'Workflow failed';
      const fault: OperationFault = {
        code: 'Unprocessable',
        message,
        data: { reason: message },
      };
      throw fault;
    }

    if (state.status === 'cancelled') {
      const fault: OperationFault = {
        code: 'Unprocessable',
        message: 'Workflow cancelled',
        data: { reason: 'Workflow cancelled' },
      };
      throw fault;
    }

    const handle = e.getHandle(input.workflowId);
    const timeoutMilliseconds = 30_000;

    try {
      const result = await Promise.race([
        handle.result(),
        new Promise<never>((_resolve, reject) => {
          setTimeout(
            () => reject(new Error('Timeout waiting for workflow result')),
            timeoutMilliseconds,
          );
        }),
      ]);

      return { result };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      if (message.includes('Timeout')) {
        const fault: OperationFault = {
          code: 'Timeout',
          message: 'Timeout waiting for workflow result',
          data: {},
        };
        throw fault;
      }

      const fault: OperationFault = {
        code: 'EngineFailure',
        message: 'internal error',
        data: {},
      };
      throw fault;
    }
  },
});

function shapeGetWorkflowResultSuccess(result: GetWorkflowResultOutput): Response {
  return new Response(JSON.stringify(result), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function shapeGetWorkflowResultFault(fault: OperationFault): Response {
  if (fault.code === 'NotFound') {
    return new Response(JSON.stringify({ error: fault.message }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  if (fault.code === 'Unprocessable') {
    return new Response(JSON.stringify({ error: fault.message }), {
      status: 422,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  if (fault.code === 'Timeout') {
    return new Response(JSON.stringify({ error: 'Timeout waiting for workflow result' }), {
      status: 408,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  if (fault.code === 'EngineFailure') {
    return new Response(JSON.stringify({ error: 'Internal server error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  return new Response(JSON.stringify({ error: fault.message }), {
    status: FAULT_CODE_TO_HTTP_STATUS[fault.code],
    headers: { 'Content-Type': 'application/json' },
  });
}

export const getWorkflowResultRestBinding: UnknownRestBinding = {
  method: 'GET',
  path: '/v1/workflows/:id/result',
  pathParamNames: ['id'],
  operationName: 'weft.workflows.result.get',
  inputSources: {
    workflowId: { kind: 'path', pathParam: 'id' },
  },
  extractInput: async (_request, pathParams) => ({ workflowId: pathParams['id'] ?? '' }),
  success: { kind: 'json', status: 200 },
  shapeSuccess: (output: GetWorkflowResultOutput) => shapeGetWorkflowResultSuccess(output),
  shapeFault: shapeGetWorkflowResultFault,
};
