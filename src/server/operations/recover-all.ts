import { z } from 'zod';

import type { Engine } from '../../core/engine.ts';
import { WorkflowTypeNotRegisteredForRecoveryError } from '../../core/engine.ts';
import type { OperationFault } from '../operation-fault.ts';
import { defineOperation } from '../operation-registry.ts';
import type { UnknownRestBinding } from '../rest-bindings.ts';
import { shapeRestFault } from './operation-helpers.ts';

const recoverAllInput = z.object({
  acknowledgeUnknownWorkflowTypes: z.boolean().optional(),
});

const recoverAllOutput = z.object({
  recovered: z.array(z.string()),
});

export type RecoverAllInput = z.infer<typeof recoverAllInput>;
export type RecoverAllOutput = z.infer<typeof recoverAllOutput>;

export const recoverAllOperation = defineOperation<RecoverAllInput, RecoverAllOutput>({
  name: 'weft.recover.all',
  mcpExposable: false,
  summary: 'Recover all interrupted workflows',
  tags: ['System'],
  inputSchema: recoverAllInput,
  outputSchema: recoverAllOutput,
  access: { kind: 'public' },
  producibleFaults: ['Conflict'],
  transports: { http: true, jsonRpcHttp: true, jsonRpcWebSocket: true, jsonRpcStdio: true },
  unknownKeyPolicy: { http: 'strip', jsonRpc: 'reject' },
  invoke: async ({ engine, input }): Promise<RecoverAllOutput> => {
    const typedEngine = engine as Engine;

    try {
      const handles = await typedEngine.recoverAll(
        input.acknowledgeUnknownWorkflowTypes === undefined
          ? undefined
          : { acknowledgeUnknownWorkflowTypes: input.acknowledgeUnknownWorkflowTypes },
      );
      return { recovered: handles.map((handle) => handle.id) };
    } catch (error) {
      if (error instanceof WorkflowTypeNotRegisteredForRecoveryError) {
        const fault: OperationFault = {
          code: 'Conflict',
          message: error.message,
          data: {
            reason: error.message,
            missingTypes: error.missingTypes,
            missingWorkflowCount: error.missingWorkflowCount,
            samplesTruncated: error.samplesTruncated,
          },
        };
        throw fault;
      }
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

export const recoverAllRestBinding: UnknownRestBinding = {
  method: 'POST',
  path: '/v1/recover',
  pathParamNames: [],
  operationName: 'weft.recover.all',
  inputSources: {
    acknowledgeUnknownWorkflowTypes: {
      kind: 'body-field',
      bodyField: 'acknowledgeUnknownWorkflowTypes',
    },
  },
  extractInput: async (request) => {
    const rawBody = await request.text();
    if (rawBody.trim().length === 0) {
      return {};
    }

    let body: unknown;
    try {
      body = JSON.parse(rawBody) as unknown;
    } catch {
      return {};
    }

    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      return {};
    }

    const record = body as Record<string, unknown>;
    return { acknowledgeUnknownWorkflowTypes: record['acknowledgeUnknownWorkflowTypes'] };
  },
  success: { kind: 'json', status: 200 },
  shapeFault: shapeRecoverAllFault,
};

function shapeRecoverAllFault(fault: OperationFault): Response {
  if (fault.code !== 'Conflict' || fault.data.missingTypes === undefined) {
    return shapeRestFault(fault);
  }

  return new Response(
    JSON.stringify({
      error: 'workflow_type_not_registered_for_recovery',
      missingTypes: fault.data.missingTypes,
      missingWorkflowCount: fault.data.missingWorkflowCount,
      samplesTruncated: fault.data.samplesTruncated,
    }),
    {
      status: 409,
      headers: { 'Content-Type': 'application/json' },
    },
  );
}
