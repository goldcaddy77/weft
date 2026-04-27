import { z } from 'zod';

import type { Engine } from '../../core/engine.ts';
import type { ScheduleAccessOptions } from '../../core/types.ts';
import { FAULT_CODE_TO_HTTP_STATUS, type OperationFault } from '../operation-fault.ts';
import { defineOperation } from '../operation-registry.ts';
import type { Principal } from '../principal.ts';
import type { UnknownRestBinding } from '../rest-bindings.ts';

const MISSING_SCHEDULE_TENANT_CLAIM_MESSAGE =
  'JWT-authenticated schedule requests require a tenantId, tenant_id, or tenant claim';

const updateScheduleInput = z.object({
  scheduleId: z.string().min(1),
  cronExpression: z.string().min(1),
  authenticatedTenantId: z.string().optional(),
});

export type UpdateScheduleInput = z.infer<typeof updateScheduleInput>;

export const updateScheduleOperation = defineOperation<UpdateScheduleInput, null>({
  name: 'weft.schedules.update',
  summary: 'Update a recurring schedule',
  tags: ['Schedules'],
  inputSchema: updateScheduleInput,
  outputSchema: z.null(),
  access: { kind: 'public' },
  transports: { http: true, jsonRpcHttp: true, jsonRpcWebSocket: true, jsonRpcStdio: true },
  unknownKeyPolicy: { http: 'strip', jsonRpc: 'reject' },
  invoke: async ({ input, engine, principal }): Promise<null> => {
    const typedEngine = engine as Engine;
    const accessOptions = getScheduleAccessOptions(principal);
    if (isOperationFault(accessOptions)) {
      throw accessOptions;
    }

    try {
      await typedEngine.updateSchedule(input.scheduleId, input.cronExpression, accessOptions);
      return null;
    } catch (error) {
      throw classifyScheduleError(error);
    }
  },
});

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
    return {
      code: 'InvalidParams',
      message,
      data: { issues: [] },
    };
  }

  return {
    code: 'EngineFailure',
    message,
    data: {},
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

function shapeUpdateScheduleFault(fault: OperationFault): Response {
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

function invalidParamsFault(message: string): OperationFault {
  return {
    code: 'InvalidParams',
    message,
    data: { issues: [] },
  };
}

export const updateScheduleRestBinding: UnknownRestBinding = {
  method: 'PATCH',
  path: '/v1/schedules/:id',
  pathParamNames: ['id'],
  operationName: 'weft.schedules.update',
  inputSources: {
    scheduleId: { kind: 'path', pathParam: 'id' },
    cronExpression: { kind: 'body-field', bodyField: 'cronExpression' },
  },
  extractInput: async (request, pathParams) => {
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
    const cronExpression = record['cronExpression'];
    if (typeof cronExpression !== 'string' || cronExpression.length === 0) {
      throw invalidParamsFault('Missing required field: cronExpression');
    }

    return {
      scheduleId: pathParams['id'] ?? '',
      cronExpression,
    };
  },
  success: { kind: 'empty', status: 204 },
  shapeFault: shapeUpdateScheduleFault,
};
