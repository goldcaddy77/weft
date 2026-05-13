import { z } from 'zod';

import type { Engine } from '../../core/engine.ts';
import type { OperationFault } from '../operation-fault.ts';
import { defineOperation } from '../operation-registry.ts';
import type { UnknownRestBinding } from '../rest-bindings.ts';
import { shapeLegacyRestFaultWithRawEngineFailureMessage } from './operation-helpers.ts';

const cancelWorkflowInput = z.object({
  workflowId: z.string().min(1),
});
const cancelWorkflowOutput = z.undefined();

export type CancelWorkflowInput = z.infer<typeof cancelWorkflowInput>;
export type CancelWorkflowOutput = z.infer<typeof cancelWorkflowOutput>;

export const cancelWorkflowOperation = defineOperation<CancelWorkflowInput, CancelWorkflowOutput>({
  name: 'weft.workflows.cancel',
  mcpExposable: false,
  summary: 'Cancel a running workflow',
  tags: ['Workflows'],
  inputSchema: cancelWorkflowInput,
  outputSchema: cancelWorkflowOutput as z.ZodType<CancelWorkflowOutput>,
  access: { kind: 'public' },
  producibleFaults: ['NotFound'],
  transports: { http: true, jsonRpcHttp: true, jsonRpcWebSocket: true, jsonRpcStdio: true },
  unknownKeyPolicy: { http: 'strip', jsonRpc: 'reject' },
  invoke: async ({ input, engine }): Promise<CancelWorkflowOutput> => {
    const e = engine as Engine;

    try {
      await e.cancel(input.workflowId);
      return undefined;
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

function shapeCancelWorkflowFault(fault: OperationFault): Response {
  // Legacy cancel responses expose raw engine failure messages.
  return shapeLegacyRestFaultWithRawEngineFailureMessage(fault);
}

export const cancelWorkflowRestBinding: UnknownRestBinding = {
  method: 'DELETE',
  path: '/v1/workflows/:id',
  pathParamNames: ['id'],
  operationName: 'weft.workflows.cancel',
  inputSources: {
    workflowId: { kind: 'path', pathParam: 'id' },
  },
  extractInput: async (_request, pathParams) => ({
    workflowId: pathParams['id'] ?? '',
  }),
  success: { kind: 'empty', status: 204 },
  shapeFault: shapeCancelWorkflowFault,
};
