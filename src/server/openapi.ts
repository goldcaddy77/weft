/**
 * OpenAPI 3.1 document generator driven from the shared route model.
 *
 * Produces a JSON-serializable OpenAPI document that reflects the exact
 * routes registered in `route-model.ts`. Both `handleRequest()` and
 * `serve()` expose this at `GET /openapi.json`.
 *
 * @module server/openapi
 */

import { ROUTES, toOpenApiPath } from './route-model.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Options for customizing the generated OpenAPI document. */
export type OpenApiOptions = {
  /** API title. Defaults to `'Weft Workflow Engine'`. */
  title?: string;
  /** API version. Defaults to `'0.0.1'`. */
  version?: string;
  /** Server URL. When omitted, no `servers` array is included. */
  serverUrl?: string;
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
export function generateOpenApiDocument(options?: OpenApiOptions): Record<string, unknown> {
  const title = options?.title ?? 'Weft Workflow Engine';
  const version = options?.version ?? '0.0.1';

  const paths: Record<string, Record<string, unknown>> = {};

  for (const route of ROUTES) {
    // Skip the OpenAPI endpoint itself — it's meta, not a domain route.
    if (route.handler === 'openApiDocument') continue;

    const openApiPath = toOpenApiPath(route.path);

    if (!paths[openApiPath]) {
      paths[openApiPath] = {};
    }

    const method = route.method.toLowerCase();
    const parameters = route.paramNames.map((name) => ({
      name,
      in: 'path',
      required: true,
      schema: { type: name === 'step' ? 'integer' : 'string' },
    }));

    const operation: Record<string, unknown> = {
      summary: route.summary,
      operationId: route.handler,
      tags: route.tags,
      responses: {
        '200': { description: 'Successful response' },
      },
    };

    if (parameters.length > 0) {
      operation['parameters'] = parameters;
    }

    // POST/PUT/PATCH routes accept a JSON request body.
    if (route.method === 'POST' || route.method === 'PUT' || route.method === 'PATCH') {
      operation['requestBody'] = {
        content: {
          'application/json': {
            schema: { type: 'object' },
          },
        },
      };
    }

    paths[openApiPath][method] = operation;
  }

  // Collect unique tags for the top-level tags array.
  const tagSet = new Set<string>();
  for (const route of ROUTES) {
    for (const tag of route.tags) {
      tagSet.add(tag);
    }
  }
  const tags = [...tagSet].toSorted().map((name) => ({ name }));

  const document: Record<string, unknown> = {
    openapi: '3.1.0',
    info: { title, version },
    paths,
    tags,
  };

  if (options?.serverUrl) {
    document['servers'] = [{ url: options.serverUrl }];
  }

  return document;
}
