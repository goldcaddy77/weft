import { z } from 'zod';

import { assertScopedBulkWorkflowFilter } from '../../core/bulk-workflow-filter.ts';
import {
  BulkDeleteRequiresTerminalWorkflowsError,
  BulkOperationConfirmationError,
  type Engine,
} from '../../core/engine.ts';
import { coerceStartWorkflowTags } from '../../core/start-workflow-validation.ts';
import type { BulkDeleteResult, BulkOperationDryRunResult } from '../../core/types.ts';
import { FAULT_CODE_TO_HTTP_STATUS, type OperationFault } from '../operation-fault.ts';
import { defineOperation } from '../operation-registry.ts';
import type { UnknownRestBinding } from '../rest-bindings.ts';
import {
  bulkListFilterInputSchema,
  bulkOperationControlInputSchema,
  bulkOperationOptionsFromInput,
  bulkOperatorAccessPolicy,
  engineFailureFault,
  faultMessage,
  invalidParamsFault,
  listFilterFromBulkInput,
  parseBulkListFilterFromBody,
  parseBulkOperationControlFromBody,
  readOptionalJsonBody,
  unprocessableFault,
  type BulkListFilterInput,
  type BulkOperationControlInput,
} from './bulk-filter-helpers.ts';

const bulkDeleteWorkflowsInput = bulkListFilterInputSchema.merge(bulkOperationControlInputSchema);
const bulkDeleteWorkflowsOutput = z.unknown();

export type BulkDeleteWorkflowsInput = BulkListFilterInput & BulkOperationControlInput;
export type BulkDeleteWorkflowsOutput = BulkDeleteResult | BulkOperationDryRunResult;

export const bulkDeleteWorkflowsOperation = defineOperation<
  BulkDeleteWorkflowsInput,
  BulkDeleteWorkflowsOutput
>({
  name: 'weft.workflows.bulk.delete',
  mcpExposable: false,
  summary: 'Delete terminal workflows in bulk',
  tags: ['Workflows'],
  inputSchema: bulkDeleteWorkflowsInput,
  outputSchema: bulkDeleteWorkflowsOutput as z.ZodType<BulkDeleteWorkflowsOutput>,
  access: bulkOperatorAccessPolicy,
  producibleFaults: ['Unprocessable'],
  transports: { http: true, jsonRpcHttp: true, jsonRpcWebSocket: true, jsonRpcStdio: true },
  unknownKeyPolicy: { http: 'strip', jsonRpc: 'reject' },
  invoke: async ({ input, engine, principal }): Promise<BulkDeleteWorkflowsOutput> => {
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

    const operationOptions = bulkOperationOptionsFromInput(input, principal);

    try {
      if (operationOptions.dryRun === true) {
        return await e.deleteAll(filter, operationOptions);
      }
      return await e.deleteAll(filter, operationOptions);
    } catch (error) {
      if (error instanceof BulkOperationConfirmationError) {
        throw invalidParamsFault(error.message);
      }
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
  return new Response(JSON.stringify({ error: fault.message }), {
    status: FAULT_CODE_TO_HTTP_STATUS[fault.code],
    headers: { 'Content-Type': 'application/json' },
  });
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
      return {
        ...parseBulkListFilterFromBody(raw),
        ...parseBulkOperationControlFromBody(raw),
      };
    } catch (error) {
      throw invalidParamsFault(faultMessage(error));
    }
  },
  success: { kind: 'json', status: 200 },
  shapeSuccess: (output: BulkDeleteWorkflowsOutput) => shapeBulkDeleteWorkflowsSuccess(output),
  shapeFault: shapeBulkDeleteWorkflowsFault,
};
