import { z } from 'zod';

import type { BudgetPolicyOptions } from '../../ai/budget-policy.ts';
import type { Engine } from '../../core/engine.ts';
import { FAULT_CODE_TO_HTTP_STATUS, type OperationFault } from '../operation-fault.ts';
import { defineOperation } from '../operation-registry.ts';
import type { UnknownRestBinding } from '../rest-bindings.ts';

const getBudgetPolicyInput = z.object({
  namespace: z.string().min(1),
});
const getBudgetPolicyOutput = z.unknown();

export type GetBudgetPolicyInput = z.infer<typeof getBudgetPolicyInput>;
export type GetBudgetPolicyOutput = BudgetPolicyOptions;

export const getBudgetPolicyOperation = defineOperation<
  GetBudgetPolicyInput,
  GetBudgetPolicyOutput
>({
  name: 'weft.budget.get',
  summary: 'Get budget policy for a namespace',
  tags: ['Budget'],
  inputSchema: getBudgetPolicyInput,
  outputSchema: getBudgetPolicyOutput as z.ZodType<GetBudgetPolicyOutput>,
  access: { kind: 'public' },
  transports: { http: true, jsonRpcHttp: true, jsonRpcWebSocket: true, jsonRpcStdio: true },
  unknownKeyPolicy: { http: 'strip', jsonRpc: 'reject' },
  invoke: async ({ input, engine }): Promise<GetBudgetPolicyOutput> => {
    const e = engine as Engine;
    const policy = await e.getBudgetPolicy(input.namespace);
    if (policy === null) {
      const fault: OperationFault = {
        code: 'NotFound',
        message: `Budget policy for namespace "${input.namespace}" not found`,
        data: { resource: 'budget-policy', identifier: input.namespace },
      };
      throw fault;
    }

    return policy;
  },
});

function shapeGetBudgetPolicySuccess(result: GetBudgetPolicyOutput): Response {
  return new Response(JSON.stringify(result), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function shapeGetBudgetPolicyFault(fault: OperationFault): Response {
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

export const getBudgetPolicyRestBinding: UnknownRestBinding = {
  method: 'GET',
  path: '/v1/budget-policy/:namespace',
  pathParamNames: ['namespace'],
  operationName: 'weft.budget.get',
  inputSources: {
    namespace: { kind: 'path', pathParam: 'namespace' },
  },
  extractInput: async (_request, pathParams) => ({ namespace: pathParams['namespace'] ?? '' }),
  success: { kind: 'json', status: 200 },
  shapeSuccess: (output: GetBudgetPolicyOutput) => shapeGetBudgetPolicySuccess(output),
  shapeFault: shapeGetBudgetPolicyFault,
};
