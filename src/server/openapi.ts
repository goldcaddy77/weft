/**
 * OpenAPI 3.1 document generator driven from the shared route model.
 *
 * Produces a JSON-serializable OpenAPI document that reflects the exact
 * routes registered in `route-model.ts`. Both `handleRequest()` and
 * `serve()` expose this at `GET /openapi.json`.
 *
 * @module server/openapi
 */

import { z } from 'zod';

import type { ErasedOperation, OperationRegistry } from './operation-catalog.ts';
import type { ParamSource } from './rest-binding.ts';
import type { UnknownRestBinding } from './rest-bindings.ts';
import { createLiveOperationRegistry, createLiveRestBindings } from './rest-bindings.ts';
import { ROUTES, toOpenApiPath } from './route-model.ts';

export type OpenApiSecuritySchemeName = 'bearerAuth' | 'apiKeyAuth';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Options for customizing the generated OpenAPI document. */
export type OpenApiOptions = {
  /** API title. Defaults to `'Weft Workflow Engine'`. */
  title?: string;
  /** API version. Defaults to `'0.0.1'`. */
  version?: string;
  /** Operation registry used to emit migrated REST bindings. */
  registry?: OperationRegistry;
  /**
   * REST bindings used to emit OpenAPI path items. Defaults to
   * `createLiveRestBindings()`. Servers that override their binding set
   * (e.g. for tenant-scoped subsets) should pass the same set here so
   * `/openapi.json` matches the live HTTP surface.
   */
  restBindings?: ReadonlyArray<UnknownRestBinding>;
  /** Server URL. When omitted, no `servers` array is included. */
  serverUrl?: string;
  /**
   * Security schemes the live server actually supports. When omitted,
   * emit both schemes for backward-compatible call sites.
   */
  supportedSchemes?: ReadonlySet<OpenApiSecuritySchemeName>;
};

// ---------------------------------------------------------------------------
// Generator
// ---------------------------------------------------------------------------

type OpenApiSchema = Record<string, unknown>;
type OpenApiContent = Record<string, { schema: OpenApiSchema }>;
type OpenApiResponse = {
  description: string;
  content?: OpenApiContent;
};

const JSON_MEDIA_TYPE = 'application/json';
const OCTET_STREAM_MEDIA_TYPE = 'application/octet-stream';

/**
 * Generate an OpenAPI 3.1 JSON document from the shared route definitions.
 *
 * Each route in `ROUTES` becomes a path item with the appropriate HTTP
 * method, summary, tags, and path parameters.
 */
function buildPathParameters(paramNames: readonly string[]): Array<Record<string, unknown>> {
  return paramNames.map((name) => ({
    name,
    in: 'path',
    required: true,
    schema: { type: name === 'step' ? 'integer' : 'string' },
  }));
}

function inputSourceEntries(binding: UnknownRestBinding): Array<[string, ParamSource]> {
  return Object.entries(binding.inputSources)
    .filter((entry): entry is [string, ParamSource] => entry[1] !== undefined)
    .toSorted(([left], [right]) => byString(left, right));
}

function zodToJsonSchema(schema: z.ZodType): OpenApiSchema {
  // Zod 4 ships native JSON Schema conversion. Unrepresentable runtime
  // values degrade to `{}` so discovery stays available for custom types.
  const result = z.toJSONSchema(schema, { unrepresentable: 'any' }) as OpenApiSchema;
  if ('$schema' in result) {
    const { $schema: _unused, ...rest } = result;
    return rest;
  }
  return result;
}

function inputJsonSchema(operation: ErasedOperation): OpenApiSchema {
  return zodToJsonSchema(operation.inputSchema);
}

function fieldSchema(operation: ErasedOperation, field: string): OpenApiSchema {
  const properties = asPlainObject(inputJsonSchema(operation)['properties']);
  return asPlainObject(properties[field]);
}

function requiredInputFields(operation: ErasedOperation): Set<string> {
  return new Set(asStringArray(inputJsonSchema(operation)['required']));
}

