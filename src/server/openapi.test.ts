import { describe, expect, it } from 'bun:test';

import { generateOpenApiDocument } from './openapi.ts';
import { ROUTES, toOpenApiPath, toRegex } from './route-model.ts';

describe('OpenAPI document generation', () => {
  const document = generateOpenApiDocument();

  it('produces a valid OpenAPI 3.1 document', () => {
    expect(document).toHaveProperty('openapi', '3.1.0');
    expect(document).toHaveProperty('info');
    expect(document).toHaveProperty('paths');
    expect(document).toHaveProperty('tags');
  });

  it('uses default title and version', () => {
    const info = document['info'] as Record<string, unknown>;
    expect(info['title']).toBe('Weft Workflow Engine');
    expect(info['version']).toBe('0.0.1');
  });

  it('accepts custom options', () => {
    const custom = generateOpenApiDocument({
      title: 'Custom API',
      version: '2.0.0',
      serverUrl: 'https://api.example.com',
    });
    const info = custom['info'] as Record<string, unknown>;
    expect(info['title']).toBe('Custom API');
    expect(info['version']).toBe('2.0.0');
    const servers = custom['servers'] as Array<{ url: string }>;
    expect(servers[0]!.url).toBe('https://api.example.com');
  });

  it('includes all non-meta routes as path items', () => {
    const paths = document['paths'] as Record<string, unknown>;
    const domainRoutes = ROUTES.filter((r) => r.handler !== 'openApiDocument');

    for (const route of domainRoutes) {
      const openApiPath = toOpenApiPath(route.path);
      expect(paths).toHaveProperty(openApiPath);

      const pathItem = paths[openApiPath] as Record<string, unknown>;
      const method = route.method.toLowerCase();
      expect(pathItem).toHaveProperty(method);
    }
  });

  it('correctly extracts path parameters', () => {
    const paths = document['paths'] as Record<string, Record<string, Record<string, unknown>>>;
    const signalPath = paths['/v1/workflows/{id}/signal/{name}'];
    expect(signalPath).toBeDefined();

    const operation = signalPath!['post']!;
    const parameters = operation['parameters'] as Array<{ name: string; in: string }>;
    expect(parameters).toHaveLength(2);
    expect(parameters[0]!.name).toBe('id');
    expect(parameters[0]!.in).toBe('path');
    expect(parameters[1]!.name).toBe('name');
  });

  it('marks step parameter as integer type', () => {
    const paths = document['paths'] as Record<string, Record<string, Record<string, unknown>>>;
    const checkpointPath = paths['/v1/workflows/{id}/checkpoints/{step}'];
    expect(checkpointPath).toBeDefined();

    const operation = checkpointPath!['get']!;
    const parameters = operation['parameters'] as Array<{
      name: string;
      schema: { type: string };
    }>;
    const stepParam = parameters.find((p) => p.name === 'step');
    expect(stepParam!.schema.type).toBe('integer');
  });

  it('marks replay step parameter as integer type', () => {
    const paths = document['paths'] as Record<string, Record<string, Record<string, unknown>>>;
    const replayPath = paths['/v1/workflows/{id}/replay/{step}'];
    expect(replayPath).toBeDefined();

    const operation = replayPath!['get']!;
    const parameters = operation['parameters'] as Array<{
      name: string;
      schema: { type: string };
    }>;
    const stepParam = parameters.find((parameter) => parameter.name === 'step');
    expect(stepParam!.schema.type).toBe('integer');
  });

  it('includes tags sorted alphabetically', () => {
    const tags = document['tags'] as Array<{ name: string }>;
    expect(tags.length).toBeGreaterThan(0);
    const names = tags.map((t) => t.name);
    expect(names).toEqual([...names].toSorted());
  });

  it('adds requestBody for POST/PUT/PATCH routes', () => {
    const paths = document['paths'] as Record<string, Record<string, Record<string, unknown>>>;
    const startPath = paths['/v1/workflows'];
    expect(startPath).toBeDefined();
    const operation = startPath!['post']!;
    expect(operation).toHaveProperty('requestBody');
  });

  it('does not add requestBody for GET routes', () => {
    const paths = document['paths'] as Record<string, Record<string, Record<string, unknown>>>;
    const healthPath = paths['/v1/health'];
    expect(healthPath).toBeDefined();
    const operation = healthPath!['get']!;
    expect(operation).not.toHaveProperty('requestBody');
  });
});

describe('route-model helpers', () => {
  describe('toOpenApiPath', () => {
    it('converts :param to {param}', () => {
      expect(toOpenApiPath('/v1/workflows/:id/signal/:name')).toBe(
        '/v1/workflows/{id}/signal/{name}',
      );
    });

    it('handles paths without parameters', () => {
      expect(toOpenApiPath('/v1/health')).toBe('/v1/health');
    });
  });

  describe('toRegex', () => {
    it('matches a path with parameters', () => {
      const regex = toRegex('/v1/workflows/:id/signal/:name');
      const match = regex.exec('/v1/workflows/abc/signal/done');
      expect(match).not.toBeNull();
      expect(match![1]).toBe('abc');
      expect(match![2]).toBe('done');
    });

    it('rejects non-matching paths', () => {
      const regex = toRegex('/v1/workflows/:id');
      expect(regex.exec('/v1/workflows/abc/extra')).toBeNull();
    });

    it('matches numeric :step parameter', () => {
      const regex = toRegex('/v1/workflows/:id/checkpoints/:step');
      expect(regex.exec('/v1/workflows/abc/checkpoints/42')).not.toBeNull();
      expect(regex.exec('/v1/workflows/abc/checkpoints/notanumber')).toBeNull();
    });

    it('matches paths without parameters', () => {
      const regex = toRegex('/v1/health');
      expect(regex.exec('/v1/health')).not.toBeNull();
      expect(regex.exec('/v1/health/extra')).toBeNull();
    });
  });
});
