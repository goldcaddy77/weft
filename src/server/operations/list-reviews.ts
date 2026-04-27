import { z } from 'zod';

import type { Engine } from '../../core/engine.ts';
import { FAULT_CODE_TO_HTTP_STATUS, type OperationFault } from '../operation-fault.ts';
import { defineOperation } from '../operation-registry.ts';
import type { UnknownRestBinding } from '../rest-bindings.ts';

const listReviewsInput = z.object({});
const listReviewsOutput = z.unknown();

export type ListReviewsInput = z.infer<typeof listReviewsInput>;
export type ListReviewsOutput = { items: Array<Record<string, unknown>> };

export const listReviewsOperation = defineOperation<ListReviewsInput, ListReviewsOutput>({
  name: 'weft.reviews.list',
  summary: 'List pending human review requests',
  tags: ['Reviews'],
  inputSchema: listReviewsInput,
  outputSchema: listReviewsOutput as z.ZodType<ListReviewsOutput>,
  access: { kind: 'public' },
  transports: { http: true, jsonRpcHttp: true, jsonRpcWebSocket: true, jsonRpcStdio: true },
  unknownKeyPolicy: { http: 'strip', jsonRpc: 'reject' },
  invoke: async ({ engine }): Promise<ListReviewsOutput> => {
    const e = engine as Engine;
    return { items: await e.listReviews() };
  },
});

function shapeListReviewsSuccess(result: ListReviewsOutput): Response {
  return new Response(JSON.stringify(result), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function shapeListReviewsFault(fault: OperationFault): Response {
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

export const listReviewsRestBinding: UnknownRestBinding = {
  method: 'GET',
  path: '/v1/reviews',
  pathParamNames: [],
  operationName: 'weft.reviews.list',
  inputSources: {},
  extractInput: async () => ({}),
  success: { kind: 'json', status: 200 },
  shapeSuccess: (output: ListReviewsOutput) => shapeListReviewsSuccess(output),
  shapeFault: shapeListReviewsFault,
};
