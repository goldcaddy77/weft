import { FAULT_CODE_TO_HTTP_STATUS, type OperationFault } from '../operation-fault.ts';

export function mapScheduleErrorToFault(scheduleId: string, error: unknown): OperationFault {
  const message = error instanceof Error ? error.message : String(error);
  const normalizedMessage = message.toLowerCase();

  if (normalizedMessage.includes('not found')) {
    return {
      code: 'NotFound',
      message,
      data: { resource: 'schedule', identifier: scheduleId },
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
    normalizedMessage.includes('already exists') ||
    normalizedMessage.includes('cannot be resumed')
  ) {
    return {
      code: 'Conflict',
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

export function shapeScheduleFault(fault: OperationFault): Response {
  return new Response(JSON.stringify({ error: fault.message }), {
    status: fault.code === 'InvalidParams' ? 400 : FAULT_CODE_TO_HTTP_STATUS[fault.code],
    headers: { 'Content-Type': 'application/json' },
  });
}