function buildBindingParameters(
  binding: UnknownRestBinding,
  operation: ErasedOperation,
): Array<Record<string, unknown>> {
  const parameters = buildPathParameters(binding.pathParamNames);
  const seen = new Set(
    parameters.map((parameter) => `${String(parameter['in'])}:${String(parameter['name'])}`),
  );

  for (const [field, source] of inputSourceEntries(binding)) {
    if (source.kind !== 'query' && source.kind !== 'header') continue;
    const parameter = {
      name: source.kind === 'query' ? source.queryParam : source.headerName,
      in: source.kind,
      required: false,
      schema: fieldSchema(operation, field),
    };
    const key = `${parameter.in}:${parameter.name}`;
    if (seen.has(key)) continue;
    parameters.push(parameter);
    seen.add(key);
  }

  return parameters;
}

function buildRequestBody(
  binding: UnknownRestBinding,
  operation: ErasedOperation,
): Record<string, unknown> | undefined {
  const entries = inputSourceEntries(binding);
  const bodyEntry = entries.find((entry) => entry[1].kind === 'body');
  if (bodyEntry !== undefined) {
    const [field, source] = bodyEntry;
    if (source.kind !== 'body') return undefined;
    const mediaType = source.mediaType ?? JSON_MEDIA_TYPE;
    const schema =
      mediaType === OCTET_STREAM_MEDIA_TYPE ? binaryBodySchema() : fieldSchema(operation, field);
    return {
      required: true,
      content: { [mediaType]: { schema } },
    };
  }

  const bodyFieldEntries = entries.filter(
    (entry): entry is [string, Extract<ParamSource, { kind: 'body-field' }>] =>
      entry[1].kind === 'body-field',
  );
  if (bodyFieldEntries.length === 0) return undefined;

  const requiredFields = requiredInputFields(operation);
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const [field, source] of bodyFieldEntries) {
    properties[source.bodyField] = fieldSchema(operation, field);
    if (requiredFields.has(field)) required.push(source.bodyField);
  }

  const schema: OpenApiSchema = {
    type: 'object',
    properties,
    additionalProperties: operation.unknownKeyPolicy.http !== 'reject',
  };
  if (required.length > 0) schema['required'] = required.toSorted(byString);

  return {
    required: true,
    content: { [JSON_MEDIA_TYPE]: { schema } },
  };
}

function buildResponses(
  binding: UnknownRestBinding,
  operation: ErasedOperation,
): Record<string, OpenApiResponse> {
  const responses: Record<string, OpenApiResponse> = {};
  const success = binding.success;

  if (success.kind === 'json') {
    responses[String(success.status)] = {
      description: 'Successful response',
      content: { [JSON_MEDIA_TYPE]: { schema: zodToJsonSchema(operation.outputSchema) } },
    };
    return responses;
  }

  if (success.kind === 'empty') {
    responses[String(success.status)] = { description: 'No content' };
    return responses;
  }

  responses['200'] = {
    description: 'Streaming response',
    content: { [success.mediaType]: { schema: streamingResponseSchema(success.mediaType) } },
  };

  if (success.mediaType === OCTET_STREAM_MEDIA_TYPE && outputCanBeNull(operation)) {
    responses['404'] = { description: 'Storage key not found' };
  }

  return responses;
}

function binaryBodySchema(): OpenApiSchema {
  return { type: 'string', format: 'binary' };
}

function streamingResponseSchema(mediaType: string): OpenApiSchema {
  if (mediaType === OCTET_STREAM_MEDIA_TYPE) return binaryBodySchema();
  return { type: 'string' };
}

function outputCanBeNull(operation: ErasedOperation): boolean {
  try {
    return operation.outputSchema.safeParse(null).success;
  } catch {
    return false;
  }
}

function asPlainObject(value: unknown): Record<string, unknown> {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string');
}

