import { z } from 'zod';

import { encode } from '../../core/codec.ts';
import type { Engine } from '../../core/engine.ts';
import type { WorkflowTimelineEntry } from '../../core/types.ts';
import { FAULT_CODE_TO_HTTP_STATUS, type OperationFault } from '../operation-fault.ts';
import { defineOperation } from '../operation-registry.ts';
import type { UnknownRestBinding } from '../rest-bindings.ts';

const getWorkflowTimelineInput = z.object({
  workflowId: z.string().min(1),
});
const getWorkflowTimelineOutput = z.unknown();

export type GetWorkflowTimelineInput = z.infer<typeof getWorkflowTimelineInput>;
export type GetWorkflowTimelineOutput = WorkflowTimelineEntry[];

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
  producibleFaults: ['NotFound'],
  transports: { http: true, jsonRpcHttp: true, jsonRpcWebSocket: true, jsonRpcStdio: true },
  unknownKeyPolicy: { http: 'strip', jsonRpc: 'reject' },
  // Operation contract is transport-neutral: returns the array of
  // timeline entries directly. Accept-header negotiation between
  // json and msgpack is REST-specific and lives in the binding's
  // `shapeSuccess`, not on the operation output type.
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
    return e.getTimeline(input.workflowId);
  },
});

function shapeGetWorkflowTimelineSuccess(
  result: GetWorkflowTimelineOutput,
  request: Request,
): Response {
  // Match legacy `negotiatedResponse` behavior verbatim: substring
  // match on `Accept`, no q-value parsing. RFC-7231 negotiation is
  // a deliberate behavior change for a follow-up PR.
  const accept = request.headers.get('Accept') ?? '';
  if (accept.includes('application/msgpack')) {
    return new Response(encode(result), {
      status: 200,
      headers: { 'Content-Type': 'application/msgpack' },
    });
  }

  return new Response(JSON.stringify(result), {
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
  extractInput: async (_request, pathParams) => ({
    workflowId: pathParams['id'] ?? '',
  }),
  success: { kind: 'json', status: 200 },
  shapeSuccess: (output: GetWorkflowTimelineOutput, request: Request) =>
    shapeGetWorkflowTimelineSuccess(output, request),
  shapeFault: shapeGetWorkflowTimelineFault,
};
