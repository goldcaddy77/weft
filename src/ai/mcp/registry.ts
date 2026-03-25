import type { ToolDefinition } from '../providers/types';

export interface RegistryTool {
  definition: ToolDefinition;
  execute: (input: unknown) => Promise<unknown>;
  source: 'local' | 'mcp';
  serverUrl?: string;
}

export class ToolRegistry {
  #tools: Map<string, RegistryTool[]> = new Map();

  /** Register a local function as a tool. */
  registerLocal(definition: ToolDefinition, execute: (input: unknown) => Promise<unknown>): void {
    const entry: RegistryTool = { definition, execute, source: 'local' };
    const existing = this.#tools.get(definition.name);

    if (existing) {
      existing.push(entry);
    } else {
      this.#tools.set(definition.name, [entry]);
    }
  }

  /** Register tools from an MCP server. */
  registerMCP(
    tools: ToolDefinition[],
    serverUrl: string,
    execute: (toolName: string, input: unknown) => Promise<unknown>,
  ): void {
    for (const definition of tools) {
      const entry: RegistryTool = {
        definition,
        execute: (input: unknown) => execute(definition.name, input),
        source: 'mcp',
        serverUrl,
      };

      const existing = this.#tools.get(definition.name);

      if (existing) {
        existing.push(entry);
      } else {
        this.#tools.set(definition.name, [entry]);
      }
    }
  }

  /** Get a tool by name. Returns the first registered entry. */
  get(name: string): RegistryTool | undefined {
    const entries = this.#tools.get(name);
    return entries?.[0];
  }

  /** Get all tool definitions. */
  getDefinitions(): ToolDefinition[] {
    return this.getAll().map((tool) => tool.definition);
  }

  /** Get all registered tools. */
  getAll(): RegistryTool[] {
    const result: RegistryTool[] = [];

    for (const entries of this.#tools.values()) {
      // Only include the first entry per name (the effective tool)
      if (entries[0]) {
        result.push(entries[0]);
      }
    }

    return result;
  }

  /** Check for name conflicts between local and MCP tools. Throws ToolNameConflictError. */
  validate(): void {
    for (const [name, entries] of this.#tools) {
      if (entries.length <= 1) continue;

      const sources = new Set<string>();

      for (const entry of entries) {
        sources.add(entry.source === 'local' ? 'local' : (entry.serverUrl ?? 'mcp'));
      }

      if (sources.size > 1) {
        throw new ToolNameConflictError(name, [...sources]);
      }
    }
  }

  get size(): number {
    return this.#tools.size;
  }
}

export class ToolNameConflictError extends Error {
  readonly toolName: string;
  readonly sources: string[];

  constructor(toolName: string, sources: string[]) {
    super(
      `Tool name conflict: "${toolName}" is registered from multiple sources: ${sources.join(', ')}`,
    );
    this.name = 'ToolNameConflictError';
    this.toolName = toolName;
    this.sources = sources;
  }
}
