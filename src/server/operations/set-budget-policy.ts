import { z } from 'zod';

import type { BudgetPolicyOptions } from '../../ai/budget-policy.ts';
import type { Engine } from '../../core/engine.ts';
import { FAULT_CODE_TO_HTTP_STATUS, type OperationFault } from '../operation-fault.ts';
import { defineOperation } from '../operation-registry.ts';
import type { UnknownRestBinding } from '../rest-bindings.ts';

const setBudgetPolicyInput = z.object({
  namespace: z.unknown().optional(),
  daily: z.unknown().optional(),
  monthly: z.unknown().optional(),
});
const setBudgetPolicyOutput = z.object({
  ok: z.literal(true),
});

export type SetBudgetPolicyInput = z.infer<typeof setBudgetPolicyInput>;
export type SetBudgetPolicyOutput = z.infer<typeof setBudgetPolicyOutput>;

export const setBudgetPolicyOperation = defineOperation<
  SetBudgetPolicyInput,
  SetBudgetPolicyOutput
>({
  name: 'weft.budget.set',
  summary: 'Set organization-level budget policy',
  tags: ['Budget'],
  inputSchema: setBudgetPolicyInput,
  outputSchema: setBudgetPolicyOutput as z.ZodType<SetBudgetPolicyOutput>,
  access: { kind: 'public' },
  transports: { http: true, jsonRpcHttp: true, jsonRpcWebSocket: true, jsonRpcStdio: true },
  unknownKeyPolicy: { http: 'strip', jsonRpc: 'reject' },
  invoke: async ({ input, engine }): Promise<SetBudgetPolicyOutput> => {
    const e = engine as Engine;

    if (typeof input.namespace !== 'string' || input.namespace.length === 0) {
      const fault: OperationFault = {
        code: 'InvalidParams',
        message: 'Missing required field: namespace',
        data: { issues: [] },
      };
      throw fault;
    }

    const options: BudgetPolicyOptions = { namespace: input.namespace };
    if (typeof input.daily === 'object' && input.daily !== null) {
      options.daily = input.daily as { maxCost: number };
    }
    if (typeof input.monthly === 'object' && input.monthly !== null) {
      options.monthly = input.monthly as { maxCost: number };
    }

    try {
      await e.setBudgetPolicy(options);
      return { ok: true };
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

function shapeSetBudgetPolicySuccess(output: SetBudgetPolicyOutput): Response {
  return new Response(JSON.stringify(output), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function shapeSetBudgetPolicyFault(fault: OperationFault): Response {
  return new Response(JSON.stringify({ error: fault.message }), {
    status: FAULT_CODE_TO_HTTP_STATUS[fault.code],
    headers: { 'Content-Type': 'application/json' },
  });
}

export const setBudgetPolicyRestBinding: UnknownRestBinding = {
  method: 'PUT',
  path: '/v1/budget-policy',
  pathParamNames: [],
  operationName: 'weft.budget.set',
  inputSources: {
    namespace: { kind: 'body-field', bodyField: 'namespace' },
    daily: { kind: 'body-field', bodyField: 'daily' },
    monthly: { kind: 'body-field', bodyField: 'monthly' },
  },
  extractInput: async (request) => {
    const body = await request.json().catch(() => {
      throw new Error('Invalid JSON body');
    });

    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      throw new Error('Request body must be a JSON object');
    }

    return {
      namespace: body['namespace'],
      daily: body['daily'],
      monthly: body['monthly'],
    };
  },
  success: { kind: 'json', status: 200 },
  shapeSuccess: (output: SetBudgetPolicyOutput) => shapeSetBudgetPolicySuccess(output),
  shapeFault: shapeSetBudgetPolicyFault,
};
