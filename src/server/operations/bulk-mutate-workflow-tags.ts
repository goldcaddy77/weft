import { z } from 'zod';

import { assertScopedBulkWorkflowFilter } from '../../core/bulk-workflow-filter.ts';
import { BulkOperationConfirmationError, type Engine } from '../../core/engine.ts';
import { coerceStartWorkflowTags } from '../../core/start-workflow-validation.ts';
import type {
  BulkOperationCommitOptions,
  BulkOperationDryRunOptions,
  BulkOperationDryRunResult,
  BulkTagResult,
  ListFilter,
} from '../../core/types.ts';
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
} from './bulk-filter-helpers.ts';

const bulkMutateWorkflowTagsInput = z
  .object({
    filter: bulkListFilterInputSchema.optional(),
    tags: z.array(z.string()),
    operation: z.enum(['add', 'remove']),
  })
  .merge(bulkOperationControlInputSchema);
const bulkMutateWorkflowTagsOutput = z.unknown();

export type BulkMutateWorkflowTagsInput = z.infer<typeof bulkMutateWorkflowTagsInput>;
export type BulkMutateWorkflowTagsOutput = BulkTagResult | BulkOperationDryRunResult;

export const bulkMutateWorkflowTagsOperation = defineOperation<
  BulkMutateWorkflowTagsInput,
  BulkMutateWorkflowTagsOutput
>({
  name: 'weft.workflows.bulk.tags',
  mcpExposable: false,
  summary: 'Add or remove workflow tags in bulk',
  tags: ['Workflows'],
  inputSchema: bulkMutateWorkflowTagsInput,
  outputSchema: bulkMutateWorkflowTagsOutput as z.ZodType<BulkMutateWorkflowTagsOutput>,
  access: bulkOperatorAccessPolicy,
  transports: { http: true, jsonRpcHttp: true, jsonRpcWebSocket: true, jsonRpcStdio: true },
  unknownKeyPolicy: { http: 'strip', jsonRpc: 'reject' },
  invoke: async ({ input, engine, principal }): Promise<BulkMutateWorkflowTagsOutput> => {
    const e = engine as Engine;

    let validatedFilterTags: string[] | undefined;
    if (input.filter?.tags !== undefined) {
      try {
        validatedFilterTags = coerceStartWorkflowTags(input.filter.tags, 'Field "filter.tags"');
      } catch (error) {
        throw invalidParamsFault(faultMessage(error));
      }
    }

    let validatedTags: string[];
    try {
      validatedTags = coerceStartWorkflowTags(input.tags, 'Field "tags"');
    } catch (error) {
      throw invalidParamsFault(faultMessage(error));
    }

    const filter = listFilterFromBulkInput({
      ...input.filter,
      ...(validatedFilterTags === undefined ? {} : { tags: validatedFilterTags }),
    });

    try {
      assertScopedBulkWorkflowFilter(filter);
    } catch (error) {
      throw invalidParamsFault(faultMessage(error));
    }

    const operationOptions = bulkOperationOptionsFromInput(input, principal);

    try {
      return await executeBulkTagMutation(
        e,
        filter,
        validatedTags,
        input.operation,
        operationOptions,
      );
    } catch (error) {
      if (error instanceof BulkOperationConfirmationError) {
        throw invalidParamsFault(error.message);
      }
      throw engineFailureFault(faultMessage(error));
    }
  },
});

async function executeBulkTagMutation(
  engine: Engine,
  filter: ListFilter,
  tags: string[],
  operation: 'add' | 'remove',
  options: BulkOperationDryRunOptions | BulkOperationCommitOptions,
): Promise<BulkMutateWorkflowTagsOutput> {
  if (options.dryRun === true) {
    return operation === 'add'
      ? await engine.tagAll(filter, tags, options)
      : await engine.untagAll(filter, tags, options);
  }

  return operation === 'add'
    ? await engine.tagAll(filter, tags, options)
    : await engine.untagAll(filter, tags, options);
}

function shapeBulkMutateWorkflowTagsSuccess(result: BulkMutateWorkflowTagsOutput): Response {
  return new Response(JSON.stringify(result), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function shapeBulkMutateWorkflowTagsFault(fault: OperationFault): Response {
  // `InvalidParams` (caller mistakes — bad body, scope assertion,
  // tag validation, missing operation field) maps canonically to
  // 400. `EngineFailure` echoes raw engine message at 500 (legacy
  // parity).
  return new Response(JSON.stringify({ error: fault.message }), {
    status: FAULT_CODE_TO_HTTP_STATUS[fault.code],
    headers: { 'Content-Type': 'application/json' },
  });
}

export const bulkMutateWorkflowTagsRestBinding: UnknownRestBinding = {
  method: 'PATCH',
  path: '/v1/workflows/bulk/tags',
  pathParamNames: [],
  operationName: 'weft.workflows.bulk.tags',
  inputSources: {
    filter: { kind: 'body-field', bodyField: 'filter' },
    tags: { kind: 'body-field', bodyField: 'tags' },
    operation: { kind: 'body-field', bodyField: 'operation' },
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

    let tags: string[];
    try {
      tags = coerceStartWorkflowTags(body['tags'], 'Field "tags"');
    } catch (error) {
      throw invalidParamsFault(faultMessage(error));
    }

    const operation = body['operation'];
    if (operation !== 'add' && operation !== 'remove') {
      throw invalidParamsFault('Field "operation" must be "add" or "remove"');
    }

    return {
      filter,
      tags,
      operation,
      ...parseBulkOperationControlFromBody(body),
    };
  },
  success: { kind: 'json', status: 200 },
  shapeSuccess: (output: BulkMutateWorkflowTagsOutput) =>
    shapeBulkMutateWorkflowTagsSuccess(output),
  shapeFault: shapeBulkMutateWorkflowTagsFault,
};
