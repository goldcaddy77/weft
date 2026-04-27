import { z } from 'zod';

import type { Engine } from '../../core/engine.ts';
import { coerceStartWorkflowTags } from '../../core/start-workflow-validation.ts';
import type {
  ListFilter,
  PaginatedResult,
  SearchAttributeValue,
  WorkflowStatus,
  WorkflowSummary,
} from '../../core/types.ts';
import { parseAttributeFilters } from '../attribute-filters.ts';
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
        const message = error instanceof Error ? error.message : String(error);
        const fault: OperationFault = {
          code: 'Unprocessable',
          message,
          data: { reason: message },
        };
        throw fault;
      }
    }

    // `ListWorkflowsInput` is structurally identical to `ListFilter`
    // (see `core/types.ts`) — every field name and shape matches.
    // The cast is a Zod-inference / hand-written-interface bridge:
    // `z.infer` produces a structural type that TypeScript treats as
    // distinct from `ListFilter` even though every member aligns.
    // If `ListFilter` ever gains a field, the schema must add the
    // matching shape; the unit tests for this operation cover the
    // request-to-engine.list round-trip end-to-end so a real drift
    // would surface immediately.
    const filter: ListFilter = {
      ...(input as ListFilter),
      ...(validatedTags !== undefined ? { tags: validatedTags } : {}),
    };
    return await e.list(filter);
  },
});

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
