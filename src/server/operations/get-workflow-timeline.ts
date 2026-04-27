import { z } from 'zod';

import { encode } from '../../core/codec.ts';
import type { Engine } from '../../core/engine.ts';
import type { WorkflowTimelineEntry } from '../../core/types.ts';
import { FAULT_CODE_TO_HTTP_STATUS, type OperationFault } from '../operation-fault.ts';
import { defineOperation } from '../operation-registry.ts';
import type { UnknownRestBinding } from '../rest-bindings.ts';

const getWorkflowTimelineInput = z.object({
  workflowId: z.string().min(1),
  acceptMsgpack: z.boolean().optional(),
});
const getWorkflowTimelineOutput = z.unknown();

export type GetWorkflowTimelineInput = z.infer<typeof getWorkflowTimelineInput>;
export type GetWorkflowTimelineOutput = {
  timeline: WorkflowTimelineEntry[];
  acceptMsgpack: boolean;
};

export const getWorkflowTimelineOperation = defineOperation<
  GetWorkflowTimelineInput,
  GetWorkflowTimelineOutput
>({
  name: 'weft.workflows.timeline.get',
  summary: 'Get the structured execution timeline for a workflow',
  tags: ['Checkpoints'],
  inputSchema: getWorkflowTimelineInput,
  outputSchema: getWorkflowTimelineOutput as z.ZodType<GetWorkflowTimelineOutput>,
  access: { kind: 'public' },
  transports: { http: true, jsonRpcHttp: true, jsonRpcWebSocket: true, jsonRpcStdio: true },
  unknownKeyPolicy: { http: 'strip', jsonRpc: 'reject' },
  invoke: async ({ input, engine }): Promise<GetWorkflowTimelineOutput> => {
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

    return {
      timeline: await e.getTimeline(input.workflowId),
      acceptMsgpack: input.acceptMsgpack ?? false,
    };
  },
});

function shapeGetWorkflowTimelineSuccess(result: GetWorkflowTimelineOutput): Response {
  if (result.acceptMsgpack) {
    return new Response(encode(result.timeline), {
      status: 200,
      headers: { 'Content-Type': 'application/msgpack' },
    });
  }

  return new Response(JSON.stringify(result.timeline), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function shapeGetWorkflowTimelineFault(fault: OperationFault): Response {
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

export const getWorkflowTimelineRestBinding: UnknownRestBinding = {
  method: 'GET',
  path: '/v1/workflows/:id/timeline',
  pathParamNames: ['id'],
  operationName: 'weft.workflows.timeline.get',
  inputSources: {
    workflowId: { kind: 'path', pathParam: 'id' },
  },
  extractInput: async (request, pathParams) => ({
    workflowId: pathParams['id'] ?? '',
    acceptMsgpack: request.headers.get('Accept')?.includes('application/msgpack') ?? false,
  }),
  success: { kind: 'json', status: 200 },
  shapeSuccess: (output: GetWorkflowTimelineOutput) => shapeGetWorkflowTimelineSuccess(output),
  shapeFault: shapeGetWorkflowTimelineFault,
};
