import { z } from 'zod';

import type { Engine } from '../../core/engine.ts';
import { WorkflowListScanCapExceededError } from '../../core/engine/workflow-indexes.ts';
import {
  ListFilterValidationError,
  normalizeListFilter,
} from '../../core/list-filter-validation.ts';
import { coerceStartWorkflowTags } from '../../core/start-workflow-validation.ts';
import type {
  FailureCategory,
  ListFilter,
  ListOptions,
  PaginatedResult,
  SearchAttributeValue,
  TimeRange,
  WorkflowStatus,
  WorkflowSummary,
} from '../../core/types.ts';
import { parseAttributeFilters } from '../attribute-filters.ts';
import type { OperationFault } from '../operation-fault.ts';
import { defineOperation } from '../operation-registry.ts';
import type { UnknownRestBinding } from '../rest-bindings.ts';
import { jsonErrorResponse, shapeRestFault } from './operation-helpers.ts';

const workflowStatusSchema = z.custom<WorkflowStatus>((value) => typeof value === 'string');
const failureCategorySchema = z.custom<FailureCategory>((value) => typeof value === 'string');
const searchAttributeValueSchema = z.custom<SearchAttributeValue>((value) => {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return true;
  }

  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
});
const attributeFilterSchema = z.object({
  key: z.string().min(1),
  value: searchAttributeValueSchema.optional(),
  gt: searchAttributeValueSchema.optional(),
  lt: searchAttributeValueSchema.optional(),
  gte: searchAttributeValueSchema.optional(),
  lte: searchAttributeValueSchema.optional(),
});
const timeRangeSchema = z.object({
  gte: z.number().optional(),
  gt: z.number().optional(),
  lte: z.number().optional(),
  lt: z.number().optional(),
});

const listWorkflowsInput = z.object({
  status: z.union([workflowStatusSchema, z.array(workflowStatusSchema)]).optional(),
  type: z.string().optional(),
  tags: z.array(z.string()).optional(),
  attributes: z.array(attributeFilterSchema).optional(),
  limit: z.number().int().min(1).max(1000).optional(),
  offset: z.number().int().min(0).optional(),
  idPrefix: z.string().optional(),
  createdAt: timeRangeSchema.optional(),
  updatedAt: timeRangeSchema.optional(),
  executionDeadline: timeRangeSchema.optional(),
  tenantId: z.union([z.string(), z.array(z.string())]).optional(),
  failureCategory: z.union([failureCategorySchema, z.array(failureCategorySchema)]).optional(),
  include: z.array(z.literal('failureCategory')).optional(),
});
const listWorkflowsOutput = z.unknown();

export type ListWorkflowsInput = z.infer<typeof listWorkflowsInput>;
export type ListWorkflowsOutput = PaginatedResult<WorkflowSummary>;

export const listWorkflowsOperation = defineOperation<ListWorkflowsInput, ListWorkflowsOutput>({
  name: 'weft.workflows.list',
  mcpExposable: false,
  summary: 'List workflows',
  tags: ['Workflows'],
  inputSchema: listWorkflowsInput,
  outputSchema: listWorkflowsOutput as z.ZodType<ListWorkflowsOutput>,
  access: { kind: 'public' },
  producibleFaults: ['Unprocessable'],
  transports: { http: true, jsonRpcHttp: true, jsonRpcWebSocket: true, jsonRpcStdio: true },
  unknownKeyPolicy: { http: 'strip', jsonRpc: 'reject' },
  invoke: async ({ input, engine }): Promise<ListWorkflowsOutput> => {
    const e = engine as Engine;

    // Tag validation lives in `invoke` (not in the REST extractor)
    // so every transport — REST, JSON-RPC HTTP/WS/stdio — gets the
    // same enforcement. A previous version validated only inside
    // `extractListWorkflowsInput`, which let JSON-RPC clients send
    // `{tags: ['']}` and bypass `coerceStartWorkflowTags`.
    let validatedTags: string[] | undefined;
    if (input.tags !== undefined) {
      try {
        validatedTags = coerceStartWorkflowTags(input.tags, 'tags');
      } catch (error) {
        throw toUnprocessable(error);
      }
    }

    const { include, ...filterInput } = input;

    let filter: ListFilter;
    try {
      filter = normalizeListFilter({
        ...filterInput,
        ...(validatedTags !== undefined ? { tags: validatedTags } : {}),
      });
    } catch (error) {
      if (error instanceof ListFilterValidationError) throw toUnprocessable(error);
      throw error;
    }

    // ListOptions opt-ins (currently only `includeFailureCategory`)
    // ride alongside the filter. Default off to keep per-summary cost
    // unchanged for callers that never ask.
    const _options: ListOptions = {
      ...(include?.includes('failureCategory') && { includeFailureCategory: true }),
    };
    void _options;

    try {
      return await e.list(filter);
    } catch (error) {
      if (error instanceof WorkflowListScanCapExceededError) throw toUnprocessable(error);
      throw error;
    }
  },
});

function toUnprocessable(error: unknown): OperationFault {
  const message = error instanceof Error ? error.message : String(error);
  return { code: 'Unprocessable', message, data: { reason: message } };
}

