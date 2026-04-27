import { z } from 'zod';

import { encode } from '../../core/codec.ts';
import type { Engine } from '../../core/engine.ts';
import type { CheckpointState } from '../../core/types.ts';
import { FAULT_CODE_TO_HTTP_STATUS, type OperationFault } from '../operation-fault.ts';
import { defineOperation } from '../operation-registry.ts';
import type { UnknownRestBinding } from '../rest-bindings.ts';

const getCheckpointAtInput = z.object({
  workflowId: z.string().min(1),
  step: z.number().int().nonnegative(),
  acceptMsgpack: z.boolean().optional(),
});
const getCheckpointAtOutput = z.unknown();

export type GetCheckpointAtInput = z.infer<typeof getCheckpointAtInput>;
export type GetCheckpointAtOutput = {
  state: CheckpointState;
  acceptMsgpack: boolean;
};

export const getCheckpointAtOperation = defineOperation<
  GetCheckpointAtInput,
  GetCheckpointAtOutput
>({
  name: 'weft.workflows.checkpoints.get',
  summary: 'Get a specific checkpoint by step number',
  tags: ['Checkpoints'],
  inputSchema: getCheckpointAtInput,
  outputSchema: getCheckpointAtOutput as z.ZodType<GetCheckpointAtOutput>,
  access: { kind: 'public' },
  transports: { http: true, jsonRpcHttp: true, jsonRpcWebSocket: true, jsonRpcStdio: true },
  unknownKeyPolicy: { http: 'strip', jsonRpc: 'reject' },
  invoke: async ({ input, engine }): Promise<GetCheckpointAtOutput> => {
    const e = engine as Engine;
    const state = await e.getCheckpointAt(input.workflowId, input.step);
    if (state === null) {
      const fault: OperationFault = {
        code: 'NotFound',
        message: `Checkpoint not found at step ${input.step} for workflow ${input.workflowId}`,
        data: { resource: 'checkpoint', identifier: `${input.workflowId}:${input.step}` },
      };
      throw fault;
    }

    return {
      state,
      acceptMsgpack: input.acceptMsgpack ?? false,
    };
  },
});

function shapeGetCheckpointAtSuccess(result: GetCheckpointAtOutput): Response {
  if (result.acceptMsgpack) {
    return new Response(encode(result.state), {
      status: 200,
      headers: { 'Content-Type': 'application/msgpack' },
    });
  }

  return new Response(JSON.stringify(result.state), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function shapeGetCheckpointAtFault(fault: OperationFault): Response {
  if (fault.code === 'EngineFailure') {
    return new Response(JSON.stringify({ error: 'Internal server error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  if (fault.code === 'InvalidParams') {
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

export const getCheckpointAtRestBinding: UnknownRestBinding = {
  method: 'GET',
  path: '/v1/workflows/:id/checkpoints/:step',
  pathParamNames: ['id', 'step'],
  operationName: 'weft.workflows.checkpoints.get',
  inputSources: {
    workflowId: { kind: 'path', pathParam: 'id' },
    step: { kind: 'path', pathParam: 'step' },
  },
  extractInput: async (request, pathParams) => {
    const stepParam = pathParams['step'] ?? '';
    const step = Number(stepParam);

    if (!Number.isSafeInteger(step) || step < 0) {
      const fault: OperationFault = {
        code: 'InvalidParams',
        message: `Invalid step: ${stepParam}`,
        data: {
          issues: [{ path: ['step'], message: `Invalid step: ${stepParam}`, code: 'custom' }],
        },
      };
      throw fault;
    }

    return {
      workflowId: pathParams['id'] ?? '',
      step,
      acceptMsgpack: request.headers.get('Accept')?.includes('application/msgpack') ?? false,
    };
  },
  success: { kind: 'json', status: 200 },
  shapeSuccess: (output: GetCheckpointAtOutput) => shapeGetCheckpointAtSuccess(output),
  shapeFault: shapeGetCheckpointAtFault,
};
