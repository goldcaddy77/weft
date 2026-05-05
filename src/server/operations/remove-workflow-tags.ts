import { z } from 'zod';

import type { Engine } from '../../core/engine.ts';
import {
  coerceStartWorkflowTags,
  StartWorkflowValidationError,
} from '../../core/start-workflow-validation.ts';
import { FAULT_CODE_TO_HTTP_STATUS, type OperationFault } from '../operation-fault.ts';
import { defineOperation } from '../operation-registry.ts';
import type { UnknownRestBinding } from '../rest-bindings.ts';

const removeWorkflowTagsInput = z.object({
  workflowId: z.string().min(1),
  tags: z.unknown().optional(),
});
const removeWorkflowTagsOutput = z.object({
  ok: z.literal(true),
});

export type RemoveWorkflowTagsInput = z.infer<typeof removeWorkflowTagsInput>;
export type RemoveWorkflowTagsOutput = z.infer<typeof removeWorkflowTagsOutput>;

export const removeWorkflowTagsOperation = defineOperation<
  RemoveWorkflowTagsInput,
  RemoveWorkflowTagsOutput
>({
  name: 'weft.workflows.tags.remove',
  mcpExposable: false,
  summary: 'Remove workflow tags',
  tags: ['Tags'],
  inputSchema: removeWorkflowTagsInput,
  outputSchema: removeWorkflowTagsOutput as z.ZodType<RemoveWorkflowTagsOutput>,
  access: { kind: 'public' },
  producibleFaults: ['Unprocessable', 'NotFound'],
  transports: { http: true, jsonRpcHttp: true, jsonRpcWebSocket: true, jsonRpcStdio: true },
  unknownKeyPolicy: { http: 'strip', jsonRpc: 'reject' },
  invoke: async ({ input, engine }): Promise<RemoveWorkflowTagsOutput> => {
    const e = engine as Engine;

    let tags: string[];
    try {
      tags = coerceStartWorkflowTags(input.tags, 'Field "tags"');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const fault: OperationFault = {
        code: 'Unprocessable',
        message,
        data: { reason: message },
      };
      throw fault;
    }

    try {
      await e.removeTags(input.workflowId, ...tags);
      return { ok: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('not found')) {
        const fault: OperationFault = {
          code: 'NotFound',
          message,
          data: { resource: 'workflow', identifier: input.workflowId },
        };
        throw fault;
      }
      if (error instanceof StartWorkflowValidationError) {
        const fault: OperationFault = {
          code: 'Unprocessable',
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

function shapeRemoveWorkflowTagsSuccess(output: RemoveWorkflowTagsOutput): Response {
  return new Response(JSON.stringify(output), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function shapeRemoveWorkflowTagsFault(fault: OperationFault): Response {
  if (fault.code === 'Unprocessable') {
    return new Response(JSON.stringify({ error: fault.message }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  return new Response(JSON.stringify({ error: fault.message }), {
    status: FAULT_CODE_TO_HTTP_STATUS[fault.code],
    headers: { 'Content-Type': 'application/json' },
  });
}

export const removeWorkflowTagsRestBinding: UnknownRestBinding = {
  method: 'DELETE',
  path: '/v1/workflows/:id/tags',
  pathParamNames: ['id'],
  operationName: 'weft.workflows.tags.remove',
  inputSources: {
    workflowId: { kind: 'path', pathParam: 'id' },
    tags: { kind: 'body-field', bodyField: 'tags' },
  },
  extractInput: async (request, pathParams) => {
    const body = await request.json().catch(() => {
      throw new Error('Invalid JSON body');
    });

    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      throw new Error('Invalid JSON body');
    }

    return {
      workflowId: pathParams['id'] ?? '',
      tags: body['tags'],
    };
  },
  success: { kind: 'json', status: 200 },
  shapeSuccess: (output: RemoveWorkflowTagsOutput) => shapeRemoveWorkflowTagsSuccess(output),
  shapeFault: shapeRemoveWorkflowTagsFault,
};
