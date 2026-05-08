/**
 * `weft.system.registry` operation + REST binding.
 *
 * Returns a JSON snapshot of every locally-registered workflow and activity,
 * with their JSON Schemas. Powers the `weft codegen` CLI: a downstream
 * project fetches this document, validates it, and emits a `.d.ts` that
 * augments `WorkflowRegistry` and `ActivityTypes`.
 *
 * Access is scoped to `system:read` — schemas can leak internal data shapes
 * so the endpoint sits behind the same scope as the JSON metrics endpoint.
 *
 * The actual snapshot assembly lives in {@link buildRegistrySnapshot} so the
 * MCP server (Section 2 of the roadmap) can reuse the builder without going
 * through HTTP.
 *
 * @module server/operations/get-registry
 */

import { z } from 'zod';

import type { Engine } from '../../core/engine.ts';
import { buildRegistrySnapshot, type RegistrySnapshot } from '../../core/registry-snapshot.ts';
import { FAULT_CODE_TO_HTTP_STATUS, type OperationFault } from '../operation-fault.ts';
import { defineOperation } from '../operation-registry.ts';
import type { UnknownRestBinding } from '../rest-bindings.ts';

const getRegistryInput = z.object({});
const getRegistryOutput = z.unknown();

export type GetRegistryInput = z.infer<typeof getRegistryInput>;
export type GetRegistryOutput = RegistrySnapshot;

export const getRegistryOperation = defineOperation<GetRegistryInput, GetRegistryOutput>({
  name: 'weft.system.registry',
  mcpExposable: false,
  summary: 'Get a snapshot of registered workflows and activities with their JSON Schemas',
  tags: ['System'],
  inputSchema: getRegistryInput,
  outputSchema: getRegistryOutput as z.ZodType<GetRegistryOutput>,
  access: {
    kind: 'scoped',
    scopes: { kind: 'anyOf', scopes: ['system:read'] },
  },
  discoverable: true,
  transports: { http: true, jsonRpcHttp: true, jsonRpcWebSocket: true, jsonRpcStdio: true },
  unknownKeyPolicy: { http: 'strip', jsonRpc: 'reject' },
  invoke: async ({ engine }): Promise<GetRegistryOutput> => {
    const e = engine as Engine;
    return buildRegistrySnapshot(e);
  },
});

function shapeGetRegistryFault(fault: OperationFault): Response {
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

export const getRegistryRestBinding: UnknownRestBinding = {
  method: 'GET',
  path: '/v1/registry',
  pathParamNames: [],
  operationName: 'weft.system.registry',
  inputSources: {},
  extractInput: async () => ({}),
  success: { kind: 'json', status: 200 },
  shapeSuccess: (output: GetRegistryOutput) =>
    new Response(JSON.stringify(output), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }),
  shapeFault: shapeGetRegistryFault,
};
