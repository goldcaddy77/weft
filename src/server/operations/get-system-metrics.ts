/**
 * `weft.system.metrics` operation + REST binding.
 *
 * Returns JSON-shaped metrics. This is distinct from the Prometheus text
 * exposition at `GET /v1/metrics` (which remains a direct handler and is
 * REST-only). This operation exposes the same underlying data as a
 * structured JSON object for consumers that need machine-readable metrics
 * rather than Prometheus text format.
 *
 * Access is scoped to `system:read` — the same privilege class as any
 * internal-observability endpoint.
 *
 * The metrics snapshot is resolved by the REST binding's `extractInput`
 * before the catalog pipeline runs, then returned verbatim from `invoke`.
 * This keeps the catalog's `engine: unknown` contract clean: the operation
 * never needs to reach outside its declared inputs.
 *
 * @module server/operations/get-system-metrics
 */

import { z } from 'zod';

import type { MetricsSnapshot } from '../../observability/metrics.ts';
import { FAULT_CODE_TO_HTTP_STATUS, type OperationFault } from '../operation-fault.ts';
import { defineOperation } from '../operation-registry.ts';
import type { UnknownRestBinding } from '../rest-bindings.ts';

// The snapshot is carried inside the input object. It is typed `unknown`
// at the schema level so the catalog's `z.ZodObject` registry constraint
// is satisfied; the `invoke` function trusts the REST binding's
// `extractInput` (or an equivalent JSON-RPC adapter) to supply a valid
// `MetricsSnapshot`. In tests this can be any plain object.
const getSystemMetricsInput = z.object({
  snapshot: z.unknown(),
});

const getSystemMetricsOutput = z.unknown();

export type GetSystemMetricsInput = z.infer<typeof getSystemMetricsInput>;
export type GetSystemMetricsOutput = MetricsSnapshot;

export const getSystemMetricsOperation = defineOperation<
  GetSystemMetricsInput,
  GetSystemMetricsOutput
>({
  name: 'weft.system.metrics',
  summary: 'Get JSON-shaped system metrics',
  tags: ['Observability'],
  inputSchema: getSystemMetricsInput,
  outputSchema: getSystemMetricsOutput as z.ZodType<GetSystemMetricsOutput>,
  access: {
    kind: 'scoped',
    scopes: { kind: 'anyOf', scopes: ['system:read'] },
  },
  transports: { http: true, jsonRpcHttp: true, jsonRpcWebSocket: true, jsonRpcStdio: true },
  unknownKeyPolicy: { http: 'strip', jsonRpc: 'reject' },
  invoke: async ({ input }): Promise<GetSystemMetricsOutput> => {
    // The snapshot is pre-resolved by the caller (REST binding or JSON-RPC
    // adapter). `invoke` treats it as opaque — no second-guessing whether
    // the snapshot came from a `MetricsCollector` or a custom exporter.
    return (input.snapshot ?? {}) as GetSystemMetricsOutput;
  },
});

function shapeGetSystemMetricsFault(fault: OperationFault): Response {
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

/**
 * Factory for the `weft.system.metrics` REST binding. Accepts the metrics
 * sources at binding construction time so each `serve()` call gets its own
 * isolated binding — no module-level singletons means test isolation is
 * maintained.
 *
 * The REST binding captures the exporter/collector in the `extractInput`
 * closure and resolves the snapshot there, before the catalog pipeline
 * starts.
 */
export function createGetSystemMetricsRestBinding(options: {
  metricsCollector?: { snapshot(): MetricsSnapshot };
}): UnknownRestBinding {
  return {
    method: 'GET',
    path: '/v1/metrics/json',
    pathParamNames: [],
    operationName: 'weft.system.metrics',
    inputSources: {},
    extractInput: async () => {
      const snapshot: MetricsSnapshot = options.metricsCollector?.snapshot() ?? {};
      return { snapshot };
    },
    success: { kind: 'json', status: 200 },
    shapeSuccess: (output: GetSystemMetricsOutput) =>
      new Response(JSON.stringify(output), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    shapeFault: shapeGetSystemMetricsFault,
  };
}
