import { z } from 'zod';

import type { Engine } from '../../core/engine.ts';
import { FAULT_CODE_TO_HTTP_STATUS, type OperationFault } from '../operation-fault.ts';
import { defineOperation } from '../operation-registry.ts';
import type { UnknownRestBinding } from '../rest-bindings.ts';

const getUpdateResultInput = z.object({
  updateId: z.string().min(1),
});
const getUpdateResultOutput = z.unknown();

export type GetUpdateResultInput = z.infer<typeof getUpdateResultInput>;
export type GetUpdateResultOutput =
  | { status: 'pending' }
  | { status: 'completed'; result: unknown; error?: string };

export const getUpdateResultOperation = defineOperation<
  GetUpdateResultInput,
  GetUpdateResultOutput
>({
  name: 'weft.updates.result.get',
  summary: 'Get the result of an update request',
  tags: ['Updates'],
  inputSchema: getUpdateResultInput,
  outputSchema: getUpdateResultOutput as z.ZodType<GetUpdateResultOutput>,
  access: { kind: 'public' },
  transports: { http: true, jsonRpcHttp: true, jsonRpcWebSocket: true, jsonRpcStdio: true },
  unknownKeyPolicy: { http: 'strip', jsonRpc: 'reject' },
  invoke: async ({ input, engine }): Promise<GetUpdateResultOutput> => {
    const e = engine as Engine;
    const response = await e.getUpdateResult(input.updateId);

    if (response === null) {
      return { status: 'pending' };
    }

    return {
      status: 'completed',
      result: response.result,
      ...(response.error !== undefined ? { error: response.error } : {}),
    };
  },
});

function shapeGetUpdateResultSuccess(result: GetUpdateResultOutput): Response {
  if (result.status === 'pending') {
    return new Response(JSON.stringify(result), {
      status: 202,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  return new Response(JSON.stringify(result), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function shapeGetUpdateResultFault(fault: OperationFault): Response {
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

export const getUpdateResultRestBinding: UnknownRestBinding = {
  method: 'GET',
  path: '/v1/updates/:updateId',
  pathParamNames: ['updateId'],
  operationName: 'weft.updates.result.get',
  inputSources: {
    updateId: { kind: 'path', pathParam: 'updateId' },
  },
  extractInput: async (_request, pathParams) => ({ updateId: pathParams['updateId'] ?? '' }),
  success: { kind: 'json', status: 200 },
  shapeSuccess: (output: GetUpdateResultOutput) => shapeGetUpdateResultSuccess(output),
  shapeFault: shapeGetUpdateResultFault,
};
