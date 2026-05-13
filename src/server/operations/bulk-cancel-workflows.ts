import { z } from 'zod';

import { assertScopedBulkWorkflowFilter } from '../../core/bulk-workflow-filter.ts';
import { BulkOperationConfirmationError, type Engine } from '../../core/engine.ts';
import { coerceStartWorkflowTags } from '../../core/start-workflow-validation.ts';
import type { BulkCancelResult, BulkOperationDryRunResult } from '../../core/types.ts';
import type { OperationFault } from '../operation-fault.ts';
import { defineOperation } from '../operation-registry.ts';
import type { UnknownRestBinding } from '../rest-bindings.ts';
import {
  bulkListFilterInputSchema,
  bulkOperationControlInputSchema,
  bulkOperationOptionsFromInput,
  bulkOperatorAccessPolicy,
  engineFailureFault,
  faultMessage,
  listFilterFromBulkInput,
  parseBulkListFilterFromBody,
  parseBulkOperationControlFromBody,
  readOptionalJsonBody,
  type BulkListFilterInput,
  type BulkOperationControlInput,
} from './bulk-filter-helpers.ts';
import {
  invalidParamsFault,
  shapeLegacyRestFaultWithRawEngineFailureMessage,
} from './operation-helpers.ts';

const bulkCancelWorkflowsInput = bulkListFilterInputSchema.merge(bulkOperationControlInputSchema);
const bulkCancelWorkflowsOutput = z.unknown();

export type BulkCancelWorkflowsInput = BulkListFilterInput & BulkOperationControlInput;
export type BulkCancelWorkflowsOutput = BulkCancelResult | BulkOperationDryRunResult;

export const bulkCancelWorkflowsOperation = defineOperation<
  BulkCancelWorkflowsInput,
  BulkCancelWorkflowsOutput
>({
  name: 'weft.workflows.bulk.cancel',
  mcpExposable: false,
  summary: 'Cancel workflows in bulk',
  tags: ['Workflows'],
  inputSchema: bulkCancelWorkflowsInput,
  outputSchema: bulkCancelWorkflowsOutput as z.ZodType<BulkCancelWorkflowsOutput>,
  access: bulkOperatorAccessPolicy,
  transports: { http: true, jsonRpcHttp: true, jsonRpcWebSocket: true, jsonRpcStdio: true },
  unknownKeyPolicy: { http: 'strip', jsonRpc: 'reject' },
  invoke: async ({ input, engine, principal }): Promise<BulkCancelWorkflowsOutput> => {
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
        return await e.cancelAll(filter, operationOptions);
      }
      return await e.cancelAll(filter, operationOptions);
    } catch (error) {
      if (error instanceof BulkOperationConfirmationError) {
        throw invalidParamsFault(error.message);
      }
      throw engineFailureFault(faultMessage(error));
    }
  },
});

function shapeBulkCancelWorkflowsSuccess(result: BulkCancelWorkflowsOutput): Response {
  return new Response(JSON.stringify(result), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function shapeBulkCancelWorkflowsFault(fault: OperationFault): Response {
  // `InvalidParams` (caller mistakes — bad body, scope assertion,
  // tag validation) maps canonically to 400. `EngineFailure` echoes
  // the raw engine message at 500 (legacy parity). Sanitization is a
  // deliberate behavior shift left for a follow-up pull request.
  return shapeLegacyRestFaultWithRawEngineFailureMessage(fault);
}

export const bulkCancelWorkflowsRestBinding: UnknownRestBinding = {
  method: 'POST',
  path: '/v1/workflows/bulk/cancel',
  pathParamNames: [],
  operationName: 'weft.workflows.bulk.cancel',
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
  shapeSuccess: (output: BulkCancelWorkflowsOutput) => shapeBulkCancelWorkflowsSuccess(output),
  shapeFault: shapeBulkCancelWorkflowsFault,
};
