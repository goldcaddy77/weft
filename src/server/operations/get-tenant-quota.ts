/**
 * `weft.tenants.quota.get` operation + REST binding.
 *
 * Returns quota usage for a tenant. When the caller presents a JWT, access
 * is scoped to the tenant whose id matches the JWT's tenant claim — this
 * mirrors the legacy `handleGetTenantQuota` behavior exactly.
 *
 * @module server/operations/get-tenant-quota
 */

import { z } from 'zod';

import type { Engine } from '../../core/engine.ts';
import type { TenantQuotaUsage } from '../../core/types.ts';
import { FAULT_CODE_TO_HTTP_STATUS, type OperationFault } from '../operation-fault.ts';
import { defineOperation } from '../operation-registry.ts';
import type { UnknownRestBinding } from '../rest-bindings.ts';
import { invalidParamsFault } from './operation-helpers.ts';

const getTenantQuotaInput = z.object({
  tenantId: z.string().min(1),
});

const getTenantQuotaOutput = z.unknown();

export type GetTenantQuotaInput = z.infer<typeof getTenantQuotaInput>;
export type GetTenantQuotaOutput = TenantQuotaUsage;

export const getTenantQuotaOperation = defineOperation<GetTenantQuotaInput, GetTenantQuotaOutput>({
  name: 'weft.tenants.quota.get',
  mcpExposable: false,
  summary: 'Get quota usage for a tenant',
  tags: ['Budget'],
  inputSchema: getTenantQuotaInput,
  outputSchema: getTenantQuotaOutput as z.ZodType<GetTenantQuotaOutput>,
  access: {
    kind: 'scoped',
    scopes: { kind: 'anyOf', scopes: ['quota:read'] },
  },
  producibleFaults: ['Conflict'],
  discoverable: true,
  transports: { http: true, jsonRpcHttp: true, jsonRpcWebSocket: true, jsonRpcStdio: true },
  unknownKeyPolicy: { http: 'strip', jsonRpc: 'reject' },
  invoke: async ({ input, engine, principal }): Promise<GetTenantQuotaOutput> => {
    const e = engine as Engine;

    const normalizedTenantId = input.tenantId.trim();
    if (normalizedTenantId.length === 0) {
      throw invalidParamsFault('Tenant id must be a non-empty string');
    }

    if (principal.method === 'jwt') {
      if (principal.tenantId === undefined) {
        throw {
          code: 'Forbidden',
          message:
            'JWT-authenticated tenant quota requests require a tenantId, tenant_id, or tenant claim',
          data: {
            reason:
              'JWT-authenticated tenant quota requests require a tenantId, tenant_id, or tenant claim',
          },
        } satisfies OperationFault;
      }
      if (principal.tenantId !== normalizedTenantId) {
        throw {
          code: 'Forbidden',
          message: 'Tenant quota access is limited to the authenticated tenant',
          data: { reason: 'Tenant quota access is limited to the authenticated tenant' },
        } satisfies OperationFault;
      }
    }

    return e.getQuotaUsage(normalizedTenantId);
  },
});

function shapeGetTenantQuotaFault(fault: OperationFault): Response {
  if (fault.code === 'InvalidParams') {
    return new Response(JSON.stringify({ error: fault.message }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  if (fault.code === 'Unauthorized') {
    return new Response(JSON.stringify({ error: fault.message }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  if (fault.code === 'Forbidden') {
    return new Response(JSON.stringify({ error: fault.message }), {
      status: 403,
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

export const getTenantQuotaRestBinding: UnknownRestBinding = {
  method: 'GET',
  path: '/v1/tenants/:id/quota',
  pathParamNames: ['id'],
  operationName: 'weft.tenants.quota.get',
  inputSources: {
    tenantId: { kind: 'path', pathParam: 'id' },
  },
  extractInput: async (_request, pathParams) => ({
    tenantId: pathParams['id'] ?? '',
  }),
  success: { kind: 'json', status: 200 },
  shapeFault: shapeGetTenantQuotaFault,
};
