import { z } from 'zod';

import type { StoredStreamChunk } from '../../core/context.ts';
import type { Engine } from '../../core/engine.ts';
import { FAULT_CODE_TO_HTTP_STATUS, type OperationFault } from '../operation-fault.ts';
import { defineOperation } from '../operation-registry.ts';
import type { UnknownRestBinding } from '../rest-bindings.ts';
import { parseOptionalSequenceCursor } from '../sequence-cursor.ts';
import { invalidParamsFault, jsonErrorResponse } from './operation-helpers.ts';
import { createStoredChunkSSEStream, SSE_RESPONSE_HEADERS } from './sse-stream.ts';

const getStreamChunksInput = z.object({
  workflowId: z.string().min(1),
  key: z.string().min(1),
  after: z.number().int().optional(),
});

export type GetStreamChunksInput = z.infer<typeof getStreamChunksInput>;
export type GetStreamChunksOutput = { chunks: StoredStreamChunk[] };

export const getStreamChunksOperation = defineOperation<
  GetStreamChunksInput,
  GetStreamChunksOutput
>({
  name: 'weft.workflows.streams.chunks',
  summary: 'Read stored stream chunks for a workflow stream key',
  tags: ['Streams'],
  inputSchema: getStreamChunksInput,
  outputSchema: z.object({ chunks: z.array(z.unknown()) }) as z.ZodType<GetStreamChunksOutput>,
  access: { kind: 'public' },
  transports: { http: true, jsonRpcHttp: true, jsonRpcWebSocket: true, jsonRpcStdio: true },
  unknownKeyPolicy: { http: 'strip', jsonRpc: 'reject' },
  invoke: async ({ input, engine }): Promise<GetStreamChunksOutput> => {
    const e = engine as Engine;

    try {
      const chunks =
        input.after !== undefined
          ? await e.getStreamChunks(input.workflowId, input.key, { after: input.after })
          : await e.getStreamChunks(input.workflowId, input.key);
      return { chunks };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const fault: OperationFault = { code: 'EngineFailure', message, data: {} };
      throw fault;
    }
  },
});

function shapeGetStreamChunksFault(fault: OperationFault): Response {
  if (fault.code === 'InvalidParams') {
    return jsonErrorResponse(fault.message, 400);
  }
  if (fault.code === 'EngineFailure') {
    return jsonErrorResponse(fault.message, 500);
  }
  return jsonErrorResponse(fault.message, FAULT_CODE_TO_HTTP_STATUS[fault.code]);
}

/**
 * Negotiate JSON vs SSE based on `Accept`. The legacy handler preferred SSE
 * when `text/event-stream` was anywhere in `Accept`; otherwise it returned
 * `{ chunks }` as JSON. Cross-transport callers (JSON-RPC) always see JSON.
 */
function shapeGetStreamChunksSuccess(output: GetStreamChunksOutput, request: Request): Response {
  const accept = request.headers.get('Accept') ?? '';
  if (accept.includes('text/event-stream')) {
    return new Response(
      createStoredChunkSSEStream(output.chunks, (chunk) =>
        JSON.stringify({ sequence: chunk.sequence, value: chunk.value }),
      ),
      { status: 200, headers: SSE_RESPONSE_HEADERS },
    );
  }
  return new Response(JSON.stringify(output), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

export const getStreamChunksRestBinding: UnknownRestBinding = {
  method: 'GET',
  path: '/v1/workflows/:id/streams/:key',
  pathParamNames: ['id', 'key'],
  operationName: 'weft.workflows.streams.chunks',
  inputSources: {
    workflowId: { kind: 'path', pathParam: 'id' },
    key: { kind: 'path', pathParam: 'key' },
    after: { kind: 'query', queryParam: 'after' },
  },
  extractInput: async (request, pathParams) => {
    const result = parseOptionalSequenceCursor(
      new URL(request.url).searchParams.get('after'),
      'after query parameter',
    );
    if (result.error !== undefined) {
      throw invalidParamsFault(result.error);
    }
    return {
      workflowId: pathParams['id'] ?? '',
      key: pathParams['key'] ?? '',
      ...(result.value !== undefined ? { after: result.value } : {}),
    };
  },
  success: { kind: 'streaming', mediaType: 'text/event-stream' },
  shapeSuccess: shapeGetStreamChunksSuccess,
  shapeFault: shapeGetStreamChunksFault,
};
