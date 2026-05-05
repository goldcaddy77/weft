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

function zodToJsonSchema(schema: z.ZodType): Record<string, unknown> {
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
    const messages = buildWebSocketMessages(operation('weft.workflows.events'), zodToJsonSchema);

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
    const messages = buildSseMessages(operation('weft.workflows.streams.sse'), zodToJsonSchema);

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
      ...buildWebSocketMessages(operation('weft.workflows.events'), zodToJsonSchema),
      ...buildSseMessages(operation('weft.workflows.streams.sse'), zodToJsonSchema),
    };

    for (const message of Object.values(messages)) {
      const payload = message['payload'];
      expect(isRecord(payload)).toBe(true);
      if (isRecord(payload)) {
        expect('type' in payload || 'properties' in payload).toBe(true);
      }
    }
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
