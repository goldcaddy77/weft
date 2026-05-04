import { z } from 'zod';

import type { Engine } from '../../core/engine.ts';
import type { OperationFault } from '../operation-fault.ts';
import { defineOperation } from '../operation-registry.ts';
import type { UnknownRestBinding } from '../rest-bindings.ts';
import { shapeRestFault } from './operation-helpers.ts';

const timeoutWorkflowInput = z.object({
  workflowId: z.string().min(1),
});

export type TimeoutWorkflowInput = z.infer<typeof timeoutWorkflowInput>;

export const timeoutWorkflowOperation = defineOperation<TimeoutWorkflowInput, null>({
  name: 'weft.workflows.timeout',
  summary: 'Force-timeout a workflow',
  tags: ['Workflows'],
  inputSchema: timeoutWorkflowInput,
  outputSchema: z.null(),
  access: { kind: 'public' },
  producibleFaults: ['NotFound'],
  transports: { http: true, jsonRpcHttp: true, jsonRpcWebSocket: true, jsonRpcStdio: true },
  unknownKeyPolicy: { http: 'strip', jsonRpc: 'reject' },
  invoke: async ({ input, engine }): Promise<null> => {
    const typedEngine = engine as Engine;

    try {
      await typedEngine.timeout(input.workflowId);
      return null;
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

export const timeoutWorkflowRestBinding: UnknownRestBinding = {
  method: 'POST',
  path: '/v1/workflows/:id/timeout',
  pathParamNames: ['id'],
  operationName: 'weft.workflows.timeout',
  inputSources: {
    workflowId: { kind: 'path', pathParam: 'id' },
  },
  extractInput: async (_request, pathParams) => ({ workflowId: pathParams['id'] ?? '' }),
  success: { kind: 'empty', status: 204 },
  shapeFault: shapeRestFault,
};
