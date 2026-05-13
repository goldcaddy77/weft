import { z } from 'zod';

import type { Engine } from '../../core/engine.ts';
import { defineOperation } from '../operation-registry.ts';
import type { UnknownRestBinding } from '../rest-bindings.ts';
import {
  isOperationFault,
  mapScheduleErrorToFault,
  resolveScheduleAccessOptions,
  shapeScheduleFault,
} from './schedule-faults.ts';

const resumeScheduleInput = z.object({
  scheduleId: z.string().min(1),
});
const resumeScheduleOutput = z.undefined();

export type ResumeScheduleInput = z.infer<typeof resumeScheduleInput>;
export type ResumeScheduleOutput = z.infer<typeof resumeScheduleOutput>;

export const resumeScheduleOperation = defineOperation<ResumeScheduleInput, ResumeScheduleOutput>({
  name: 'weft.schedules.resume',
  mcpExposable: false,
  summary: 'Resume a recurring schedule',
  tags: ['Schedules'],
  inputSchema: resumeScheduleInput,
  outputSchema: resumeScheduleOutput as z.ZodType<ResumeScheduleOutput>,
  access: { kind: 'scoped', scopes: { kind: 'anyOf', scopes: ['schedules:write'] } },
  discoverable: true,
  producibleFaults: ['NotFound', 'Conflict'],
  transports: { http: true, jsonRpcHttp: true, jsonRpcWebSocket: true, jsonRpcStdio: true },
  unknownKeyPolicy: { http: 'strip', jsonRpc: 'reject' },
  invoke: async ({ input, engine, principal }): Promise<ResumeScheduleOutput> => {
    const e = engine as Engine;
    const accessOptions = resolveScheduleAccessOptions(principal);
    if (isOperationFault(accessOptions)) {
      throw accessOptions;
    }

    try {
      await e.resumeSchedule(input.scheduleId, accessOptions);
      return undefined;
    } catch (error) {
      throw mapScheduleErrorToFault(input.scheduleId, error);
    }
  },
});

export const resumeScheduleRestBinding: UnknownRestBinding = {
  method: 'POST',
  path: '/v1/schedules/:id/resume',
  pathParamNames: ['id'],
  operationName: 'weft.schedules.resume',
  inputSources: {
    scheduleId: { kind: 'path', pathParam: 'id' },
  },
  extractInput: async (_request, pathParams) => ({
    scheduleId: pathParams['id'] ?? '',
  }),
  success: { kind: 'empty', status: 204 },
  shapeFault: shapeScheduleFault,
};
