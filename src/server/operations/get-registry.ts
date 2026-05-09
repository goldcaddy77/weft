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

// JSON Schema fragments are arbitrary JSON objects (we don't validate the
// schemas themselves — that's a different layer's job), but we DO validate
// the surrounding registry envelope so callers and codegen can rely on it.
const jsonSchemaFragment = z.record(z.string(), z.unknown());

const registryWorkflowEntry = z
  .object({
    inputSchema: jsonSchemaFragment.optional(),
    outputSchema: jsonSchemaFragment.optional(),
    description: z.string().optional(),
    tags: z.array(z.string()).optional(),
  })
  .strict();

const registryActivityEntry = z
  .object({
    inputSchema: jsonSchemaFragment.optional(),
    outputSchema: jsonSchemaFragment.optional(),
    queue: z.string(),
    description: z.string().optional(),
  })
  .strict();

const getRegistryOutput = z
  .object({
    registryVersion: z.literal(1),
    workflows: z.record(z.string(), registryWorkflowEntry),
    activities: z.record(z.string(), registryActivityEntry),
  })
  .strict();

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
    return buildRegistrySnapshot(engine as Engine);
  },
});

function shapeGetRegistryFault(fault: OperationFault): Response {
  if (fault.code === 'EngineFailure') {
    // Mask internal error details from the wire. The typed
    // `RegistrySchemaConversionError` thrown by the builder includes the
    // offending entity name and direction in `error.message`, which is
    // logged server-side (the operation pipeline writes `error.message` to
    // the engine's failure log) so operators can locate the bad
    // registration without leaking schema layout to clients.
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
