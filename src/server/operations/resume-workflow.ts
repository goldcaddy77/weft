import { z } from 'zod';

import type { Engine } from '../../core/engine.ts';
import type { OperationFault } from '../operation-fault.ts';
import { defineOperation } from '../operation-registry.ts';
import type { UnknownRestBinding } from '../rest-bindings.ts';
import { shapeRestFault } from './operation-helpers.ts';

const resumeWorkflowInput = z.object({
  workflowId: z.string().min(1),
});

const resumeWorkflowOutput = z.object({
  id: z.string(),
});

export type ResumeWorkflowInput = z.infer<typeof resumeWorkflowInput>;
export type ResumeWorkflowOutput = z.infer<typeof resumeWorkflowOutput>;

export const resumeWorkflowOperation = defineOperation<ResumeWorkflowInput, ResumeWorkflowOutput>({
  name: 'weft.workflows.resume',
  summary: 'Resume a suspended workflow',
  tags: ['Workflows'],
  inputSchema: resumeWorkflowInput,
  outputSchema: resumeWorkflowOutput,
  access: { kind: 'public' },
  producibleFaults: ['NotFound', 'Conflict'],
  transports: { http: true, jsonRpcHttp: true, jsonRpcWebSocket: true, jsonRpcStdio: true },
  unknownKeyPolicy: { http: 'strip', jsonRpc: 'reject' },
  invoke: async ({ input, engine }): Promise<ResumeWorkflowOutput> => {
    const typedEngine = engine as Engine;

    try {
      const handle = await typedEngine.resume(input.workflowId);
      return { id: handle.id };
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
      if (message.includes('Cannot resume')) {
        const fault: OperationFault = {
          code: 'Conflict',
          message,
          data: { reason: message },
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

export const resumeWorkflowRestBinding: UnknownRestBinding = {
  method: 'POST',
  path: '/v1/workflows/:id/resume',
  pathParamNames: ['id'],
  operationName: 'weft.workflows.resume',
  inputSources: {
    workflowId: { kind: 'path', pathParam: 'id' },
  },
  extractInput: async (_request, pathParams) => ({ workflowId: pathParams['id'] ?? '' }),
  success: { kind: 'json', status: 200 },
  shapeFault: shapeRestFault,
};
