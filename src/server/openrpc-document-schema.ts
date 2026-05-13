/**
 * Minimal committed Zod schema for the OpenRPC document shape that Weft emits.
 *
 * @module server/openrpc-document-schema
 */
import { z } from 'zod';

export const ContentDescriptorSchema = z.object({
  name: z.string(),
  schema: z.record(z.string(), z.unknown()),
  required: z.boolean(),
});

const OpenRpcMcpMethodMetadataSchema = z.object({
  operationName: z.string(),
  toolDiscovery: z.object({
    method: z.literal('tools/list'),
    source: z.literal('live'),
  }),
});

export const OpenRpcMethodSchema = z.object({
  name: z.string(),
  summary: z.string().optional(),
  tags: z.array(z.object({ name: z.string() })).optional(),
  paramStructure: z.literal('by-name'),
  params: z.array(ContentDescriptorSchema),
  result: ContentDescriptorSchema,
  errors: z.array(z.object({ $ref: z.string() })).optional(),
  'x-weft-mcp': OpenRpcMcpMethodMetadataSchema.optional(),
});

const OpenRpcMcpMetadataSchema = z.object({
  protocol: z.literal('model-context-protocol'),
  protocolVersion: z.string(),
  discoveryPath: z.literal('/.well-known/mcp.json'),
  transports: z.object({
    streamableHttp: z.object({
      path: z.literal('/mcp'),
      methods: z.array(z.enum(['POST', 'GET', 'DELETE'])),
    }),
    stdio: z.object({
      command: z.literal('weft-mcp'),
    }),
  }),
  liveDiscovery: z.object({
    tools: z.object({
      method: z.literal('tools/list'),
      canonical: z.literal(true),
    }),
    resources: z.object({
      listMethod: z.literal('resources/list'),
      templatesMethod: z.literal('resources/templates/list'),
    }),
  }),
  operations: z.array(z.object({ operationName: z.string() })),
});

export const OpenRpcDocumentSchema = z.object({
  openrpc: z.string(),
  info: z.object({
    title: z.string(),
    version: z.string(),
    description: z.string().optional(),
    contact: z
      .object({
        name: z.string().optional(),
        url: z.string().optional(),
        email: z.string().optional(),
      })
      .optional(),
    license: z
      .object({
        name: z.string(),
        url: z.string().optional(),
      })
      .optional(),
    externalDocs: z
      .object({
        description: z.string().optional(),
        url: z.string(),
      })
      .optional(),
  }),
  methods: z.array(OpenRpcMethodSchema),
  components: z
    .object({
      errors: z
        .record(
          z.string(),
          z.object({
            code: z.number(),
            message: z.string(),
            data: z.record(z.string(), z.unknown()).optional(),
            'x-http-status': z.number().optional(),
          }),
        )
        .optional(),
      schemas: z.record(z.string(), z.unknown()).optional(),
    })
    .optional(),
  servers: z.array(z.object({ url: z.string() })).optional(),
  'x-weft-mcp': OpenRpcMcpMetadataSchema.optional(),
});

export type OpenRpcDocument = z.infer<typeof OpenRpcDocumentSchema>;
