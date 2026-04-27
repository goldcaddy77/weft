import { z } from 'zod';

import type { Engine } from '../../core/engine.ts';
import type { PurgeResult } from '../../core/types.ts';
import { FAULT_CODE_TO_HTTP_STATUS, type OperationFault } from '../operation-fault.ts';
import { defineOperation } from '../operation-registry.ts';
import type { UnknownRestBinding } from '../rest-bindings.ts';
import {
  bulkListFilterInputSchema,
  faultMessage,
  invalidParamsFault,
  listFilterFromBulkInput,
  parseBulkListFilterFromBody,
  readOptionalJsonBody,
  type BulkListFilterInput,
} from './bulk-filter-helpers.ts';

const purgeWorkflowsOutput = z.unknown();

export type PurgeWorkflowsInput = BulkListFilterInput;
export type PurgeWorkflowsOutput = PurgeResult;

export const purgeWorkflowsOperation = defineOperation<PurgeWorkflowsInput, PurgeWorkflowsOutput>({
  name: 'weft.workflows.purge',
  summary: 'Purge terminal workflows',
  tags: ['Workflows'],
  inputSchema: bulkListFilterInputSchema,
  outputSchema: purgeWorkflowsOutput as z.ZodType<PurgeWorkflowsOutput>,
  access: { kind: 'public' },
  transports: { http: true, jsonRpcHttp: true, jsonRpcWebSocket: true, jsonRpcStdio: true },
  unknownKeyPolicy: { http: 'strip', jsonRpc: 'reject' },
  invoke: async ({ input, engine }): Promise<PurgeWorkflowsOutput> => {
    const e = engine as Engine;
    const filter = listFilterFromBulkInput(input);
    return await e.purge(Object.keys(filter).length === 0 ? undefined : filter);
  },
});

function shapePurgeWorkflowsSuccess(result: PurgeWorkflowsOutput): Response {
  return new Response(JSON.stringify(result), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function shapePurgeWorkflowsFault(fault: OperationFault): Response {
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

export const purgeWorkflowsRestBinding: UnknownRestBinding = {
  method: 'POST',
  path: '/v1/workflows/purge',
  pathParamNames: [],
  operationName: 'weft.workflows.purge',
  inputSources: {},
  extractInput: async (request) => {
    const raw = await readOptionalJsonBody(request);

    try {
      return { ...parseBulkListFilterFromBody(raw) };
    } catch (error) {
      throw invalidParamsFault(faultMessage(error));
    }
  },
  success: { kind: 'json', status: 200 },
  shapeSuccess: (output: PurgeWorkflowsOutput) => shapePurgeWorkflowsSuccess(output),
  shapeFault: shapePurgeWorkflowsFault,
};
