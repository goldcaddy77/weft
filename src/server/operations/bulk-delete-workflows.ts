import { z } from 'zod';

import { assertScopedBulkWorkflowFilter } from '../../core/bulk-workflow-filter.ts';
import { BulkDeleteRequiresTerminalWorkflowsError, type Engine } from '../../core/engine.ts';
import { coerceStartWorkflowTags } from '../../core/start-workflow-validation.ts';
import type { BulkDeleteResult } from '../../core/types.ts';
import type { OperationFault } from '../operation-fault.ts';
import { defineOperation } from '../operation-registry.ts';
import type { UnknownRestBinding } from '../rest-bindings.ts';
import {
  bulkListFilterInputSchema,
  engineFailureFault,
  faultMessage,
  listFilterFromBulkInput,
  parseBulkListFilterFromBody,
  readOptionalJsonBody,
  unprocessableFault,
  type BulkListFilterInput,
} from './bulk-filter-helpers.ts';
import {
  invalidParamsFault,
  shapeLegacyRestFaultWithRawEngineFailureMessage,
} from './operation-helpers.ts';

const bulkDeleteWorkflowsOutput = z.unknown();

export type BulkDeleteWorkflowsInput = BulkListFilterInput;
export type BulkDeleteWorkflowsOutput = BulkDeleteResult;

export const bulkDeleteWorkflowsOperation = defineOperation<
  BulkDeleteWorkflowsInput,
  BulkDeleteWorkflowsOutput
>({
  name: 'weft.workflows.bulk.delete',
  mcpExposable: false,
  summary: 'Delete terminal workflows in bulk',
  tags: ['Workflows'],
  inputSchema: bulkListFilterInputSchema,
  outputSchema: bulkDeleteWorkflowsOutput as z.ZodType<BulkDeleteWorkflowsOutput>,
  access: { kind: 'public' },
  producibleFaults: ['Unprocessable'],
  transports: { http: true, jsonRpcHttp: true, jsonRpcWebSocket: true, jsonRpcStdio: true },
  unknownKeyPolicy: { http: 'strip', jsonRpc: 'reject' },
  invoke: async ({ input, engine }): Promise<BulkDeleteWorkflowsOutput> => {
    const e = engine as Engine;

    let validatedTags: string[] | undefined;
    if (input.tags !== undefined) {
      try {
        validatedTags = coerceStartWorkflowTags(input.tags, 'Field "filter.tags"');
      } catch (error) {
        throw invalidParamsFault(faultMessage(error));
      }
    }

    const filter = listFilterFromBulkInput({
      ...input,
      ...(validatedTags === undefined ? {} : { tags: validatedTags }),
    });

    try {
      assertScopedBulkWorkflowFilter(filter);
    } catch (error) {
      throw invalidParamsFault(faultMessage(error));
    }

    try {
      return await e.deleteAll(filter);
    } catch (error) {
      if (error instanceof BulkDeleteRequiresTerminalWorkflowsError) {
        throw unprocessableFault(error.message);
      }

      throw engineFailureFault(faultMessage(error));
    }
  },
});

function shapeBulkDeleteWorkflowsSuccess(result: BulkDeleteWorkflowsOutput): Response {
  return new Response(JSON.stringify(result), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function shapeBulkDeleteWorkflowsFault(fault: OperationFault): Response {
  return shapeLegacyRestFaultWithRawEngineFailureMessage(fault);
}

export const bulkDeleteWorkflowsRestBinding: UnknownRestBinding = {
  method: 'DELETE',
  path: '/v1/workflows/bulk',
  pathParamNames: [],
  operationName: 'weft.workflows.bulk.delete',
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
  shapeSuccess: (output: BulkDeleteWorkflowsOutput) => shapeBulkDeleteWorkflowsSuccess(output),
  shapeFault: shapeBulkDeleteWorkflowsFault,
};
