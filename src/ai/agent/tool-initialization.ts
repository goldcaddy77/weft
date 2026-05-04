import { MCPClient, MCPServerUnavailableError } from '../mcp/client.ts';
import { ToolRegistry } from '../mcp/registry.ts';
import { ToolSchemaValidationError, validateSchema } from '../mcp/schema-validator.ts';
import { createTransportForSource } from '../mcp/transport-factory.ts';
import type { AgentTool, MCPToolSource } from './types.ts';

/** Type guard: is the tools entry an MCP server URL source? */
function isMCPToolSource(entry: AgentTool | MCPToolSource): entry is MCPToolSource {
  return 'mcp' in entry && typeof entry.mcp === 'string';
}

type InitializeToolsResult = {
  registry: ToolRegistry;
  /** Dispose all MCP clients and their underlying transports. */
  dispose: () => void;
};

/**
 * Factory that constructs an MCP client for a given tool source. Injectable
 * so tests can substitute a stub that records lifecycle calls.
 *
 * @internal
 */
export type MCPClientFactory = (source: MCPToolSource) => MCPClient | Promise<MCPClient>;

export const defaultMCPClientFactory: MCPClientFactory = async (source) => {
  const transport = await createTransportForSource(source);
  return new MCPClient({ transport, timeout: source.timeout });
};

/**
 * Process a mixed tools array (local `AgentTool` + `MCPToolSource` entries).
 *
 * For each MCP source: health check, discover tools, register in the registry.
 * For each local tool: register in the registry.
 * Finally, validate for name conflicts and return the populated registry.
 *
 * @internal
 */
export async function initializeTools(
  tools: (AgentTool | MCPToolSource)[],
  signal?: AbortSignal,
  createClient: MCPClientFactory = defaultMCPClientFactory,
): Promise<InitializeToolsResult> {
  const registry = new ToolRegistry();
  const clients: MCPClient[] = [];

  try {
    for (const entry of tools) {
      signal?.throwIfAborted();
      if (isMCPToolSource(entry)) {
        const client = await createClient(entry);
        clients.push(client);

        // Health check — fail fast if the server is unreachable
        const healthy = await client.healthCheck();
        if (!healthy) {
          throw new MCPServerUnavailableError(entry.mcp);
        }

        // Discover tools
        const discovered = await client.discoverTools();

        // Pre-index discovered tools by name for O(1) schema lookup
        const schemaIndex = new Map(discovered.map((t) => [t.name, t]));

        // Register MCP tools with a dispatch function that validates input
        // and invokes through the client
        registry.registerMCP(discovered, entry.mcp, async (toolName: string, input: unknown) => {
          const toolDef = schemaIndex.get(toolName);
          if (toolDef && Object.keys(toolDef.inputSchema).length > 0) {
            const validation = validateSchema(input, toolDef.inputSchema);
            if (!validation.valid) {
              throw new ToolSchemaValidationError(toolName, validation.errors);
            }
          }

          return client.invokeTool(toolName, input, signal);
        });
      } else {
        registry.registerLocal(entry.definition, entry.execute, entry.identity, entry.verify);
      }
    }

    // Validate for name conflicts before the agent loop starts. Must stay
    // inside the try block so that a ToolNameConflictError (or any other
    // validation failure) triggers the catch-block disposal of already-
    // created MCP clients.
    registry.validate();
  } catch (error) {
    // Dispose all clients on any initialization failure
    for (const client of clients) client[Symbol.dispose]();
    throw error;
  }

  const dispose = () => {
    for (const client of clients) client[Symbol.dispose]();
  };

  return { registry, dispose };
}

// ---------------------------------------------------------------------------
// executeAgentLoop
// ---------------------------------------------------------------------------
