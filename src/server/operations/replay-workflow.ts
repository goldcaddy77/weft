/**
 * `weft.workflows.replay` operation + REST binding.
 *
 * Reconstructs historical workflow state at a checkpoint step. This is a
 * side-effecting read (it does not mutate the live workflow), so it is
 * declared `authenticated` with a scope requirement to prevent anonymous
 * access to sensitive historical state.
 *
 * REST response mirrors the legacy `handleReplayWorkflowToStep` contract:
 * content-negotiated JSON or msgpack, 404 for missing workflow or step.
 *
 * @module server/operations/replay-workflow
 */

import { z } from 'zod';

import { encode } from '../../core/codec.ts';
import type { Engine } from '../../core/engine.ts';
import type { WorkflowReplay } from '../../core/types.ts';
import { FAULT_CODE_TO_HTTP_STATUS, type OperationFault } from '../operation-fault.ts';
import { defineOperation } from '../operation-registry.ts';
import type { UnknownRestBinding } from '../rest-bindings.ts';
import { invalidParamsFault } from './operation-helpers.ts';

const replayWorkflowInput = z.object({
  workflowId: z.string().min(1),
  step: z.union([z.string(), z.number()]),
});

const replayWorkflowOutput = z.unknown();

export type ReplayWorkflowInput = z.infer<typeof replayWorkflowInput>;
export type ReplayWorkflowOutput = WorkflowReplay;

export const replayWorkflowOperation = defineOperation<ReplayWorkflowInput, ReplayWorkflowOutput>({
  name: 'weft.workflows.replay',
  mcpExposable: false,
  summary: 'Replay a workflow to a historical checkpoint step',
  tags: ['Checkpoints'],
  inputSchema: replayWorkflowInput,
  outputSchema: replayWorkflowOutput as z.ZodType<ReplayWorkflowOutput>,
  access: {
    kind: 'scoped',
    scopes: { kind: 'anyOf', scopes: ['workflows:read'] },
  },
  producibleFaults: ['NotFound'],
  discoverable: true,
  transports: { http: true, jsonRpcHttp: true, jsonRpcWebSocket: true, jsonRpcStdio: true },
  unknownKeyPolicy: { http: 'strip', jsonRpc: 'reject' },
  invoke: async ({ input, engine }): Promise<ReplayWorkflowOutput> => {
    const e = engine as Engine;

    // Confirm the workflow exists first (mirrors legacy 404 before step check).
    const state = await e.get(input.workflowId);
    if (state === null) {
      const notFoundFault: OperationFault = {
        code: 'NotFound',
        message: `Workflow "${input.workflowId}" not found`,
        data: { resource: 'workflow', identifier: input.workflowId },
      };
      throw notFoundFault;
    }

    const stepNumber = Number(input.step);
    if (!Number.isSafeInteger(stepNumber) || stepNumber < 0) {
      throw invalidParamsFault(`Invalid step: ${String(input.step)}`);
    }

    const replay = await e.replayTo(input.workflowId, stepNumber);
    if (replay === null) {
      const notFoundFault: OperationFault = {
        code: 'NotFound',
        message: `Replay not found at step ${stepNumber} for workflow ${input.workflowId}`,
        data: { resource: 'replay', identifier: `${input.workflowId}@${stepNumber}` },
      };
      throw notFoundFault;
    }

    return replay;
  },
});

function shapeReplayWorkflowFault(fault: OperationFault): Response {
  if (fault.code === 'NotFound') {
    return new Response(JSON.stringify({ error: fault.message }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  if (fault.code === 'InvalidParams') {
    return new Response(JSON.stringify({ error: fault.message }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  if (fault.code === 'Unauthorized') {
    return new Response(JSON.stringify({ error: fault.message }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  if (fault.code === 'Forbidden') {
    return new Response(JSON.stringify({ error: fault.message }), {
      status: 403,
      headers: { 'Content-Type': 'application/json' },
    });
  }
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

/**
 * Content-negotiate success: REST callers that `Accept: application/msgpack`
 * get msgpack encoding; everyone else gets JSON. This matches the legacy
 * `negotiatedResponse` behavior from `handleReplayWorkflowToStep`.
 */
function shapeReplayWorkflowSuccess(output: ReplayWorkflowOutput, request: Request): Response {
  const accept = request.headers.get('Accept') ?? '';
  if (accept.includes('application/msgpack')) {
    return new Response(encode(output), {
      status: 200,
      headers: { 'Content-Type': 'application/msgpack' },
    });
  }
  return new Response(JSON.stringify(output), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

export const replayWorkflowRestBinding: UnknownRestBinding = {
  method: 'GET',
  path: '/v1/workflows/:id/replay/:step',
  pathParamNames: ['id', 'step'],
  operationName: 'weft.workflows.replay',
  inputSources: {
    workflowId: { kind: 'path', pathParam: 'id' },
    step: { kind: 'path', pathParam: 'step' },
  },
  extractInput: async (_request, pathParams) => ({
    workflowId: pathParams['id'] ?? '',
    step: pathParams['step'] ?? '0',
  }),
  success: { kind: 'json', status: 200 },
  shapeSuccess: (output: ReplayWorkflowOutput, request: Request) =>
    shapeReplayWorkflowSuccess(output, request),
  shapeFault: shapeReplayWorkflowFault,
};
