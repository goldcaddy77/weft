import { z } from 'zod';

import type { Engine } from '../../core/engine.ts';
import { coerceStartWorkflowTags } from '../../core/start-workflow-validation.ts';
import type {
  AttributeFilter,
  ListFilter,
  PaginatedResult,
  SearchAttributeValue,
  WorkflowStatus,
  WorkflowSummary,
} from '../../core/types.ts';
import { FAULT_CODE_TO_HTTP_STATUS, type OperationFault } from '../operation-fault.ts';
import { defineOperation } from '../operation-registry.ts';
import type { UnknownRestBinding } from '../rest-bindings.ts';

const workflowStatusSchema = z.custom<WorkflowStatus>((value) => typeof value === 'string');
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

const listWorkflowsInput = z.object({
  status: z.union([workflowStatusSchema, z.array(workflowStatusSchema)]).optional(),
  type: z.string().optional(),
  tags: z.array(z.string()).optional(),
  attributes: z.array(attributeFilterSchema).optional(),
  limit: z.number().int().min(1).max(1000).optional(),
  offset: z.number().int().min(0).optional(),
});
const listWorkflowsOutput = z.unknown();

export type ListWorkflowsInput = z.infer<typeof listWorkflowsInput>;
export type ListWorkflowsOutput = PaginatedResult<WorkflowSummary>;

export const listWorkflowsOperation = defineOperation<ListWorkflowsInput, ListWorkflowsOutput>({
  name: 'weft.workflows.list',
  summary: 'List workflows',
  tags: ['Workflows'],
  inputSchema: listWorkflowsInput,
  outputSchema: listWorkflowsOutput as z.ZodType<ListWorkflowsOutput>,
  access: { kind: 'public' },
  transports: { http: true, jsonRpcHttp: true, jsonRpcWebSocket: true, jsonRpcStdio: true },
  unknownKeyPolicy: { http: 'strip', jsonRpc: 'reject' },
  invoke: async ({ input, engine }): Promise<ListWorkflowsOutput> => {
    const e = engine as Engine;
    return await e.list(input as ListFilter);
  },
});

function parseAttributeFilters(params: URLSearchParams): AttributeFilter[] {
  const filterMap = new Map<string, AttributeFilter>();

  for (const [key, value] of params) {
    if (!key.startsWith('attr.')) continue;

    const rest = key.slice(5);
    const dotIndex = rest.indexOf('.');

    if (dotIndex === -1) {
      const name = rest;
      const existing = filterMap.get(name) ?? { key: name };
      existing.value = inferAttributeValue(value);
      filterMap.set(name, existing);
    } else {
      const name = rest.slice(0, dotIndex);
      const operator = rest.slice(dotIndex + 1);
      const existing = filterMap.get(name) ?? { key: name };

      if (operator === 'gt') {
        existing.gt = inferAttributeValue(value);
        filterMap.set(name, existing);
      } else if (operator === 'lt') {
        existing.lt = inferAttributeValue(value);
        filterMap.set(name, existing);
      } else if (operator === 'gte') {
        existing.gte = inferAttributeValue(value);
        filterMap.set(name, existing);
      } else if (operator === 'lte') {
        existing.lte = inferAttributeValue(value);
        filterMap.set(name, existing);
      }
    }
  }

  return [...filterMap.values()];
}

function inferAttributeValue(raw: string): SearchAttributeValue {
  if (raw === 'true') return true;
  if (raw === 'false') return false;

  const asNumber = Number(raw);
  if (!Number.isNaN(asNumber) && raw.trim() !== '') return asNumber;

  return raw;
}

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

  const tags = url.searchParams.getAll('tag');
  if (tags.length > 0) {
    try {
      filter.tags = coerceStartWorkflowTags(tags, 'Query parameter "tag"');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const fault: OperationFault = {
        code: 'Unprocessable',
        message,
        data: { reason: message },
      };
      throw fault;
    }
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
    filter.attributes = attributeFilters;
  }

  return filter;
}

function shapeListWorkflowsSuccess(result: ListWorkflowsOutput): Response {
  return new Response(JSON.stringify(result), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function shapeListWorkflowsFault(fault: OperationFault): Response {
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
