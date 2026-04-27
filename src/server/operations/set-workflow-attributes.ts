import { z } from 'zod';

import type { Engine } from '../../core/engine.ts';
import type { SearchAttributeValue } from '../../core/types.ts';
import { FAULT_CODE_TO_HTTP_STATUS, type OperationFault } from '../operation-fault.ts';
import { defineOperation } from '../operation-registry.ts';
import type { UnknownRestBinding } from '../rest-bindings.ts';

const setWorkflowAttributesInput = z.object({
  workflowId: z.string().min(1),
  attributes: z.unknown().optional(),
});
const setWorkflowAttributesOutput = z.object({
  ok: z.literal(true),
});

export type SetWorkflowAttributesInput = z.infer<typeof setWorkflowAttributesInput>;
export type SetWorkflowAttributesOutput = z.infer<typeof setWorkflowAttributesOutput>;

export const setWorkflowAttributesOperation = defineOperation<
  SetWorkflowAttributesInput,
  SetWorkflowAttributesOutput
>({
  name: 'weft.workflows.attributes.set',
  summary: 'Update search attributes for a workflow',
  tags: ['Attributes'],
  inputSchema: setWorkflowAttributesInput,
  outputSchema: setWorkflowAttributesOutput as z.ZodType<SetWorkflowAttributesOutput>,
  access: { kind: 'public' },
  transports: { http: true, jsonRpcHttp: true, jsonRpcWebSocket: true, jsonRpcStdio: true },
  unknownKeyPolicy: { http: 'strip', jsonRpc: 'reject' },
  invoke: async ({ input, engine }): Promise<SetWorkflowAttributesOutput> => {
    const e = engine as Engine;

    try {
      // Legacy REST forwarded whatever lived under `attributes`
      // directly into `engine.setAttributes`, defaulting only on
      // null/undefined. Keep that contract intact here.
      await e.setAttributes(
        input.workflowId,
        (input.attributes ?? {}) as Record<string, SearchAttributeValue>,
      );
      return { ok: true };
    } catch (error) {
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

function shapeSetWorkflowAttributesSuccess(output: SetWorkflowAttributesOutput): Response {
  return new Response(JSON.stringify(output), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function shapeSetWorkflowAttributesFault(fault: OperationFault): Response {
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

export const setWorkflowAttributesRestBinding: UnknownRestBinding = {
  method: 'PATCH',
  path: '/v1/workflows/:id/attributes',
  pathParamNames: ['id'],
  operationName: 'weft.workflows.attributes.set',
  inputSources: {
    workflowId: { kind: 'path', pathParam: 'id' },
    attributes: { kind: 'body-field', bodyField: 'attributes' },
  },
  extractInput: async (request, pathParams) => {
    const body = await request.json().catch(() => {
      throw new Error('Invalid JSON body');
    });

    if (body === null) {
      throw new Error('Invalid JSON body');
    }

    return {
      workflowId: pathParams['id'] ?? '',
      attributes:
        typeof body === 'object' ? (body as Record<string, unknown>)['attributes'] : undefined,
    };
  },
  success: { kind: 'json', status: 200 },
  shapeSuccess: (output: SetWorkflowAttributesOutput) => shapeSetWorkflowAttributesSuccess(output),
  shapeFault: shapeSetWorkflowAttributesFault,
};
