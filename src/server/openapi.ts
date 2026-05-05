/**
 * OpenAPI 3.1 document generator driven from the shared route model.
 *
 * Produces a JSON-serializable OpenAPI document that reflects the exact
 * routes registered in `route-model.ts`. Both `handleRequest()` and
 * `serve()` expose this at `GET /openapi.json`.
 *
 * @module server/openapi
 */

import { isDiscoverable } from './discovery-filter.ts';
import { applyDiscoveryInfo, type DiscoveryInfo } from './discovery-info.ts';
import { buildErrorResponses, ERROR_SCHEMA } from './openapi-error-responses.ts';
import { extractComponentsSchemas, type OpenApiSchemaHelper } from './openapi-schemas.ts';
import type { ErasedOperation, OperationRegistry } from './operation-catalog.ts';
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
  /** Operator-supplied discovery metadata applied to the generated document. */
  discoveryInfo?: DiscoveryInfo;
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

const DEFAULT_SCHEMA_HELPER: OpenApiSchemaHelper = {
  components: {},
  refFor() {
    return undefined;
  },
};

/**
 * Build the success-response object for a binding, branching on its
 * declared `success.kind`. JSON bindings emit `application/json` with
 * the operation's output schema. Streaming bindings emit the binding's
 * declared `mediaType` (e.g. `text/event-stream`) and document the
 * payload as a string — the per-frame envelope's actual contents are
 * documented separately in `/asyncapi.json`. Empty (204) bindings emit
 * a no-content response.
 */
function buildSuccessResponse(
  binding: UnknownRestBinding,
  operation: ErasedOperation,
  schemaHelper: OpenApiSchemaHelper,
): Record<string, unknown> {
  const success = binding.success;
  if (success.kind === 'empty') {
    return {
      [String(success.status)]: {
        description: 'No content',
      },
    };
  }
  if (success.kind === 'streaming') {
    return {
      '200': {
        description: 'Streaming response',
        content: {
          [success.mediaType]: {
            schema: { type: 'string' },
          },
        },
      },
    };
  }
  return {
    [String(success.status)]: {
      description: 'Successful response',
      content: {
        'application/json': {
          schema: schemaHelper.refFor(operation.name, 'Output') ?? { type: 'object' },
        },
      },
    },
  };
}

/**
 * Emit REST bindings into the OpenAPI paths map. Exported for tests;
 * `generateOpenApiDocument` is the production entry point.
 *
 * @internal
 */
// oxlint-disable-next-line complexity -- ID:server-openapi-emit-bindings-complexity
export function emitBindings(
  paths: Record<string, Record<string, unknown>>,
  tagSet: Set<string>,
  bindings: ReadonlyArray<UnknownRestBinding> = createLiveRestBindings(),
  registry: OperationRegistry = createLiveOperationRegistry(),
  schemaHelper: OpenApiSchemaHelper = DEFAULT_SCHEMA_HELPER,
): Set<string> {
  const boundMethodPaths = new Set<string>();
  for (const binding of bindings) {
    const operation: ErasedOperation | undefined = registry.get(binding.operationName);
    if (operation === undefined) continue;
    const openApiPath = toOpenApiPath(binding.path);
    if (!isDiscoverable(operation)) continue;
    boundMethodPaths.add(`${binding.method} ${openApiPath}`);
    if (!paths[openApiPath]) paths[openApiPath] = {};

    const parameters = buildPathParameters(binding.pathParamNames);
    const successResponse = buildSuccessResponse(binding, operation, schemaHelper);
    const entry: Record<string, unknown> = {
      summary: operation.summary,
      operationId: operation.name,
      tags: operation.tags,
      responses: {
        ...successResponse,
        ...buildErrorResponses(operation),
      },
    };
    if (parameters.length > 0) entry['parameters'] = parameters;

    // Body-accepting methods documented with a JSON request body — same
    // behavior as the legacy `emitRoutes` path so a migrated POST/PUT/
    // PATCH operation keeps its `requestBody` entry in the document.
    if (binding.method === 'POST' || binding.method === 'PUT' || binding.method === 'PATCH') {
      entry['requestBody'] = {
        content: {
          'application/json': {
            schema: schemaHelper.refFor(operation.name, 'Input') ?? { type: 'object' },
          },
        },
      };
    }

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
  const infoBlock = applyDiscoveryInfo({ title, version }, options?.discoveryInfo);
  const registry = options?.registry ?? createLiveOperationRegistry();
  const restBindings = options?.restBindings;

  const paths: Record<string, Record<string, unknown>> = {};
  const tagSet = new Set<string>();
  const schemaHelper = extractComponentsSchemas(registry);

  // REST_BINDINGS win against any stale ROUTES entry covering the same
  // (method, path) — a migrated operation owns its OpenAPI description.
  const boundMethodPaths = emitBindings(paths, tagSet, restBindings, registry, schemaHelper);
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
    info: infoBlock,
    paths,
    tags,
    security,
    components: {
      schemas: {
        ...schemaHelper.components,
        Error: ERROR_SCHEMA,
      },
      securitySchemes: emittedSecuritySchemes,
    },
  };

  if (options?.serverUrl) {
    document['servers'] = [{ url: options.serverUrl }];
  }
  if (options?.discoveryInfo?.externalDocs !== undefined) {
    document['externalDocs'] = { ...options.discoveryInfo.externalDocs };
  }

  return document;
}
