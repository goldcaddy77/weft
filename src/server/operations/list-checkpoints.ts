import { z } from 'zod';

import { encode } from '../../core/codec.ts';
import type { Engine } from '../../core/engine.ts';
import type { CheckpointSummary } from '../../core/types.ts';
import { FAULT_CODE_TO_HTTP_STATUS, type OperationFault } from '../operation-fault.ts';
import { defineOperation } from '../operation-registry.ts';
import type { UnknownRestBinding } from '../rest-bindings.ts';

const listCheckpointsInput = z.object({
  workflowId: z.string().min(1),
  acceptMsgpack: z.boolean().optional(),
});
const listCheckpointsOutput = z.unknown();

export type ListCheckpointsInput = z.infer<typeof listCheckpointsInput>;
export type ListCheckpointsOutput = {
  summaries: CheckpointSummary[];
  acceptMsgpack: boolean;
};

export const listCheckpointsOperation = defineOperation<
  ListCheckpointsInput,
  ListCheckpointsOutput
>({
  name: 'weft.workflows.checkpoints.list',
  summary: 'List checkpoint history for a workflow',
  tags: ['Checkpoints'],
  inputSchema: listCheckpointsInput,
  outputSchema: listCheckpointsOutput as z.ZodType<ListCheckpointsOutput>,
  access: { kind: 'public' },
  transports: { http: true, jsonRpcHttp: true, jsonRpcWebSocket: true, jsonRpcStdio: true },
  unknownKeyPolicy: { http: 'strip', jsonRpc: 'reject' },
  invoke: async ({ input, engine }): Promise<ListCheckpointsOutput> => {
    const e = engine as Engine;
    return {
      summaries: await e.listCheckpoints(input.workflowId),
      acceptMsgpack: input.acceptMsgpack ?? false,
    };
  },
});

function shapeListCheckpointsSuccess(result: ListCheckpointsOutput): Response {
  if (result.acceptMsgpack) {
    return new Response(encode(result.summaries), {
      status: 200,
      headers: { 'Content-Type': 'application/msgpack' },
    });
  }

  return new Response(JSON.stringify(result.summaries), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function shapeListCheckpointsFault(fault: OperationFault): Response {
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

export const listCheckpointsRestBinding: UnknownRestBinding = {
  method: 'GET',
  path: '/v1/workflows/:id/checkpoints',
  pathParamNames: ['id'],
  operationName: 'weft.workflows.checkpoints.list',
  inputSources: {
    workflowId: { kind: 'path', pathParam: 'id' },
  },
  extractInput: async (request, pathParams) => ({
    workflowId: pathParams['id'] ?? '',
    acceptMsgpack: request.headers.get('Accept')?.includes('application/msgpack') ?? false,
  }),
  success: { kind: 'json', status: 200 },
  shapeSuccess: (output: ListCheckpointsOutput) => shapeListCheckpointsSuccess(output),
  shapeFault: shapeListCheckpointsFault,
};
