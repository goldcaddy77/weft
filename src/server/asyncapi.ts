/**
 * AsyncAPI 3.0 document generator driven by the operation registry.
 *
 * @module server/asyncapi
 */

import { z } from 'zod';

import {
  buildOperationEntry,
  buildSseChannel,
  buildSseMessages,
  buildWebSocketChannel,
  buildWebSocketMessages,
} from './asyncapi-channels.ts';
import { isDiscoverable } from './discovery-filter.ts';
import { canonicalJson } from './openapi-canonical-json.ts';
import type { ErasedOperation, OperationRegistry } from './operation-catalog.ts';

export type AsyncApiOptions = {
  registry: OperationRegistry;
  title?: string;
  version?: string;
  serverUrl?: string;
};

const JSON_RPC_ERROR_SCHEMA: Record<string, unknown> = {
  additionalProperties: false,
  properties: {
    code: { type: 'number' },
    data: {},
    message: { type: 'string' },
  },
  required: ['code', 'message'],
  type: 'object',
};

/**
 * Generate an AsyncAPI 3.0 document from the operation registry.
 *
 * Only discoverable operations with kind `subscription` or `stream` are
 * listed. The returned object is deterministic: object keys are recursively
 * sorted, and identical component messages are deduplicated by canonical JSON.
 */
export function generateAsyncApiDocument(options: AsyncApiOptions): Record<string, unknown> {
  const channels: Record<string, unknown> = {};
  const operations: Record<string, unknown> = {};
  const messages: Record<string, Record<string, unknown>> = {};
  const messageAliases = new Map<string, string>();
  const messageNamesByCanonical = new Map<string, string>();

  const asyncOperations = options.registry
    .list()
    .filter(isAsyncApiOperation)
    .toSorted((left, right) => compareStrings(left.name, right.name));

  for (const operation of asyncOperations) {
    const channelName = channelNameForOperation(operation);
    const operationName = operationNameForOperation(operation);
    const channel =
      operation.kind === 'subscription'
        ? buildWebSocketChannel(operation)
        : buildSseChannel(operation);
    const operationMessages =
      operation.kind === 'subscription'
        ? buildWebSocketMessages(operation, zodToJsonSchema)
        : buildSseMessages(operation, zodToJsonSchema);

    for (const [messageName, message] of Object.entries(operationMessages).toSorted(
      ([left], [right]) => compareStrings(left, right),
    )) {
      const canonical = canonicalJson(message);
      const existingName = messageNamesByCanonical.get(canonical);
      if (existingName === undefined) {
        messageNamesByCanonical.set(canonical, messageName);
        messageAliases.set(messageName, messageName);
        messages[messageName] = normalizeJsonObject(message);
      } else {
        messageAliases.set(messageName, existingName);
      }
    }

    channels[channelName] = channel;
    operations[operationName] = buildOperationEntry(operation, channelName, operation.kind);
  }

  const document: Record<string, unknown> = {
    asyncapi: '3.0.0',
    info: {
      title: options.title ?? 'Weft Workflow Engine',
      version: options.version ?? '0.0.1',
    },
    channels: replaceMessageReferences(channels, messageAliases),
    operations: replaceMessageReferences(operations, messageAliases),
    components: {
      messages,
      schemas: {
        JsonRpcError: JSON_RPC_ERROR_SCHEMA,
      },
    },
  };

  if (options.serverUrl !== undefined) {
    document['servers'] = {
      default: {
        host: serverHost(options.serverUrl),
        protocol: 'ws',
      },
    };
  }

  return normalizeJsonObject(document);
}

function isAsyncApiOperation(operation: ErasedOperation): operation is ErasedOperation & {
  readonly kind: 'subscription' | 'stream';
} {
  return (
    isDiscoverable(operation) && (operation.kind === 'subscription' || operation.kind === 'stream')
  );
}

function channelNameForOperation(operation: ErasedOperation): string {
  return operation.name.replaceAll('.', '/');
}

function operationNameForOperation(operation: ErasedOperation): string {
  return operation.name.replaceAll('.', '_');
}

function zodToJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const result: unknown = z.toJSONSchema(schema, {
    unrepresentable: 'any',
  });
  const object = asPlainObject(result);
  if (!('$schema' in object)) return object;

  const schemaWithoutDialect = { ...object };
  delete schemaWithoutDialect['$schema'];
  return schemaWithoutDialect;
}

function replaceMessageReferences(value: unknown, aliases: ReadonlyMap<string, string>): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => replaceMessageReferences(entry, aliases));
  }
  if (!isPlainObject(value)) return value;

  const reference = value['$ref'];
  if (typeof reference === 'string' && reference.startsWith('#/components/messages/')) {
    const messageName = reference.slice('#/components/messages/'.length);
    const aliasedName = aliases.get(messageName) ?? messageName;
    return { ...value, $ref: `#/components/messages/${aliasedName}` };
  }

  const replaced: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    replaced[key] = replaceMessageReferences(entry, aliases);
  }
  return replaced;
}

function serverHost(serverUrl: string): string {
  try {
    return new URL(serverUrl).host;
  } catch {
    return serverUrl;
  }
}

function normalizeJsonObject(value: unknown): Record<string, unknown> {
  const parsed: unknown = JSON.parse(canonicalJson(value));
  return asPlainObject(parsed);
}

function asPlainObject(value: unknown): Record<string, unknown> {
  if (isPlainObject(value)) return value;
  return {};
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
