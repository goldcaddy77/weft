import { z } from 'zod';

import {
  AggregateDistinctKeyCapExceededError,
  AggregateOptionsValidationError,
  aggregateOptionsObjectSchema,
  type AggregateGroupBy,
} from '../../core/aggregate-validation.ts';
import type { Engine } from '../../core/engine.ts';
import { type AggregateResult } from '../../core/engine/aggregate.ts';
import { WorkflowListScanCapExceededError } from '../../core/engine/workflow-indexes.ts';
import {
  ListFilterValidationError,
  listFilterObjectSchema,
} from '../../core/list-filter-validation.ts';
import type { ListFilter } from '../../core/types.ts';
import { FAULT_CODE_TO_HTTP_STATUS, type OperationFault } from '../operation-fault.ts';
import { defineOperation } from '../operation-registry.ts';
import type { UnknownRestBinding } from '../rest-bindings.ts';

const aggregateWorkflowsInput = listFilterObjectSchema
  .omit({ limit: true, offset: true })
  .extend(aggregateOptionsObjectSchema.shape);

const aggregateWorkflowsOutput = z.object({
  total: z.number().int().min(0),
  groups: z.array(
    z.object({
      key: z.union([z.string(), z.null()]),
      count: z.number().int().min(0),
    }),
  ),
  truncated: z.boolean(),
});

export type AggregateWorkflowsInput = z.infer<typeof aggregateWorkflowsInput>;
export type AggregateWorkflowsOutput = AggregateResult;

function toUnprocessable(message: string): OperationFault {
  return { code: 'Unprocessable', message, data: { reason: message } };
}

export const aggregateWorkflowsOperation = defineOperation<
  AggregateWorkflowsInput,
  AggregateWorkflowsOutput
>({
  name: 'weft.workflows.aggregate',
  mcpExposable: false,
  summary: 'Aggregate workflows by a single dimension',
  tags: ['Workflows'],
  inputSchema: aggregateWorkflowsInput,
  outputSchema: aggregateWorkflowsOutput as z.ZodType<AggregateWorkflowsOutput>,
  access: { kind: 'public' },
  producibleFaults: ['Unprocessable'],
  transports: { http: true, jsonRpcHttp: true, jsonRpcWebSocket: true, jsonRpcStdio: true },
  unknownKeyPolicy: { http: 'strip', jsonRpc: 'reject' },
  invoke: async ({ input, engine }): Promise<AggregateWorkflowsOutput> => {
    const engineHandle = engine as Engine;
    const { groupBy, limit, ...filterFields } = input;
    const filter = filterFields as ListFilter;
    try {
      return await engineHandle.aggregate(filter, {
        groupBy,
        ...(limit !== undefined && { limit }),
      });
    } catch (error) {
      if (
        error instanceof ListFilterValidationError ||
        error instanceof AggregateOptionsValidationError
      ) {
        throw toUnprocessable(error.message);
      }
      if (
        error instanceof WorkflowListScanCapExceededError ||
        error instanceof AggregateDistinctKeyCapExceededError
      ) {
        throw toUnprocessable(error.message);
      }
      throw error;
    }
  },
});

/**
 * REST encoding of `groupBy`: a single `group_by` query parameter. Values
 * matching `attribute:<name>` are parsed as the structured `{ attribute }`
 * shape; the four fixed literals (`status`, `type`, `tenant`,
 * `failureCategory`) pass through as-is.
 */
function parseGroupByQuery(raw: string | null): AggregateGroupBy | null {
  if (raw === null) return null;
  const attributePrefix = 'attribute:';
  if (raw.startsWith(attributePrefix)) {
    const attribute = raw.slice(attributePrefix.length);
    if (attribute.length === 0) return null;
    return { attribute };
  }
  if (raw === 'status' || raw === 'type' || raw === 'tenant' || raw === 'failureCategory') {
    return raw;
  }
  return null;
}

// oxlint-disable-next-line complexity -- ID:server-operations-aggregate-workflows-extract-input
function extractAggregateWorkflowsInput(request: Request): AggregateWorkflowsInput {
  const url = new URL(request.url);

  const groupByRaw = url.searchParams.get('group_by');
  const groupBy = parseGroupByQuery(groupByRaw);
  if (groupBy === null) {
    throw toUnprocessable(
      'group_by must be one of "status", "type", "tenant", "failureCategory", or "attribute:<name>"',
    );
  }

  const filter: Record<string, unknown> = {};
  const statuses = url.searchParams.getAll('status');
  if (statuses.length === 1) {
    filter['status'] = statuses[0];
  } else if (statuses.length > 1) {
    filter['status'] = statuses;
  }
  const type = url.searchParams.get('type');
  if (type !== null) filter['type'] = type;
  const tags = url.searchParams.getAll('tag');
  if (tags.length > 0) filter['tags'] = tags;
  const idPrefix = url.searchParams.get('id_prefix');
  if (idPrefix !== null) filter['idPrefix'] = idPrefix;
  const tenantIds = url.searchParams.getAll('tenant_id');
  if (tenantIds.length === 1) {
    filter['tenantId'] = tenantIds[0];
  } else if (tenantIds.length > 1) {
    filter['tenantId'] = tenantIds;
  }

  const limit = url.searchParams.get('limit');
  const limitValue = limit !== null ? Math.floor(Number(limit)) : undefined;

  return {
    ...filter,
    groupBy,
    ...(limitValue !== undefined && Number.isFinite(limitValue) && limitValue >= 1
      ? { limit: limitValue }
      : {}),
  } as AggregateWorkflowsInput;
}

function shapeAggregateWorkflowsSuccess(result: AggregateWorkflowsOutput): Response {
  return new Response(JSON.stringify(result), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function shapeAggregateWorkflowsFault(fault: OperationFault): Response {
  if (fault.code === 'Unprocessable') {
    return new Response(JSON.stringify({ error: fault.message }), {
      status: 400,
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

export const aggregateWorkflowsRestBinding: UnknownRestBinding = {
  method: 'GET',
  path: '/v1/workflows/aggregate',
  pathParamNames: [],
  operationName: 'weft.workflows.aggregate',
  inputSources: {
    status: { kind: 'query', queryParam: 'status', repeating: true },
    type: { kind: 'query', queryParam: 'type' },
    tags: { kind: 'query', queryParam: 'tag', repeating: true },
    idPrefix: { kind: 'query', queryParam: 'id_prefix' },
    tenantId: { kind: 'query', queryParam: 'tenant_id', repeating: true },
    limit: { kind: 'query', queryParam: 'limit' },
    groupBy: { kind: 'query', queryParam: 'group_by' },
  },
  extractInput: async (request) => extractAggregateWorkflowsInput(request),
  success: { kind: 'json', status: 200 },
  shapeSuccess: (output: AggregateWorkflowsOutput) => shapeAggregateWorkflowsSuccess(output),
  shapeFault: shapeAggregateWorkflowsFault,
};
