import { describe, expect, it } from 'bun:test';

import { generateAsyncApiDocument } from './asyncapi.ts';
import type { DiscoveryInfo } from './discovery-info.ts';
import { generateOpenApiDocument } from './openapi.ts';
import { generateOpenRpcDocument } from './openrpc.ts';
import { createLiveOperationRegistry } from './rest-bindings.ts';

const discoveryInfo: DiscoveryInfo = {
  description: 'Public Weft API for durable workflows.',
  contact: {
    name: 'Weft Operators',
    url: 'https://api.example.com/support',
    email: 'support@example.com',
  },
  license: {
    name: 'MIT',
    url: 'https://opensource.org/license/mit',
  },
  externalDocs: {
    description: 'Operator guide',
    url: 'https://docs.example.com/weft',
  },
};

describe('DiscoveryInfo', () => {
  it('applies shared discovery metadata to OpenAPI, OpenRPC, and AsyncAPI documents', () => {
    const registry = createLiveOperationRegistry();
    const openApiDocument = generateOpenApiDocument({ registry, discoveryInfo });
    const openRpcDocument = generateOpenRpcDocument({
      registry,
      transports: ['http', 'websocket'],
      discoveryInfo,
    });
    const asyncApiDocument = generateAsyncApiDocument({ registry, discoveryInfo });

    expect(openApiDocument['info']).toEqual(
      expect.objectContaining({
        description: discoveryInfo.description,
        contact: discoveryInfo.contact,
        license: discoveryInfo.license,
        externalDocs: discoveryInfo.externalDocs,
      }),
    );
    expect(openRpcDocument['info']).toEqual(
      expect.objectContaining({
        description: discoveryInfo.description,
        contact: discoveryInfo.contact,
        license: discoveryInfo.license,
        externalDocs: discoveryInfo.externalDocs,
      }),
    );
    expect(asyncApiDocument['info']).toEqual(
      expect.objectContaining({
        description: discoveryInfo.description,
        contact: discoveryInfo.contact,
        license: discoveryInfo.license,
      }),
    );
    expect(asyncApiDocument['externalDocs']).toEqual(discoveryInfo.externalDocs);
  });
});
