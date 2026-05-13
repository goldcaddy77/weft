import { z } from 'zod';

import { assertScopedBulkWorkflowFilter } from '../../core/bulk-workflow-filter.ts';
import { BulkOperationConfirmationError, type Engine } from '../../core/engine.ts';
import { coerceStartWorkflowTags } from '../../core/start-workflow-validation.ts';
import type { BulkOperationDryRunResult, BulkSignalResult, ListFilter } from '../../core/types.ts';
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
} from './bulk-filter-helpers.ts';
import {
  invalidParamsFault,
  shapeLegacyRestFaultWithRawEngineFailureMessage,
} from './operation-helpers.ts';

const bulkSignalWorkflowsInput = bulkListFilterInputSchema
  .extend({
    name: z.string().min(1),
    payload: z.unknown().optional(),
  })
  .merge(bulkOperationControlInputSchema);
const bulkSignalWorkflowsOutput = z.unknown();

export type BulkSignalWorkflowsInput = z.infer<typeof bulkSignalWorkflowsInput>;
export type BulkSignalWorkflowsOutput = BulkSignalResult | BulkOperationDryRunResult;

export const bulkSignalWorkflowsOperation = defineOperation<
  BulkSignalWorkflowsInput,
  BulkSignalWorkflowsOutput
>({
  name: 'weft.workflows.bulk.signal',
  mcpExposable: false,
  summary: 'Signal workflows in bulk',
  tags: ['Workflows'],
  inputSchema: bulkSignalWorkflowsInput,
  outputSchema: bulkSignalWorkflowsOutput as z.ZodType<BulkSignalWorkflowsOutput>,
  access: bulkOperatorAccessPolicy,
  transports: { http: true, jsonRpcHttp: true, jsonRpcWebSocket: true, jsonRpcStdio: true },
  unknownKeyPolicy: { http: 'strip', jsonRpc: 'reject' },
  invoke: async ({ input, engine, principal }): Promise<BulkSignalWorkflowsOutput> => {
    const e = engine as Engine;

    let validatedTags: string[] | undefined;
    if (input.tags !== undefined) {
      try {
        validatedTags = coerceStartWorkflowTags(input.tags, 'Field "filter.tags"');
      } catch (error) {
        throw invalidParamsFault(faultMessage(error));
      }
    }

    const filterInput: BulkListFilterInput = {
      ...input,
      ...(validatedTags === undefined ? {} : { tags: validatedTags }),
    };
    const filter = listFilterFromBulkInput(filterInput);

    try {
      assertScopedBulkWorkflowFilter(filter);
    } catch (error) {
      throw invalidParamsFault(faultMessage(error));
    }

    const operationOptions = bulkOperationOptionsFromInput(input, principal);

    try {
      if (operationOptions.dryRun === true) {
        return await e.signalAll(filter, input.name, input.payload, operationOptions);
      }
      return await e.signalAll(filter, input.name, input.payload, operationOptions);
    } catch (error) {
      if (error instanceof BulkOperationConfirmationError) {
        throw invalidParamsFault(error.message);
      }
      throw engineFailureFault(faultMessage(error));
    }
  },
});

function shapeBulkSignalWorkflowsSuccess(result: BulkSignalWorkflowsOutput): Response {
  return new Response(JSON.stringify(result), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function shapeBulkSignalWorkflowsFault(fault: OperationFault): Response {
  // `InvalidParams` (caller mistakes — bad body, scope assertion,
  // tag validation) maps canonically to 400. `EngineFailure` echoes
  // raw engine message at 500 (legacy parity).
  return shapeLegacyRestFaultWithRawEngineFailureMessage(fault);
}

export const bulkSignalWorkflowsRestBinding: UnknownRestBinding = {
  method: 'POST',
  path: '/v1/workflows/bulk/signal',
  pathParamNames: [],
  operationName: 'weft.workflows.bulk.signal',
  inputSources: {
    name: { kind: 'body-field', bodyField: 'name' },
    payload: { kind: 'body-field', bodyField: 'payload' },
  },
  extractInput: async (request) => {
    const raw = await readOptionalJsonBody(request);
    if (raw === undefined || typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      throw invalidParamsFault('Request body must be a JSON object');
    }

    const body = raw as Record<string, unknown>;
    let filter: ListFilter;
    try {
      filter = { ...parseBulkListFilterFromBody(body) };
    } catch (error) {
      throw invalidParamsFault(faultMessage(error));
    }

    const name = body['name'];
    if (typeof name !== 'string' || name.length === 0) {
      throw invalidParamsFault('Field "name" must be a non-empty string');
    }

    return {
      ...filter,
      name,
      ...(body['payload'] === undefined ? {} : { payload: body['payload'] }),
      ...parseBulkOperationControlFromBody(body),
    };
  },
  success: { kind: 'json', status: 200 },
  shapeSuccess: (output: BulkSignalWorkflowsOutput) => shapeBulkSignalWorkflowsSuccess(output),
  shapeFault: shapeBulkSignalWorkflowsFault,
};
