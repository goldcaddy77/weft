/**
 * `weft.schedules.list` operation + REST binding.
 *
 * Lists recurring schedules with optional filtering. REST response matches
 * the legacy `handleListSchedules` shape: 200 with the paginated result,
 * 400 for bad query params, or a JSON `{ error: <message> }` for other failures.
 *
 * @module server/operations/list-schedules
 */

import { z } from 'zod';

import type { Engine } from '../../core/engine.ts';
import type {
  PaginatedResult,
  ScheduleFilter,
  ScheduleStatus,
  ScheduleSummary,
} from '../../core/types.ts';
import type { OperationFault } from '../operation-fault.ts';
import { defineOperation } from '../operation-registry.ts';
import type { UnknownRestBinding } from '../rest-bindings.ts';
import { invalidParamsFault, shapeRestFault } from './operation-helpers.ts';
import { isOperationFault, resolveScheduleAccessOptions } from './schedule-faults.ts';

const VALID_SCHEDULE_STATUSES = new Set<string>(['active', 'paused', 'cancelled']);

function isValidScheduleStatus(value: string): value is ScheduleStatus {
  return VALID_SCHEDULE_STATUSES.has(value);
}

const listSchedulesInput = z.object({
  status: z.unknown().optional(),
  workflowType: z.unknown().optional(),
  tenantId: z.unknown().optional(),
  limit: z.unknown().optional(),
  offset: z.unknown().optional(),
  // JWT-authenticated tenant scope resolved by the authorize hook, not
  // passed directly by the caller. Stored on input so the hook can
  // inject it without touching the raw query string.
  _resolvedTenantId: z.string().optional(),
});

const listSchedulesOutput = z.unknown();

export type ListSchedulesInput = z.infer<typeof listSchedulesInput>;
export type ListSchedulesOutput = PaginatedResult<ScheduleSummary>;

export const listSchedulesOperation = defineOperation<ListSchedulesInput, ListSchedulesOutput>({
  name: 'weft.schedules.list',
  mcpExposable: false,
  summary: 'List recurring schedules',
  tags: ['Schedules'],
  inputSchema: listSchedulesInput,
  outputSchema: listSchedulesOutput as z.ZodType<ListSchedulesOutput>,
  access: { kind: 'scoped', scopes: { kind: 'anyOf', scopes: ['schedules:read'] } },
  producibleFaults: ['Conflict'],
  discoverable: true,
  transports: { http: true, jsonRpcHttp: true, jsonRpcWebSocket: true, jsonRpcStdio: true },
  unknownKeyPolicy: { http: 'strip', jsonRpc: 'reject' },
  // oxlint-disable-next-line eslint(complexity) -- ID:server-operations-list-schedules-validation-complexity -- preserves the legacy query-validation order at one transport-neutral invoke boundary.
  invoke: async ({ input, engine, principal }): Promise<ListSchedulesOutput> => {
    const e = engine as Engine;

    // Build the ScheduleFilter from the validated input. Field-level
    // validation mirrors the legacy `parseScheduleListFilter` exactly.
    const filter: ScheduleFilter = {};
    const accessOptions = resolveScheduleAccessOptions(principal);
    if (isOperationFault(accessOptions)) {
      throw accessOptions;
    }
    const resolvedTenantId = accessOptions?.tenantId;

    if (input.status !== undefined) {
      const statuses = Array.isArray(input.status) ? input.status : [input.status];

      const normalized: ScheduleStatus[] = [];
      for (const s of statuses) {
        if (typeof s !== 'string' || !isValidScheduleStatus(s)) {
          throw invalidParamsFault(
            'Query parameter "status" must be one of active, paused, cancelled',
          );
        }
        normalized.push(s);
      }

      if (normalized.length === 1 && normalized[0] !== undefined) {
        filter.status = normalized[0];
      } else if (normalized.length > 1) {
        filter.status = normalized;
      }
    }

    if (input.workflowType !== undefined) {
      if (typeof input.workflowType !== 'string') {
        throw invalidParamsFault('Query parameter "workflowType" must be a string');
      }
      filter.workflowType = input.workflowType;
    }

    if (input.tenantId !== undefined) {
      if (typeof input.tenantId !== 'string') {
        throw invalidParamsFault('Query parameter "tenantId" must be a string');
      }
      filter.tenantId = input.tenantId;
    }

    if (
      input._resolvedTenantId !== undefined &&
      resolvedTenantId !== undefined &&
      input._resolvedTenantId !== resolvedTenantId
    ) {
      const fault: OperationFault = {
        code: 'Forbidden',
        message: 'Schedule access is limited to the authenticated tenant',
        data: { reason: 'tenantId mismatch with JWT claim' },
      };
      throw fault;
    }

    if (resolvedTenantId !== undefined) {
      // If the caller also passed tenantId and it disagrees, that is a
      // scope-mismatch — the tenant scope wins.
      if (filter.tenantId !== undefined && filter.tenantId !== resolvedTenantId) {
        const fault: OperationFault = {
          code: 'Forbidden',
          message: 'Schedule access is limited to the authenticated tenant',
          data: { reason: 'tenantId mismatch with JWT claim' },
        };
        throw fault;
      }
      filter.tenantId = resolvedTenantId;
    }

    if (input.limit !== undefined) {
      const parsed = Number(input.limit);
      if (!Number.isInteger(parsed) || parsed < 1) {
        throw invalidParamsFault('Query parameter "limit" must be a positive integer');
      }
      filter.limit = Math.min(parsed, 1000);
    }

    if (input.offset !== undefined) {
      const parsed = Number(input.offset);
      if (!Number.isInteger(parsed) || parsed < 0) {
        throw invalidParamsFault('Query parameter "offset" must be a non-negative integer');
      }
      filter.offset = parsed;
    }

    return e.listSchedules(filter);
  },
});

function shapeListSchedulesFault(fault: OperationFault): Response {
  return shapeRestFault(fault);
}

export const listSchedulesRestBinding: UnknownRestBinding = {
  method: 'GET',
  path: '/v1/schedules',
  pathParamNames: [],
  operationName: 'weft.schedules.list',
  inputSources: {
    status: { kind: 'query', queryParam: 'status' },
    workflowType: { kind: 'query', queryParam: 'workflowType' },
    tenantId: { kind: 'query', queryParam: 'tenantId' },
    limit: { kind: 'query', queryParam: 'limit' },
    offset: { kind: 'query', queryParam: 'offset' },
  },
  extractInput: async (request) => {
    const url = new URL(request.url);
    const statusValues = url.searchParams.getAll('status');
    const result: ListSchedulesInput = {};

    if (statusValues.length === 1) {
      result.status = statusValues[0];
    } else if (statusValues.length > 1) {
      result.status = statusValues;
    }

    const workflowType = url.searchParams.get('workflowType');
    if (workflowType !== null) result.workflowType = workflowType;

    const tenantId = url.searchParams.get('tenantId');
    if (tenantId !== null) result.tenantId = tenantId;

    const limit = url.searchParams.get('limit');
    if (limit !== null) result.limit = limit;

    const offset = url.searchParams.get('offset');
    if (offset !== null) result.offset = offset;

    return result;
  },
  success: { kind: 'json', status: 200 },
  shapeFault: shapeListSchedulesFault,
};
