import { describe, expect, it } from 'bun:test';

import type { z } from 'zod';
import {
  buildOpenRpcComponentsErrors,
  ConflictDataSchema,
  EngineFailureDataSchema,
  ForbiddenDataSchema,
  InvalidParamsDataSchema,
  MethodNotFoundDataSchema,
  NotFoundDataSchema,
  NotImplementedDataSchema,
  RateLimitedDataSchema,
  SubscriptionOverflowDataSchema,
  TimeoutDataSchema,
  UnauthorizedDataSchema,
  UnprocessableDataSchema,
  UnsupportedTransportDataSchema,
} from './openrpc-errors.ts';
import {
  FAULT_CODE_TO_HTTP_STATUS,
  FAULT_CODE_TO_JSON_RPC_CODE,
  type FaultCode,
  type OperationFault,
} from './operation-fault.ts';

type OperationFaultWithCode<Code extends FaultCode> = Extract<OperationFault, { code: Code }>;
type AssertExtends<Expected, Actual extends Expected> = [Actual] extends [Expected] ? true : never;

type _CheckUnauthorized = AssertExtends<
  OperationFaultWithCode<'Unauthorized'>['data'],
  z.infer<typeof UnauthorizedDataSchema>
>;
type _CheckForbidden = AssertExtends<
  OperationFaultWithCode<'Forbidden'>['data'],
  z.infer<typeof ForbiddenDataSchema>
>;
type _CheckNotFound = AssertExtends<
  OperationFaultWithCode<'NotFound'>['data'],
  z.infer<typeof NotFoundDataSchema>
>;
type _CheckConflict = AssertExtends<
  OperationFaultWithCode<'Conflict'>['data'],
  z.infer<typeof ConflictDataSchema>
>;
type _CheckUnprocessable = AssertExtends<
  OperationFaultWithCode<'Unprocessable'>['data'],
  z.infer<typeof UnprocessableDataSchema>
>;
type _CheckTimeout = AssertExtends<
  OperationFaultWithCode<'Timeout'>['data'],
  z.infer<typeof TimeoutDataSchema>
>;
type _CheckRateLimited = AssertExtends<
  OperationFaultWithCode<'RateLimited'>['data'],
  z.infer<typeof RateLimitedDataSchema>
>;
type _CheckNotImplemented = AssertExtends<
  OperationFaultWithCode<'NotImplemented'>['data'],
  z.infer<typeof NotImplementedDataSchema>
>;
type _CheckUnsupportedTransport = AssertExtends<
  OperationFaultWithCode<'UnsupportedTransport'>['data'],
  z.infer<typeof UnsupportedTransportDataSchema>
>;
type _CheckSubscriptionOverflow = AssertExtends<
  OperationFaultWithCode<'SubscriptionOverflow'>['data'],
  z.infer<typeof SubscriptionOverflowDataSchema>
>;
type _CheckInvalidParams = AssertExtends<
  OperationFaultWithCode<'InvalidParams'>['data'],
  z.infer<typeof InvalidParamsDataSchema>
>;
type _CheckMethodNotFound = AssertExtends<
  OperationFaultWithCode<'MethodNotFound'>['data'],
  z.infer<typeof MethodNotFoundDataSchema>
>;
type _CheckEngineFailure = AssertExtends<
  OperationFaultWithCode<'EngineFailure'>['data'],
  z.infer<typeof EngineFailureDataSchema>
>;

const typeSyncChecks = [
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
] satisfies [
  _CheckUnauthorized,
  _CheckForbidden,
  _CheckNotFound,
  _CheckConflict,
  _CheckUnprocessable,
  _CheckTimeout,
  _CheckRateLimited,
  _CheckNotImplemented,
  _CheckUnsupportedTransport,
  _CheckSubscriptionOverflow,
  _CheckInvalidParams,
  _CheckMethodNotFound,
  _CheckEngineFailure,
];

describe('OpenRPC components.errors', () => {
  it('keeps the compile-time fault data schema sync checks active', () => {
    expect(typeSyncChecks).toHaveLength(13);
  });

  it('emits exactly one error component per FaultCode with matching transport codes', () => {
    const errors = buildOpenRpcComponentsErrors();
    const faultCodes = Object.keys(FAULT_CODE_TO_JSON_RPC_CODE).toSorted();

    expect(Object.keys(errors).toSorted()).toEqual(faultCodes);
    for (const faultCode of faultCodes as FaultCode[]) {
      expect(errors[faultCode]).toMatchObject({
        code: FAULT_CODE_TO_JSON_RPC_CODE[faultCode],
        message: faultCode,
        'x-http-status': FAULT_CODE_TO_HTTP_STATUS[faultCode],
      });
    }
  });

  it('emits a non-null data JSON Schema for every error component', () => {
    const errors = buildOpenRpcComponentsErrors();

    for (const error of Object.values(errors)) {
      expect(error.data).toBeDefined();
      expect(error.data).not.toBeNull();
      expect(typeof error.data).toBe('object');
    }
  });
});
