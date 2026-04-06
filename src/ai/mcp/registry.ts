import type { ToolDefinition } from '../providers/types';

export interface RegistryTool {
  definition: ToolDefinition;
  execute: (input: unknown) => Promise<unknown>;
  source: 'local' | 'mcp';
  serverUrl?: string;
}

class RegistryToolEntry implements RegistryTool {
  readonly definition: ToolDefinition;
  readonly source: 'local' | 'mcp';
  readonly serverUrl?: string;
  readonly #localExecute: ((input: unknown) => Promise<unknown>) | undefined;
  readonly #mcpExecute: ((toolName: string, input: unknown) => Promise<unknown>) | undefined;

  constructor(options: {
    definition: ToolDefinition;
    source: 'local' | 'mcp';
    serverUrl?: string;
    localExecute?: (input: unknown) => Promise<unknown>;
    mcpExecute?: (toolName: string, input: unknown) => Promise<unknown>;
  }) {
    this.definition = options.definition;
    this.source = options.source;
    if (options.serverUrl !== undefined) {
      this.serverUrl = options.serverUrl;
    }
    this.#localExecute = options.localExecute;
    this.#mcpExecute = options.mcpExecute;
  }

  execute(input: unknown): Promise<unknown> {
    if (this.#localExecute) {
      return this.#localExecute(input);
    }

    return this.#mcpExecute!(this.definition.name, input);
  }
}

export class ToolRegistry {
  #tools: Map<string, RegistryTool[]>;

  constructor() {
    this.#tools = new Map();
  }

  /** Register a local function as a tool. */
  registerLocal(definition: ToolDefinition, execute: (input: unknown) => Promise<unknown>): void {
    const entry: RegistryTool = new RegistryToolEntry({
      definition,
      source: 'local',
      localExecute: execute,
    });
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
      const entry: RegistryTool = new RegistryToolEntry({
        definition,
        source: 'mcp',
        serverUrl,
        mcpExecute: execute,
      });

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
    const definitions: ToolDefinition[] = [];
    for (const tool of this.getAll()) {
      definitions.push(tool.definition);
    }
    return definitions;
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
