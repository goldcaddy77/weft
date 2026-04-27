import { z } from 'zod';

import type { Engine } from '../../core/engine.ts';
import type { ReviewDecision, SubmitReviewOptions } from '../../core/types.ts';
import { FAULT_CODE_TO_HTTP_STATUS, type OperationFault } from '../operation-fault.ts';
import { defineOperation } from '../operation-registry.ts';
import type { UnknownRestBinding } from '../rest-bindings.ts';

const VALID_DECISIONS = [
  'approved',
  'rejected',
  'needs-changes',
] as const satisfies ReadonlyArray<ReviewDecision>;

const submitReviewDecisionInput = z.object({
  reviewId: z.string().min(1),
  decision: z.unknown().optional(),
  reviewer: z.unknown().optional(),
  feedback: z.unknown().optional(),
  workflowId: z.unknown().optional(),
});
const submitReviewDecisionOutput = z.object({
  ok: z.literal(true),
});

export type SubmitReviewDecisionInput = z.infer<typeof submitReviewDecisionInput>;
export type SubmitReviewDecisionOutput = z.infer<typeof submitReviewDecisionOutput>;

export const submitReviewDecisionOperation = defineOperation<
  SubmitReviewDecisionInput,
  SubmitReviewDecisionOutput
>({
  name: 'weft.reviews.decision.submit',
  summary: 'Submit a decision for a human review',
  tags: ['Reviews'],
  inputSchema: submitReviewDecisionInput,
  outputSchema: submitReviewDecisionOutput as z.ZodType<SubmitReviewDecisionOutput>,
  access: { kind: 'public' },
  transports: { http: true, jsonRpcHttp: true, jsonRpcWebSocket: true, jsonRpcStdio: true },
  unknownKeyPolicy: { http: 'strip', jsonRpc: 'reject' },
  invoke: async ({ input, engine }): Promise<SubmitReviewDecisionOutput> => {
    const e = engine as Engine;

    if (typeof input.decision !== 'string' || typeof input.reviewer !== 'string') {
      const fault: OperationFault = {
        code: 'InvalidParams',
        message: 'Missing required fields: decision, reviewer',
        data: { issues: [] },
      };
      throw fault;
    }

    if (!VALID_DECISIONS.includes(input.decision as (typeof VALID_DECISIONS)[number])) {
      const fault: OperationFault = {
        code: 'InvalidParams',
        message: `Invalid decision "${input.decision}". Must be one of: ${VALID_DECISIONS.join(', ')}`,
        data: { issues: [] },
      };
      throw fault;
    }

    if (input.feedback !== undefined && typeof input.feedback !== 'string') {
      const fault: OperationFault = {
        code: 'InvalidParams',
        message: 'Field "feedback" must be a string when provided',
        data: { issues: [] },
      };
      throw fault;
    }

    const reviewOptions: SubmitReviewOptions = {
      decision: input.decision as ReviewDecision,
      reviewer: input.reviewer,
    };
    if (typeof input.feedback === 'string') {
      reviewOptions.feedback = input.feedback;
    }
    if (typeof input.workflowId === 'string') {
      reviewOptions.workflowId = input.workflowId;
    }

    try {
      await e.submitReview(input.reviewId, reviewOptions);
      return { ok: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('not found')) {
        const fault: OperationFault = {
          code: 'NotFound',
          message,
          data: { resource: 'review', identifier: input.reviewId },
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

function shapeSubmitReviewDecisionSuccess(output: SubmitReviewDecisionOutput): Response {
  return new Response(JSON.stringify(output), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function shapeSubmitReviewDecisionFault(fault: OperationFault): Response {
  return new Response(JSON.stringify({ error: fault.message }), {
    status: FAULT_CODE_TO_HTTP_STATUS[fault.code],
    headers: { 'Content-Type': 'application/json' },
  });
}

export const submitReviewDecisionRestBinding: UnknownRestBinding = {
  method: 'POST',
  path: '/v1/reviews/:reviewId/decision',
  pathParamNames: ['reviewId'],
  operationName: 'weft.reviews.decision.submit',
  inputSources: {
    reviewId: { kind: 'path', pathParam: 'reviewId' },
    decision: { kind: 'body-field', bodyField: 'decision' },
    reviewer: { kind: 'body-field', bodyField: 'reviewer' },
    feedback: { kind: 'body-field', bodyField: 'feedback' },
    workflowId: { kind: 'body-field', bodyField: 'workflowId' },
  },
  extractInput: async (request, pathParams) => {
    const body = await request.json().catch(() => {
      throw new Error('Invalid JSON body');
    });
    const record = typeof body === 'object' && body !== null && !Array.isArray(body) ? body : {};

    return {
      reviewId: pathParams['reviewId'] ?? '',
      decision: record['decision'],
      reviewer: record['reviewer'],
      feedback: record['feedback'],
      workflowId: record['workflowId'],
    };
  },
  success: { kind: 'json', status: 200 },
  shapeSuccess: (output: SubmitReviewDecisionOutput) => shapeSubmitReviewDecisionSuccess(output),
  shapeFault: shapeSubmitReviewDecisionFault,
};
