import { z } from 'zod';

import { encode } from '../../core/codec.ts';
import type { Engine } from '../../core/engine.ts';
import type { CheckpointSummary } from '../../core/types.ts';
import { FAULT_CODE_TO_HTTP_STATUS, type OperationFault } from '../operation-fault.ts';
import { defineOperation } from '../operation-registry.ts';
import type { UnknownRestBinding } from '../rest-bindings.ts';

const listCheckpointsInput = z.object({
  workflowId: z.string().min(1),
});
const listCheckpointsOutput = z.unknown();

export type ListCheckpointsInput = z.infer<typeof listCheckpointsInput>;
export type ListCheckpointsOutput = CheckpointSummary[];

export const listCheckpointsOperation = defineOperation<
  ListCheckpointsInput,
  ListCheckpointsOutput
>({
  name: 'weft.workflows.checkpoints.list',
  summary: 'List checkpoint history for a workflow',
  tags: ['Checkpoints'],
  inputSchema: listCheckpointsInput,
  outputSchema: listCheckpointsOutput as z.ZodType<ListCheckpointsOutput>,
  access: { kind: 'public' },
  transports: { http: true, jsonRpcHttp: true, jsonRpcWebSocket: true, jsonRpcStdio: true },
  unknownKeyPolicy: { http: 'strip', jsonRpc: 'reject' },
  // Operation contract is transport-neutral: it returns the array of
  // summaries directly. JSON-RPC HTTP/WS/stdio clients receive the
  // canonical envelope around this value. The REST binding's
  // `shapeSuccess` does `Accept` negotiation (json vs msgpack) on
  // top of it — that representation choice is HTTP-specific and
  // does not belong on the operation's `Output` type.
  invoke: async ({ input, engine }): Promise<ListCheckpointsOutput> => {
    const e = engine as Engine;
    return e.listCheckpoints(input.workflowId);
  },
});

function shapeListCheckpointsSuccess(result: ListCheckpointsOutput, request: Request): Response {
  // Match legacy `negotiatedResponse` behavior verbatim: a substring
  // match on `Accept`, no q-value parsing. Real RFC-7231 negotiation
  // is a deliberate behavior change for a follow-up PR; this PR
  // preserves byte-for-byte parity with the legacy handler.
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

function shapeListCheckpointsFault(fault: OperationFault): Response {
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

export const listCheckpointsRestBinding: UnknownRestBinding = {
  method: 'GET',
  path: '/v1/workflows/:id/checkpoints',
  pathParamNames: ['id'],
  operationName: 'weft.workflows.checkpoints.list',
  inputSources: {
    workflowId: { kind: 'path', pathParam: 'id' },
  },
  extractInput: async (_request, pathParams) => ({
    workflowId: pathParams['id'] ?? '',
  }),
  success: { kind: 'json', status: 200 },
  shapeSuccess: (output: ListCheckpointsOutput, request: Request) =>
    shapeListCheckpointsSuccess(output, request),
  shapeFault: shapeListCheckpointsFault,
};