function byString(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Emit REST bindings into the OpenAPI paths map. Exported for tests;
 * `generateOpenApiDocument` is the production entry point.
 *
 * @internal
 */
export function emitBindings(
  paths: Record<string, Record<string, unknown>>,
  tagSet: Set<string>,
  bindings: ReadonlyArray<UnknownRestBinding> = createLiveRestBindings(),
  registry: OperationRegistry = createLiveOperationRegistry(),
): Set<string> {
  const boundMethodPaths = new Set<string>();
  for (const binding of bindings) {
    const operation: ErasedOperation | undefined = registry.get(binding.operationName);
    if (operation === undefined) continue;
    const openApiPath = toOpenApiPath(binding.path);
    boundMethodPaths.add(`${binding.method} ${openApiPath}`);
    if (!paths[openApiPath]) paths[openApiPath] = {};

    const parameters = buildBindingParameters(binding, operation);
    const entry: Record<string, unknown> = {
      summary: operation.summary,
      operationId: operation.name,
      tags: operation.tags,
      responses: buildResponses(binding, operation),
    };
    if (parameters.length > 0) entry['parameters'] = parameters;

    const requestBody = buildRequestBody(binding, operation);
    if (requestBody !== undefined) entry['requestBody'] = requestBody;

    paths[openApiPath][binding.method.toLowerCase()] = entry;
    for (const tag of operation.tags) tagSet.add(tag);
  }
  return boundMethodPaths;
}

function emitRoutes(
  paths: Record<string, Record<string, unknown>>,
  tagSet: Set<string>,
  boundMethodPaths: Set<string>,
): void {
  for (const route of ROUTES) {
    if (route.handler === 'openApiDocument') continue;
    const openApiPath = toOpenApiPath(route.path);
    if (boundMethodPaths.has(`${route.method} ${openApiPath}`)) continue;
    if (!paths[openApiPath]) paths[openApiPath] = {};

    const parameters = buildPathParameters(route.paramNames);
    const entry: Record<string, unknown> = {
      summary: route.summary,
      operationId: route.handler,
      tags: route.tags,
      responses: { '200': { description: 'Successful response' } },
    };
    if (parameters.length > 0) entry['parameters'] = parameters;
    // `ROUTES` only contains direct-handler legacy endpoints, and that
    // table is intentionally GET-only. Any body-carrying route must be
    // cataloged in REST_BINDINGS so the runtime API and OpenAPI contract
    // stay aligned from one source of truth.

    paths[openApiPath][route.method.toLowerCase()] = entry;
    for (const tag of route.tags) tagSet.add(tag);
  }
}

// oxlint-disable-next-line complexity -- ID:server-openapi-generate-open-api-document-complexity
export function generateOpenApiDocument(options?: OpenApiOptions): Record<string, unknown> {
  const title = options?.title ?? 'Weft Workflow Engine';
  const version = options?.version ?? '0.0.1';
  const registry = options?.registry ?? createLiveOperationRegistry();
  const restBindings = options?.restBindings;

  const paths: Record<string, Record<string, unknown>> = {};
  const tagSet = new Set<string>();

  // REST_BINDINGS win against any stale ROUTES entry covering the same
  // (method, path) — a migrated operation owns its OpenAPI description.
  const boundMethodPaths = emitBindings(paths, tagSet, restBindings, registry);
  emitRoutes(paths, tagSet, boundMethodPaths);

  const tags = [...tagSet].toSorted().map((name) => ({ name }));
  const supportedSchemes =
    options?.supportedSchemes ?? new Set<OpenApiSecuritySchemeName>(['bearerAuth', 'apiKeyAuth']);
  const security = [...supportedSchemes].map((schemeName) => ({ [schemeName]: [] }));
  const schemeDefinitions: Record<OpenApiSecuritySchemeName, Record<string, string>> = {
    bearerAuth: {
      type: 'http',
      scheme: 'bearer',
      bearerFormat: 'JWT',
    },
    apiKeyAuth: {
      type: 'apiKey',
      in: 'header',
      name: 'x-api-key',
    },
  };
  const emittedSecuritySchemes = Object.fromEntries(
    [...supportedSchemes].map((schemeName) => [schemeName, schemeDefinitions[schemeName]]),
  );

  const document: Record<string, unknown> = {
    openapi: '3.1.0',
    info: { title, version },
    paths,
    tags,
    security,
    components: {
      securitySchemes: emittedSecuritySchemes,
    },
  };

  if (options?.serverUrl) {
    document['servers'] = [{ url: options.serverUrl }];
  }

  return document;
}
