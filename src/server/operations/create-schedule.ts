import { z } from 'zod';

import type { Engine } from '../../core/engine.ts';
import type { ScheduleAccessOptions, ScheduleOptions } from '../../core/types.ts';
import { FAULT_CODE_TO_HTTP_STATUS, type OperationFault } from '../operation-fault.ts';
import { defineOperation } from '../operation-registry.ts';
import type { Principal } from '../principal.ts';
import type { UnknownRestBinding } from '../rest-bindings.ts';

const VALID_SCHEDULE_OVERLAP_POLICIES = new Set<NonNullable<ScheduleOptions['overlap']>>([
  'skip',
  'queue',
  'cancel-running',
  'allow',
]);

const MISSING_SCHEDULE_TENANT_CLAIM_MESSAGE =
  'JWT-authenticated schedule requests require a tenantId, tenant_id, or tenant claim';

const createScheduleInput = z.object({
  type: z.string().min(1),
  cronExpression: z.string().min(1),
  input: z.unknown().optional(),
  id: z.string().optional(),
  overlap: z.string().optional(),
  backfill: z.boolean().optional(),
  authenticatedTenantId: z.string().optional(),
});

const createScheduleOutput = z.object({
  id: z.string(),
});

export type CreateScheduleInput = z.infer<typeof createScheduleInput>;
export type CreateScheduleOutput = z.infer<typeof createScheduleOutput>;

export const createScheduleOperation = defineOperation<CreateScheduleInput, CreateScheduleOutput>({
  name: 'weft.schedules.create',
  summary: 'Create a recurring schedule',
  tags: ['Schedules'],
  inputSchema: createScheduleInput,
  outputSchema: createScheduleOutput,
  access: { kind: 'public' },
  transports: { http: true, jsonRpcHttp: true, jsonRpcWebSocket: true, jsonRpcStdio: true },
  unknownKeyPolicy: { http: 'strip', jsonRpc: 'reject' },
  invoke: async ({ input, engine, principal }): Promise<CreateScheduleOutput> => {
    const typedEngine = engine as Engine;

    const overlap = input.overlap;

    if (input.id !== undefined && input.id.length === 0) {
      throw invalidParamsFault('Field "id" must be a non-empty string');
    }
    if (overlap !== undefined && !isScheduleOverlapPolicy(overlap)) {
      throw invalidParamsFault('Field "overlap" must be one of skip, queue, cancel-running, allow');
    }

    const accessOptions = getScheduleAccessOptions(principal);
    if (isOperationFault(accessOptions)) {
      throw accessOptions;
    }

    const options: ScheduleOptions = {
      ...(input.id !== undefined ? { id: input.id } : {}),
      ...(overlap !== undefined ? { overlap } : {}),
      ...(input.backfill !== undefined ? { backfill: input.backfill } : {}),
    };

    try {
      const handle = await typedEngine.schedule(
        input.type,
        input.input,
        input.cronExpression,
        options,
        accessOptions,
      );
      return { id: handle.id };
    } catch (error) {
      throw classifyScheduleError(error);
    }
  },
});

function isScheduleOverlapPolicy(value: string): value is NonNullable<ScheduleOptions['overlap']> {
  return VALID_SCHEDULE_OVERLAP_POLICIES.has(value as NonNullable<ScheduleOptions['overlap']>);
}

function getScheduleAccessOptions(
  principal: Principal,
): OperationFault | ScheduleAccessOptions | undefined {
  if (principal.method !== 'jwt') {
    return undefined;
  }
  if (principal.tenantId === undefined) {
    return {
      code: 'Forbidden',
      message: MISSING_SCHEDULE_TENANT_CLAIM_MESSAGE,
      data: { reason: MISSING_SCHEDULE_TENANT_CLAIM_MESSAGE },
    };
  }
  return { tenantId: principal.tenantId };
}

function classifyScheduleError(error: unknown): OperationFault {
  const message = error instanceof Error ? error.message : String(error);
  const normalizedMessage = message.toLowerCase();

  if (normalizedMessage.includes('not found')) {
    return {
      code: 'NotFound',
      message,
      data: { resource: 'schedule' },
    };
  }
  if (normalizedMessage.includes('already exists')) {
    return {
      code: 'Conflict',
      message,
      data: { reason: message },
    };
  }
  if (normalizedMessage.includes('authenticated tenant')) {
    return {
      code: 'Forbidden',
      message,
      data: { reason: message },
    };
  }
  if (
    message.includes('Missing required field') ||
    normalizedMessage.includes('must be') ||
    normalizedMessage.includes('no workflow registered') ||
    normalizedMessage.includes('cron')
  ) {
    return invalidParamsFault(message);
  }

  return {
    code: 'EngineFailure',
    message,
    data: {},
  };
}

function invalidParamsFault(message: string): OperationFault {
  return {
    code: 'InvalidParams',
    message,
    data: { issues: [] },
  };
}

function isOperationFault(value: unknown): value is OperationFault {
  return (
    typeof value === 'object' &&
    value !== null &&
    'code' in value &&
    'message' in value &&
    'data' in value
  );
}

function shapeCreateScheduleFault(fault: OperationFault): Response {
  if (fault.code === 'NotFound') {
    return jsonErrorResponse(fault.message, 404);
  }
  if (fault.code === 'Conflict') {
    return jsonErrorResponse(fault.message, 409);
  }
  if (fault.code === 'Forbidden') {
    return jsonErrorResponse(fault.message, 403);
  }
  if (fault.code === 'InvalidParams') {
    return jsonErrorResponse(fault.message, 400);
  }
  if (fault.code === 'EngineFailure') {
    return jsonErrorResponse(fault.message, 500);
  }

  return jsonErrorResponse(fault.message, FAULT_CODE_TO_HTTP_STATUS[fault.code]);
}

function jsonErrorResponse(message: string, status: number): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export const createScheduleRestBinding: UnknownRestBinding = {
  method: 'POST',
  path: '/v1/schedules',
  pathParamNames: [],
  operationName: 'weft.schedules.create',
  inputSources: {
    type: { kind: 'body-field', bodyField: 'type' },
    cronExpression: { kind: 'body-field', bodyField: 'cronExpression' },
    input: { kind: 'body-field', bodyField: 'input' },
    id: { kind: 'body-field', bodyField: 'id' },
    overlap: { kind: 'body-field', bodyField: 'overlap' },
    backfill: { kind: 'body-field', bodyField: 'backfill' },
  },
  extractInput: async (request) => {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      throw invalidParamsFault('Invalid JSON body');
    }

    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      throw invalidParamsFault('Request body must be a JSON object');
    }

    const record = body as Record<string, unknown>;
    const type = record['type'];
    if (typeof type !== 'string' || type.length === 0) {
      throw invalidParamsFault('Missing required field: type');
    }

    const cronExpression = record['cronExpression'];
    if (typeof cronExpression !== 'string' || cronExpression.length === 0) {
      throw invalidParamsFault('Missing required field: cronExpression');
    }

    const backfill = record['backfill'];
    if (backfill !== undefined && typeof backfill !== 'boolean') {
      throw invalidParamsFault('Field "backfill" must be a boolean');
    }

    return {
      type,
      cronExpression,
      input: record['input'],
      id: record['id'],
      overlap: record['overlap'],
      backfill,
    };
  },
  success: { kind: 'json', status: 201 },
  shapeFault: shapeCreateScheduleFault,
};
