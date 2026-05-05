import { z } from 'zod';

import type { Engine } from '../../core/engine.ts';
import { FAULT_CODE_TO_HTTP_STATUS, type OperationFault } from '../operation-fault.ts';
import { defineOperation } from '../operation-registry.ts';
import type { UnknownRestBinding } from '../rest-bindings.ts';

const signalWorkflowInput = z.object({
  workflowId: z.string().min(1),
  signalName: z.string().min(1),
  payload: z.unknown().optional(),
});
const signalWorkflowOutput = z.object({
  ok: z.literal(true),
});

export type SignalWorkflowInput = z.infer<typeof signalWorkflowInput>;
export type SignalWorkflowOutput = z.infer<typeof signalWorkflowOutput>;

export const signalWorkflowOperation = defineOperation<SignalWorkflowInput, SignalWorkflowOutput>({
  name: 'weft.workflows.signal',
  mcpExposable: false,
  summary: 'Send a signal to a workflow',
  tags: ['Signals'],
  inputSchema: signalWorkflowInput,
  outputSchema: signalWorkflowOutput as z.ZodType<SignalWorkflowOutput>,
  access: { kind: 'public' },
  producibleFaults: ['NotFound'],
  transports: { http: true, jsonRpcHttp: true, jsonRpcWebSocket: true, jsonRpcStdio: true },
  unknownKeyPolicy: { http: 'strip', jsonRpc: 'reject' },
  invoke: async ({ input, engine }): Promise<SignalWorkflowOutput> => {
    const e = engine as Engine;

    try {
      await e.signal(input.workflowId, input.signalName, input.payload);
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

      const fault: OperationFault = {
        code: 'EngineFailure',
        message,
        data: {},
      };
      throw fault;
    }
  },
});

function shapeSignalWorkflowSuccess(output: SignalWorkflowOutput): Response {
  return new Response(JSON.stringify(output), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function shapeSignalWorkflowFault(fault: OperationFault): Response {
  return new Response(JSON.stringify({ error: fault.message }), {
    status: FAULT_CODE_TO_HTTP_STATUS[fault.code],
    headers: { 'Content-Type': 'application/json' },
  });
}

export const signalWorkflowRestBinding: UnknownRestBinding = {
  method: 'POST',
  path: '/v1/workflows/:id/signal/:name',
  pathParamNames: ['id', 'name'],
  operationName: 'weft.workflows.signal',
  inputSources: {
    workflowId: { kind: 'path', pathParam: 'id' },
    signalName: { kind: 'path', pathParam: 'name' },
    payload: { kind: 'body-field', bodyField: 'payload' },
  },
  extractInput: async (request, pathParams) => {
    const body = await request.json().catch(() => null);
    const payload =
      typeof body === 'object' && body !== null
        ? (body as Record<string, unknown>)['payload']
        : undefined;

    return {
      workflowId: pathParams['id'] ?? '',
      signalName: pathParams['name'] ?? '',
      payload,
    };
  },
  success: { kind: 'json', status: 200 },
  shapeSuccess: (output: SignalWorkflowOutput) => shapeSignalWorkflowSuccess(output),
  shapeFault: shapeSignalWorkflowFault,
};
