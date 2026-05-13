import { z } from 'zod';

import { assertScopedBulkWorkflowFilter } from '../../core/bulk-workflow-filter.ts';
import type { Engine } from '../../core/engine.ts';
import { coerceStartWorkflowTags } from '../../core/start-workflow-validation.ts';
import type { BulkCancelResult } from '../../core/types.ts';
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
  type BulkListFilterInput,
} from './bulk-filter-helpers.ts';
import {
  invalidParamsFault,
  shapeLegacyRestFaultWithRawEngineFailureMessage,
} from './operation-helpers.ts';

const bulkCancelWorkflowsOutput = z.unknown();

export type BulkCancelWorkflowsInput = BulkListFilterInput;
export type BulkCancelWorkflowsOutput = BulkCancelResult;

export const bulkCancelWorkflowsOperation = defineOperation<
  BulkCancelWorkflowsInput,
  BulkCancelWorkflowsOutput
>({
  name: 'weft.workflows.bulk.cancel',
  mcpExposable: false,
  summary: 'Cancel workflows in bulk',
  tags: ['Workflows'],
  inputSchema: bulkListFilterInputSchema,
  outputSchema: bulkCancelWorkflowsOutput as z.ZodType<BulkCancelWorkflowsOutput>,
  access: { kind: 'public' },
  transports: { http: true, jsonRpcHttp: true, jsonRpcWebSocket: true, jsonRpcStdio: true },
  unknownKeyPolicy: { http: 'strip', jsonRpc: 'reject' },
  invoke: async ({ input, engine }): Promise<BulkCancelWorkflowsOutput> => {
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
      return await e.cancelAll(filter);
    } catch (error) {
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
  // tag validation) maps canonically to 400 via
  // `FAULT_CODE_TO_HTTP_STATUS`. `EngineFailure` echoes the raw
  // engine message at 500 (legacy parity). Sanitization is a
  // deliberate behavior shift left for a follow-up PR.
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
      return { ...parseBulkListFilterFromBody(raw) };
    } catch (error) {
      throw invalidParamsFault(faultMessage(error));
    }
  },
  success: { kind: 'json', status: 200 },
  shapeSuccess: (output: BulkCancelWorkflowsOutput) => shapeBulkCancelWorkflowsSuccess(output),
  shapeFault: shapeBulkCancelWorkflowsFault,
};
