import { z } from 'zod';

import type { Engine } from '../../core/engine.ts';
import { FAULT_CODE_TO_HTTP_STATUS, type OperationFault } from '../operation-fault.ts';
import { defineOperation } from '../operation-registry.ts';
import type { UnknownRestBinding } from '../rest-bindings.ts';

const recoverAllInput = z.object({});

const recoverAllOutput = z.object({
  recovered: z.array(z.string()),
});

export type RecoverAllInput = z.infer<typeof recoverAllInput>;
export type RecoverAllOutput = z.infer<typeof recoverAllOutput>;

export const recoverAllOperation = defineOperation<RecoverAllInput, RecoverAllOutput>({
  name: 'weft.recover.all',
  summary: 'Recover all interrupted workflows',
  tags: ['System'],
  inputSchema: recoverAllInput,
  outputSchema: recoverAllOutput,
  access: { kind: 'public' },
  transports: { http: true, jsonRpcHttp: true, jsonRpcWebSocket: true, jsonRpcStdio: true },
  unknownKeyPolicy: { http: 'strip', jsonRpc: 'reject' },
  invoke: async ({ engine }): Promise<RecoverAllOutput> => {
    const typedEngine = engine as Engine;

    try {
      const handles = await typedEngine.recoverAll();
      return { recovered: handles.map((handle) => handle.id) };
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

function shapeRecoverAllFault(fault: OperationFault): Response {
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

export const recoverAllRestBinding: UnknownRestBinding = {
  method: 'POST',
  path: '/v1/recover',
  pathParamNames: [],
  operationName: 'weft.recover.all',
  inputSources: {},
  extractInput: async () => ({}),
  success: { kind: 'json', status: 200 },
  shapeFault: shapeRecoverAllFault,
};
