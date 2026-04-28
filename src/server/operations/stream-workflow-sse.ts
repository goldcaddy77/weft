import { z } from 'zod';

import type { StoredStreamChunk } from '../../core/context.ts';
import type { Engine } from '../../core/engine.ts';
import { FAULT_CODE_TO_HTTP_STATUS, type OperationFault } from '../operation-fault.ts';
import { defineOperation } from '../operation-registry.ts';
import type { UnknownRestBinding } from '../rest-bindings.ts';
import { parseOptionalSequenceCursor } from '../sequence-cursor.ts';
import { invalidParamsFault, jsonErrorResponse } from './operation-helpers.ts';
import { createStoredChunkSSEStream, SSE_RESPONSE_HEADERS } from './sse-stream.ts';

const TOKENS_STREAM_KEY = 'tokens';

const streamWorkflowSseInput = z.object({
  workflowId: z.string().min(1),
  after: z.number().int().optional(),
});

export type StreamWorkflowSseInput = z.infer<typeof streamWorkflowSseInput>;
export type StreamWorkflowSseOutput = { chunks: StoredStreamChunk[] };

export const streamWorkflowSseOperation = defineOperation<
  StreamWorkflowSseInput,
  StreamWorkflowSseOutput
>({
  name: 'weft.workflows.streams.sse',
  summary: 'Stream workflow tokens as Server-Sent Events',
  tags: ['Streams'],
  inputSchema: streamWorkflowSseInput,
  outputSchema: z.object({ chunks: z.array(z.unknown()) }) as z.ZodType<StreamWorkflowSseOutput>,
  access: { kind: 'public' },
  // SSE is a REST-shaped delivery format; JSON-RPC clients receive the
  // canonical `{ chunks }` envelope from the same operation. Keeping all
  // four transports lets WebSocket/stdio callers consume token replays
  // without needing a separate operation.
  transports: { http: true, jsonRpcHttp: true, jsonRpcWebSocket: true, jsonRpcStdio: true },
  unknownKeyPolicy: { http: 'strip', jsonRpc: 'reject' },
  invoke: async ({ input, engine }): Promise<StreamWorkflowSseOutput> => {
    const e = engine as Engine;

    const state = await e.get(input.workflowId);
    if (state === null) {
      const message = `Workflow "${input.workflowId}" not found`;
      const fault: OperationFault = {
        code: 'NotFound',
        message,
        data: { resource: 'workflow', identifier: input.workflowId },
      };
      throw fault;
    }

    try {
      const chunks =
        input.after !== undefined
          ? await e.getStreamChunks(input.workflowId, TOKENS_STREAM_KEY, { after: input.after })
          : await e.getStreamChunks(input.workflowId, TOKENS_STREAM_KEY);
      return { chunks };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const fault: OperationFault = { code: 'EngineFailure', message, data: {} };
      throw fault;
    }
  },
});

const ACCEPT_HEADER_MUST_INCLUDE_SSE = 'Accept header must include text/event-stream';

function shapeStreamWorkflowSseFault(fault: OperationFault): Response {
  if (fault.code === 'NotFound') {
    return jsonErrorResponse(fault.message, 404);
  }
  if (fault.code === 'InvalidParams') {
    // Legacy `handleStreamSSE` returned 406 for the Accept-header mismatch
    // (a REST-only check). All other InvalidParams paths use 400.
    if (fault.message === ACCEPT_HEADER_MUST_INCLUDE_SSE) {
      return jsonErrorResponse(fault.message, 406);
    }
    return jsonErrorResponse(fault.message, 400);
  }
  if (fault.code === 'EngineFailure') {
    return jsonErrorResponse(fault.message, 500);
  }
  return jsonErrorResponse(fault.message, FAULT_CODE_TO_HTTP_STATUS[fault.code]);
}

/**
 * Map a stored token chunk to the SSE `data:` text. Strings pass through
 * verbatim; objects with a non-empty `token` string property emit that
 * string. Anything else is dropped (legacy parity).
 */
function mapTokenChunkToText(chunk: StoredStreamChunk): string | null {
  if (typeof chunk.value === 'string') {
    return chunk.value;
  }
  if (
    typeof chunk.value === 'object' &&
    chunk.value !== null &&
    'token' in chunk.value &&
    typeof (chunk.value as { token?: unknown }).token === 'string' &&
    (chunk.value as { token: string }).token.length > 0
  ) {
    return (chunk.value as { token: string }).token;
  }
  return null;
}

function shapeStreamWorkflowSseSuccess(output: StreamWorkflowSseOutput): Response {
  return new Response(createStoredChunkSSEStream(output.chunks, mapTokenChunkToText), {
    status: 200,
    headers: SSE_RESPONSE_HEADERS,
  });
}

export const streamWorkflowSseRestBinding: UnknownRestBinding = {
  method: 'GET',
  path: '/v1/workflows/:id/sse',
  pathParamNames: ['id'],
  operationName: 'weft.workflows.streams.sse',
  inputSources: {
    workflowId: { kind: 'path', pathParam: 'id' },
    after: { kind: 'header', headerName: 'Last-Event-ID' },
  },
  extractInput: async (request, pathParams) => {
    // Legacy 406: REST-only Accept negotiation. JSON-RPC clients never reach
    // this path, so the check stays in extractInput rather than `invoke`.
    const accept = request.headers.get('Accept') ?? '';
    if (!accept.includes('text/event-stream')) {
      throw invalidParamsFault(ACCEPT_HEADER_MUST_INCLUDE_SSE);
    }

    const result = parseOptionalSequenceCursor(
      request.headers.get('Last-Event-ID'),
      'Last-Event-ID header',
    );
    if (result.error !== undefined) {
      throw invalidParamsFault(result.error);
    }

    return {
      workflowId: pathParams['id'] ?? '',
      ...(result.value !== undefined ? { after: result.value } : {}),
    };
  },
  success: { kind: 'streaming', mediaType: 'text/event-stream' },
  shapeSuccess: shapeStreamWorkflowSseSuccess,
  shapeFault: shapeStreamWorkflowSseFault,
};