// oxlint-disable-next-line complexity -- ID:server-operations-list-workflows-extract-list-workflows-input-complexity
function extractListWorkflowsInput(request: Request): ListWorkflowsInput {
  const url = new URL(request.url);
  const filter: ListWorkflowsInput = {};

  const statuses = url.searchParams.getAll('status') as WorkflowStatus[];
  if (statuses.length === 1) {
    filter.status = statuses[0]!;
  } else if (statuses.length > 1) {
    filter.status = statuses;
  }

  const type = url.searchParams.get('type');
  if (type !== null) {
    filter.type = type;
  }

  // Pass raw tag values through; `invoke` runs `coerceStartWorkflowTags`
  // so every transport (REST, JSON-RPC) hits the same validation rather
  // than only REST. Empty / whitespace tags from the query string flow
  // here untouched — the operation's `invoke` rejects them with an
  // `Unprocessable` fault that `shapeFault` maps to 400.
  const tags = url.searchParams.getAll('tag');
  if (tags.length > 0) {
    filter.tags = tags;
  }

  const limit = url.searchParams.get('limit');
  if (limit !== null) {
    const parsed = Number(limit);
    if (Number.isFinite(parsed) && parsed >= 1) {
      filter.limit = Math.min(Math.floor(parsed), 1000);
    }
  }

  const offset = url.searchParams.get('offset');
  if (offset !== null) {
    const parsed = Number(offset);
    if (Number.isFinite(parsed) && parsed >= 0) {
      filter.offset = Math.floor(parsed);
    }
  }

  const attributeFilters = parseAttributeFilters(url.searchParams);
  if (attributeFilters.length > 0) {
    filter.attributes = attributeFilters.map((attribute) => ({
      key: attribute.key,
      ...(attribute.value === undefined ? {} : { value: attribute.value }),
      ...(attribute.gt === undefined ? {} : { gt: attribute.gt }),
      ...(attribute.lt === undefined ? {} : { lt: attribute.lt }),
      ...(attribute.gte === undefined ? {} : { gte: attribute.gte }),
      ...(attribute.lte === undefined ? {} : { lte: attribute.lte }),
    }));
  }

  const idPrefix = url.searchParams.get('id_prefix');
  if (idPrefix !== null) {
    filter.idPrefix = idPrefix;
  }

  const tenantIds = url.searchParams.getAll('tenant_id');
  if (tenantIds.length === 1) {
    filter.tenantId = tenantIds[0]!;
  } else if (tenantIds.length > 1) {
    filter.tenantId = tenantIds;
  }

  const failureCategories = url.searchParams.getAll('failure_category') as FailureCategory[];
  if (failureCategories.length === 1) {
    filter.failureCategory = failureCategories[0]!;
  } else if (failureCategories.length > 1) {
    filter.failureCategory = failureCategories;
  }

  const createdAt = extractTimeRange(url.searchParams, 'created_at');
  if (createdAt !== undefined) filter.createdAt = createdAt;
  const updatedAt = extractTimeRange(url.searchParams, 'updated_at');
  if (updatedAt !== undefined) filter.updatedAt = updatedAt;
  const executionDeadline = extractTimeRange(url.searchParams, 'execution_deadline');
  if (executionDeadline !== undefined) filter.executionDeadline = executionDeadline;

  const include = url.searchParams.getAll('include');
  if (include.includes('failureCategory')) {
    filter.include = ['failureCategory'];
  }

  return filter;
}

/**
 * Parse one of the three `*_at` time-range filters from the query
 * string. The four bounds map to `{prefix}_gte`, `{prefix}_gt`,
 * `{prefix}_lte`, `{prefix}_lt`. Returns `undefined` when none of the
 * bounds were specified so the omitted-vs-empty distinction is preserved
 * for the downstream `normalizeListFilter` validation.
 */
function extractTimeRange(
  params: URLSearchParams,
  prefix: 'created_at' | 'updated_at' | 'execution_deadline',
): TimeRange | undefined {
  const range: TimeRange = {};
  const gte = params.get(`${prefix}_gte`);
  if (gte !== null && Number.isFinite(Number(gte))) range.gte = Number(gte);
  const gt = params.get(`${prefix}_gt`);
  if (gt !== null && Number.isFinite(Number(gt))) range.gt = Number(gt);
  const lte = params.get(`${prefix}_lte`);
  if (lte !== null && Number.isFinite(Number(lte))) range.lte = Number(lte);
  const lt = params.get(`${prefix}_lt`);
  if (lt !== null && Number.isFinite(Number(lt))) range.lt = Number(lt);
  return Object.keys(range).length > 0 ? range : undefined;
}

function shapeListWorkflowsSuccess(result: ListWorkflowsOutput): Response {
  return new Response(JSON.stringify(result), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function shapeListWorkflowsFault(fault: OperationFault): Response {
  // Legacy workflow listing reports invalid filter values as 400 even when
  // the transport-neutral fault is `Unprocessable`.
  if (fault.code === 'Unprocessable') {
    return jsonErrorResponse(fault.message, 400);
  }
  return shapeRestFault(fault);
}

export const listWorkflowsRestBinding: UnknownRestBinding = {
  method: 'GET',
  path: '/v1/workflows',
  pathParamNames: [],
  operationName: 'weft.workflows.list',
  inputSources: {
    status: { kind: 'query', queryParam: 'status', repeating: true },
    type: { kind: 'query', queryParam: 'type' },
    tags: { kind: 'query', queryParam: 'tag', repeating: true },
    limit: { kind: 'query', queryParam: 'limit' },
    offset: { kind: 'query', queryParam: 'offset' },
  },
  extractInput: async (request) => extractListWorkflowsInput(request),
  success: { kind: 'json', status: 200 },
  shapeSuccess: (output: ListWorkflowsOutput) => shapeListWorkflowsSuccess(output),
  shapeFault: shapeListWorkflowsFault,
};
