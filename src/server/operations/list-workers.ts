/**
 * `weft.workers.list` operation + REST binding.
 *
 * Reports the connected-worker fleet for an operator-facing
 * "Workers & Queues" view: per-worker queue assignment, advertised
 * activities, concurrency, in-flight count, available capacity,
 * connected/heartbeat timestamps, and heartbeat age. Routing policy is
 * reported at the response top level so it does not drift per-worker.
 *
 * Access is `system:read` because the registry is server-wide
 * infrastructure, not tenant-scoped data — tenant principals see 403.
 *
 * The operation is constructed via a factory that closes over a
 * `WorkerRegistry` and an injectable `clock`. Tests use a deterministic
 * clock to prove the operation reads "now" exactly once per request and
 * derives every `heartbeatAgeMs` from it.
 *
 * Discovery-only callers (`asyncapi`, `openapi`) may build the operation
 * with no registry; the resulting `invoke` is a sentinel that throws if
 * reached. No live request path uses a discovery-only registry.
 *
 * @module server/operations/list-workers
 */

import { z } from 'zod';

import type { RoutingPolicy, WorkerRegistry, WorkerSummary } from '../../worker/registry.ts';
import { FAULT_CODE_TO_HTTP_STATUS, type OperationFault } from '../operation-fault.ts';
import { defineOperation } from '../operation-registry.ts';
import type { UnknownRestBinding } from '../rest-bindings.ts';

const listWorkersInput = z.object({});

const routingPolicySchema = z.enum([
  'least-loaded',
  'round-robin',
  'fair-share',
]) as z.ZodType<RoutingPolicy>;

const workerSummarySchema = z.object({
  id: z.string(),
  queue: z.string(),
  activities: z.array(z.string()),
  concurrency: z.number(),
  inFlight: z.number(),
  availableCapacity: z.number(),
  connectedAt: z.number(),
  lastHeartbeatAt: z.number(),
  heartbeatAgeMs: z.number(),
}) satisfies z.ZodType<WorkerSummary>;

const listWorkersOutput = z.object({
  items: z.array(workerSummarySchema),
  routingPolicy: routingPolicySchema,
});

export type ListWorkersInput = z.infer<typeof listWorkersInput>;
export interface ListWorkersOutput {
  items: WorkerSummary[];
  routingPolicy: RoutingPolicy;
}

interface ListWorkersOptions {
  workerRegistry?: WorkerRegistry;
  clock?: () => number;
}

/**
 * Build the `weft.workers.list` operation, optionally bound to a live
 * `WorkerRegistry` and clock.
 *
 * When `workerRegistry` is omitted, the operation is registered with full
 * metadata (name, schemas, access, transports) so the public catalog
 * stays honest, but `invoke` throws if called — this path is reserved
 * for discovery-only registries (OpenAPI/AsyncAPI generators).
 */
export function createListWorkersOperation(options?: ListWorkersOptions) {
  const registry = options?.workerRegistry;
  const clock = options?.clock ?? Date.now;
  return defineOperation<ListWorkersInput, ListWorkersOutput>({
    name: 'weft.workers.list',
    mcpExposable: false,
    summary: 'List connected workers, their advertised activities, and saturation',
    tags: ['System'],
    inputSchema: listWorkersInput,
    outputSchema: listWorkersOutput as z.ZodType<ListWorkersOutput>,
    access: { kind: 'scoped', scopes: { kind: 'anyOf', scopes: ['system:read'] } },
    discoverable: true,
    transports: { http: true, jsonRpcHttp: true, jsonRpcWebSocket: true, jsonRpcStdio: true },
    unknownKeyPolicy: { http: 'strip', jsonRpc: 'reject' },
    invoke: async (): Promise<ListWorkersOutput> => {
      if (registry === undefined) {
        throw new Error(
          'weft.workers.list invoked from a discovery-only operation registry; no WorkerRegistry was wired in',
        );
      }
      const now = clock();
      return {
        items: registry.getWorkerSummaries(now),
        routingPolicy: registry.policy,
      };
    },
  });
}

/** Default discovery-only operation; live servers use `createListWorkersOperation(...)`. */
export const listWorkersOperation = createListWorkersOperation();

function formatInvalidParamsMessage(
  fault: Extract<OperationFault, { code: 'InvalidParams' }>,
): string {
  return fault.data.issues
    .map((issue) => {
      const path = issue.path.join('.');
      return path.length > 0 ? `${path}: ${issue.message}` : issue.message;
    })
    .join('; ');
}

function shapeListWorkersFault(fault: OperationFault): Response {
  if (fault.code === 'InvalidParams') {
    return new Response(JSON.stringify({ error: formatInvalidParamsMessage(fault) }), {
      status: 400,
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
 * Build the REST binding for `weft.workers.list`. The binding is metadata
 * only; the live `WorkerRegistry` is wired into the operation, not the
 * binding.
 */
export function createListWorkersRestBinding(): UnknownRestBinding {
  return {
    method: 'GET',
    path: '/v1/workers',
    pathParamNames: [],
    operationName: 'weft.workers.list',
    inputSources: {},
    extractInput: async () => ({}),
    success: { kind: 'json', status: 200 },
    shapeSuccess: (output: ListWorkersOutput) =>
      new Response(JSON.stringify(output), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    shapeFault: shapeListWorkersFault,
  };
}

export const listWorkersRestBinding = createListWorkersRestBinding();
