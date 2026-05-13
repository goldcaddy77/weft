import { z } from 'zod';

import { assertScopedBulkWorkflowFilter } from '../../core/bulk-workflow-filter.ts';
import { coerceStartWorkflowTags } from '../../core/start-workflow-validation.ts';
import type {
  AttributeFilter,
  ListFilter,
  SearchAttributeValue,
  WorkflowStatus,
} from '../../core/types.ts';
import type { OperationFault } from '../operation-fault.ts';
import { invalidParamsFault } from './operation-helpers.ts';

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

export const bulkListFilterInputSchema = z.object({
  status: z.union([workflowStatusSchema, z.array(workflowStatusSchema)]).optional(),
  type: z.string().optional(),
  tags: z.array(z.string()).optional(),
  attributes: z.array(attributeFilterSchema).optional(),
  limit: z.number().int().min(0).optional(),
  offset: z.number().int().min(0).optional(),
});

export type BulkListFilterInput = z.infer<typeof bulkListFilterInputSchema>;

export function faultMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function unprocessableFault(message: string): OperationFault {
  return {
    code: 'Unprocessable',
    message,
    data: { reason: message },
  };
}

export function engineFailureFault(message: string): OperationFault {
  return {
    code: 'EngineFailure',
    message,
    data: {},
  };
}

export async function readOptionalJsonBody(request: Request): Promise<unknown> {
  try {
    const text = await request.text();
    return text.trim() === '' ? undefined : (JSON.parse(text) as unknown);
  } catch {
    throw invalidParamsFault('Invalid JSON body');
  }
}

function isJsonSearchAttributeValue(value: unknown): value is SearchAttributeValue {
  if (typeof value === 'string' || typeof value === 'boolean') {
    return true;
  }

  if (typeof value === 'number') {
    return Number.isFinite(value);
  }

  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function parseAttributeFiltersFromBody(value: unknown): AttributeFilter[] {
  if (!Array.isArray(value)) {
    throw new Error('Field "filter.attributes" must be an array');
  }

  return value.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null) {
      throw new Error(`Field "filter.attributes[${index}]" must be an object`);
    }

    const record = entry as Record<string, unknown>;
    const key = record['key'];
    if (typeof key !== 'string' || key.length === 0) {
      throw new Error(`Field "filter.attributes[${index}].key" must be a non-empty string`);
    }

    const filter: AttributeFilter = { key };
    for (const property of ['value', 'gt', 'lt', 'gte', 'lte'] as const) {
      const attributeValue = record[property];
      if (attributeValue === undefined) {
        continue;
      }

      if (!isJsonSearchAttributeValue(attributeValue)) {
        throw new Error(
          `Field "filter.attributes[${index}].${property}" must be a string, number, boolean, or string array`,
        );
      }

      filter[property] = attributeValue;
    }

    return filter;
  });
}

function parseFilterStatus(value: unknown): ListFilter['status'] {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value === 'string') {
    return value as WorkflowStatus;
  }

  if (Array.isArray(value) && value.every((entry) => typeof entry === 'string')) {
    return value as WorkflowStatus[];
  }

  throw new Error('Field "filter.status" must be a string or an array of strings');
}

function parseOptionalFilterType(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value === 'string') {
    return value;
  }

  throw new Error('Field "filter.type" must be a string');
}

function parseOptionalFilterTags(value: unknown): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }

  return coerceStartWorkflowTags(value, 'Field "filter.tags"');
}

function parseOptionalFilterNumber(
  value: unknown,
  fieldName: 'limit' | 'offset',
): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`Field "filter.${fieldName}" must be a non-negative number`);
  }

  return Math.floor(value);
}

// oxlint-disable-next-line complexity -- ID:server-operations-bulk-filter-helpers-parse-bulk-list-filter-from-body-complexity
export function parseBulkListFilterFromBody(body: unknown): ListFilter {
  if (body === undefined) {
    return {};
  }

  if (typeof body !== 'object' || body === null) {
    throw new Error('Request body must be a JSON object');
  }

  const record = body as Record<string, unknown>;
  const rawFilter = record['filter'];
  if (rawFilter === undefined) {
    return {};
  }

  if (typeof rawFilter !== 'object' || rawFilter === null) {
    throw new Error('Field "filter" must be an object');
  }

  const filterRecord = rawFilter as Record<string, unknown>;
  const filter: ListFilter = {};
  const status = parseFilterStatus(filterRecord['status']);
  if (status !== undefined) {
    filter.status = status;
  }

  const type = parseOptionalFilterType(filterRecord['type']);
  if (type !== undefined) {
    filter.type = type;
  }

  const tags = parseOptionalFilterTags(filterRecord['tags']);
  if (tags !== undefined) {
    filter.tags = tags;
  }

  if (filterRecord['attributes'] !== undefined) {
    filter.attributes = parseAttributeFiltersFromBody(filterRecord['attributes']);
  }

  const limit = parseOptionalFilterNumber(filterRecord['limit'], 'limit');
  if (limit !== undefined) {
    filter.limit = limit;
  }

  const offset = parseOptionalFilterNumber(filterRecord['offset'], 'offset');
  if (offset !== undefined) {
    filter.offset = offset;
  }

  return filter;
}

export function parseRequiredBulkListFilter(body: unknown): ListFilter {
  try {
    return assertScopedBulkWorkflowFilter(parseBulkListFilterFromBody(body));
  } catch (error) {
    throw invalidParamsFault(faultMessage(error));
  }
}

export function listFilterFromBulkInput(input: BulkListFilterInput): ListFilter {
  const filter: ListFilter = {};
  if (input.status !== undefined) {
    filter.status = input.status;
  }
  if (input.type !== undefined) {
    filter.type = input.type;
  }
  if (input.tags !== undefined) {
    filter.tags = input.tags;
  }
  if (input.attributes !== undefined) {
    filter.attributes = input.attributes.map((attribute) => ({
      key: attribute.key,
      ...(attribute.value === undefined ? {} : { value: attribute.value }),
      ...(attribute.gt === undefined ? {} : { gt: attribute.gt }),
      ...(attribute.lt === undefined ? {} : { lt: attribute.lt }),
      ...(attribute.gte === undefined ? {} : { gte: attribute.gte }),
      ...(attribute.lte === undefined ? {} : { lte: attribute.lte }),
    }));
  }
  if (input.limit !== undefined) {
    filter.limit = input.limit;
  }
  if (input.offset !== undefined) {
    filter.offset = input.offset;
  }
  return filter;
}
