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
});
const getCheckpointAtOutput = z.unknown();

export type GetCheckpointAtInput = z.infer<typeof getCheckpointAtInput>;
export type GetCheckpointAtOutput = CheckpointState;

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
  producibleFaults: ['NotFound'],
  transports: { http: true, jsonRpcHttp: true, jsonRpcWebSocket: true, jsonRpcStdio: true },
  unknownKeyPolicy: { http: 'strip', jsonRpc: 'reject' },
  // Operation contract is transport-neutral: returns the
  // `CheckpointState` directly. Accept-header negotiation between
  // json and msgpack happens in the REST binding's `shapeSuccess`,
  // not in the operation output, so JSON-RPC clients receive a
  // clean canonical envelope.
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
    return state;
  },
});

function shapeGetCheckpointAtSuccess(result: GetCheckpointAtOutput, request: Request): Response {
  // Match legacy `negotiatedResponse` behavior verbatim: a substring
  // match on `Accept`, no q-value parsing. Real RFC-7231 negotiation
  // is a deliberate behavior change for a follow-up PR.
  const accept = request.headers.get('Accept') ?? '';
  if (accept.includes('application/msgpack')) {
    return new Response(encode(result), {
      status: 200,
      headers: { 'Content-Type': 'application/msgpack' },
    });
  }

  return new Response(JSON.stringify(result), {
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
  extractInput: async (_request, pathParams) => {
    const stepParam = pathParams['step'] ?? '';

    // Match the legacy route regex `(\d+)` exactly: only canonical
    // decimal digits, no leading sign, no scientific notation, no
    // hex prefix. `Number()` would happily coerce `1e2` to 100 and
    // `0x10` to 16, accepting URLs the legacy regex rejected — a
    // silent parity drift on top of the documented 404→400 shift.
    if (!/^\d+$/.test(stepParam)) {
      const fault: OperationFault = {
        code: 'InvalidParams',
        message: `Invalid step: ${stepParam}`,
        data: {
          issues: [{ path: ['step'], message: `Invalid step: ${stepParam}`, code: 'custom' }],
        },
      };
      throw fault;
    }

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
    };
  },
  success: { kind: 'json', status: 200 },
  shapeSuccess: (output: GetCheckpointAtOutput, request: Request) =>
    shapeGetCheckpointAtSuccess(output, request),
  shapeFault: shapeGetCheckpointAtFault,
};
