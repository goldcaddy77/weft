import { describe, expect, it } from 'bun:test';
import { z } from 'zod';

import {
  buildOperationEntry,
  buildSseChannel,
  buildSseMessages,
  buildWebSocketMessages,
} from './asyncapi-channels.ts';
import type { ErasedOperation } from './operation-catalog.ts';
import { createLiveOperationRegistry } from './rest-bindings.ts';

function definitionSchemaToJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const result: unknown = z.toJSONSchema(schema, {
    unrepresentable: 'any',
  });
  if (isRecord(result) && '$schema' in result) {
    const { $schema: _unused, ...rest } = result;
    return rest;
  }
  return isRecord(result) ? result : {};
}

function operation(name: string): ErasedOperation {
  const found = createLiveOperationRegistry().get(name);
  if (found === undefined) {
    throw new Error(`expected operation ${name} to be registered`);
  }
  return found;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

describe('AsyncAPI channel builders', () => {
  it('buildWebSocketMessages returns all subscription message keys with operation prefixes', () => {
    const messages = buildWebSocketMessages(
      operation('weft.workflows.events'),
      definitionSchemaToJsonSchema,
    );

    expect(Object.keys(messages).toSorted()).toEqual([
      'weft_workflows_events_errorFrame',
      'weft_workflows_events_eventDeliver',
      'weft_workflows_events_subscribeAck',
      'weft_workflows_events_subscribeRequest',
      'weft_workflows_events_terminated',
      'weft_workflows_events_unsubscribeRequest',
    ]);
  });

  it('buildSseMessages returns all stream message keys with operation prefixes', () => {
    const messages = buildSseMessages(
      operation('weft.workflows.streams.sse'),
      definitionSchemaToJsonSchema,
    );

    expect(Object.keys(messages).toSorted()).toEqual([
      'weft_workflows_streams_sse_doneEvent',
      'weft_workflows_streams_sse_errorEvent',
      'weft_workflows_streams_sse_tokenEvent',
    ]);
  });

  it('omits empty bindings from SSE channels', () => {
    const channel = buildSseChannel(
      operation('weft.workflows.streams.sse'),
      '/v1/workflows/{id}/streams/sse',
    );

    expect(channel).not.toHaveProperty('bindings');
  });

  it('builds message payloads as JSON Schema objects', () => {
    const messages = {
      ...buildWebSocketMessages(operation('weft.workflows.events'), definitionSchemaToJsonSchema),
      ...buildSseMessages(operation('weft.workflows.streams.sse'), definitionSchemaToJsonSchema),
    };

    for (const message of Object.values(messages)) {
      const payload = message['payload'];
      expect(isRecord(payload)).toBe(true);
      if (isRecord(payload)) {
        expect('type' in payload || 'properties' in payload).toBe(true);
      }
    }
  });

  it('SSE token payload describes the wire (plain text), not the logical eventSchema', () => {
    // Bugbot regression: the token message previously claimed `data:`
    // carried a JSON encoding of `eventSchema` ({sequence, value}), but
    // `mapTokenChunkToText` emits the raw `token` string verbatim. The
    // logical schema is preserved as `x-weft-event-schema` for clients
    // that need it.
    const messages = buildSseMessages(
      operation('weft.workflows.streams.sse'),
      definitionSchemaToJsonSchema,
    );
    const token = messages['weft_workflows_streams_sse_tokenEvent'] as {
      payload: Record<string, unknown>;
      'x-weft-event-schema': Record<string, unknown>;
      'x-weft-sse-frame': string;
    };
    expect(token).toBeDefined();
    expect(token.payload).toEqual({ type: 'string' });
    expect(token['x-weft-sse-frame']).toContain('data: <token-text>');
    // Logical schema preserved, but as an extension — not the wire payload.
    expect(token['x-weft-event-schema']).toBeDefined();
  });

  it('terminated message reason enum mirrors what json-rpc-websocket actually emits', () => {
    // Bugbot regression: the enum previously listed `engine-error` and
    // `overflow` as advertised reasons, but the WebSocket session only
    // emits `client-unsubscribed`, `server-closed`, and
    // `validation-failed` (the engine-error / overflow cases collapse
    // into `server-closed` with a `fault` payload). Discovery docs that
    // promise reasons clients will never observe break codegen.
    const messages = buildWebSocketMessages(
      operation('weft.workflows.events'),
      definitionSchemaToJsonSchema,
    );
    const terminated = messages['weft_workflows_events_terminated'] as
      | { payload: Record<string, unknown> }
      | undefined;
    expect(terminated).toBeDefined();
    const properties = terminated!.payload['properties'] as Record<string, unknown>;
    const params = properties['params'] as Record<string, unknown>;
    const paramsProperties = params['properties'] as Record<string, unknown>;
    const reason = paramsProperties['reason'] as { enum: ReadonlyArray<string> };
    expect([...reason.enum].toSorted()).toEqual([
      'client-unsubscribed',
      'server-closed',
      'validation-failed',
    ]);
  });

  it('buildOperationEntry returns a channel reference and action', () => {
    const entry = buildOperationEntry(
      operation('weft.workflows.events'),
      'weft/workflows/events',
      'subscription',
    );

    expect(entry['action']).toBe('receive');
    expect(entry['channel']).toEqual({ $ref: '#/channels/weft~1workflows~1events' });
  });
});
