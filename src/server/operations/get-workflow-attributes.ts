import { z } from 'zod';

import type { Engine } from '../../core/engine.ts';
import type { SearchAttributeValue } from '../../core/types.ts';
import { FAULT_CODE_TO_HTTP_STATUS, type OperationFault } from '../operation-fault.ts';
import { defineOperation } from '../operation-registry.ts';
import type { UnknownRestBinding } from '../rest-bindings.ts';

const getWorkflowAttributesInput = z.object({
  workflowId: z.string().min(1),
});
const getWorkflowAttributesOutput = z.unknown();

export type GetWorkflowAttributesInput = z.infer<typeof getWorkflowAttributesInput>;
export type GetWorkflowAttributesOutput = Record<string, SearchAttributeValue>;

export const getWorkflowAttributesOperation = defineOperation<
  GetWorkflowAttributesInput,
  GetWorkflowAttributesOutput
>({
  name: 'weft.workflows.attributes.get',
  summary: 'Get workflow attributes by id',
  tags: ['Attributes'],
  inputSchema: getWorkflowAttributesInput,
  outputSchema: getWorkflowAttributesOutput as z.ZodType<GetWorkflowAttributesOutput>,
  access: { kind: 'public' },
  producibleFaults: ['NotFound'],
  transports: { http: true, jsonRpcHttp: true, jsonRpcWebSocket: true, jsonRpcStdio: true },
  unknownKeyPolicy: { http: 'strip', jsonRpc: 'reject' },
  invoke: async ({ input, engine }): Promise<GetWorkflowAttributesOutput> => {
    const e = engine as Engine;
    const attributes = await e.getAttributes(input.workflowId);
    if (attributes === null) {
      const fault: OperationFault = {
        code: 'NotFound',
        message: `Attributes for workflow "${input.workflowId}" not found`,
        data: { resource: 'attributes', identifier: input.workflowId },
      };
      throw fault;
    }

    return attributes;
  },
});

function shapeGetWorkflowAttributesSuccess(result: GetWorkflowAttributesOutput): Response {
  return new Response(JSON.stringify(result), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function shapeGetWorkflowAttributesFault(fault: OperationFault): Response {
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

export const getWorkflowAttributesRestBinding: UnknownRestBinding = {
  method: 'GET',
  path: '/v1/workflows/:id/attributes',
  pathParamNames: ['id'],
  operationName: 'weft.workflows.attributes.get',
  inputSources: {
    workflowId: { kind: 'path', pathParam: 'id' },
  },
  extractInput: async (_request, pathParams) => ({ workflowId: pathParams['id'] ?? '' }),
  success: { kind: 'json', status: 200 },
  shapeSuccess: (output: GetWorkflowAttributesOutput) => shapeGetWorkflowAttributesSuccess(output),
  shapeFault: shapeGetWorkflowAttributesFault,
};
