import { z } from 'zod';

import type { ReviewRequest } from '../../ai/human-review.ts';
import type { Engine } from '../../core/engine.ts';
import { FAULT_CODE_TO_HTTP_STATUS, type OperationFault } from '../operation-fault.ts';
import { defineOperation } from '../operation-registry.ts';
import type { UnknownRestBinding } from '../rest-bindings.ts';

const getReviewInput = z.object({
  workflowId: z.string().min(1),
  reviewId: z.string().min(1),
});
const getReviewOutput = z.unknown();

export type GetReviewInput = z.infer<typeof getReviewInput>;
export type GetReviewOutput = ReviewRequest;

export const getReviewOperation = defineOperation<GetReviewInput, GetReviewOutput>({
  name: 'weft.reviews.get',
  summary: 'Get a specific review for a workflow',
  tags: ['Reviews'],
  inputSchema: getReviewInput,
  outputSchema: getReviewOutput as z.ZodType<GetReviewOutput>,
  access: { kind: 'public' },
  transports: { http: true, jsonRpcHttp: true, jsonRpcWebSocket: true, jsonRpcStdio: true },
  unknownKeyPolicy: { http: 'strip', jsonRpc: 'reject' },
  invoke: async ({ input, engine }): Promise<GetReviewOutput> => {
    const e = engine as Engine;
    const review = await e.getReview(input.workflowId, input.reviewId);
    if (review === null) {
      const fault: OperationFault = {
        code: 'NotFound',
        message: `Review "${input.reviewId}" not found for workflow "${input.workflowId}"`,
        data: { resource: 'review', identifier: input.reviewId },
      };
      throw fault;
    }

    return review;
  },
});

function shapeGetReviewSuccess(result: GetReviewOutput): Response {
  return new Response(JSON.stringify(result), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function shapeGetReviewFault(fault: OperationFault): Response {
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

export const getReviewRestBinding: UnknownRestBinding = {
  method: 'GET',
  path: '/v1/workflows/:id/review/:reviewId',
  pathParamNames: ['id', 'reviewId'],
  operationName: 'weft.reviews.get',
  inputSources: {
    workflowId: { kind: 'path', pathParam: 'id' },
    reviewId: { kind: 'path', pathParam: 'reviewId' },
  },
  extractInput: async (_request, pathParams) => ({
    workflowId: pathParams['id'] ?? '',
    reviewId: pathParams['reviewId'] ?? '',
  }),
  success: { kind: 'json', status: 200 },
  shapeSuccess: (output: GetReviewOutput) => shapeGetReviewSuccess(output),
  shapeFault: shapeGetReviewFault,
};
