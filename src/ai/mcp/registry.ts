import type { ToolIdentityResult } from '../declaration';
import type { ToolDefinition } from '../providers/types';

/**
 * The runtime shape of a tool stored inside a {@link ToolRegistry}. Combines
 * the {@link ToolDefinition} schema with the resolved `execute` function,
 * optional `verify` and semantic `identity` callbacks, and origin metadata
 * (`source` and `serverUrl`) so the agent loop knows where each tool came from.
 *
 * @example Inspect registry entries after tool initialization
 * ```ts
 * import { ToolRegistry, type RegistryTool } from 'weft';
 *
 * const registry = new ToolRegistry();
 * registry.registerLocal(
 *   { name: 'echo', description: 'Echo input back.', inputSchema: { type: 'object' } },
 *   async (input: unknown) => input,
 * );
 *
 * const tools: RegistryTool[] = registry.getAll();
 * console.log(tools[0]?.definition.name, tools[0]?.source); // 'echo', 'local'
 * ```
 */
export interface RegistryTool {
  definition: ToolDefinition;
  execute: (input: unknown) => Promise<unknown>;
  verify?: (result: unknown) => Promise<boolean> | boolean;
  source: 'local' | 'mcp';
  serverUrl?: string;
  /**
   * Optional semantic identity function. When provided, the tool effect log
   * uses the returned hash to deduplicate tool calls across
   * checkpoint-restore cycles. When absent, the full input is hashed.
   */
  identity?: (input: unknown) => ToolIdentityResult;
}

class RegistryToolEntry implements RegistryTool {
  readonly definition: ToolDefinition;
  readonly execute: (input: unknown) => Promise<unknown>;
  readonly verify?: (result: unknown) => Promise<boolean> | boolean;
  readonly source: 'local' | 'mcp';
  readonly serverUrl?: string;
  readonly identity?: (input: unknown) => ToolIdentityResult;
  readonly #localExecute: ((input: unknown) => Promise<unknown>) | undefined;
  readonly #mcpExecute: ((toolName: string, input: unknown) => Promise<unknown>) | undefined;

  constructor(options: {
    definition: ToolDefinition;
    source: 'local' | 'mcp';
    serverUrl?: string;
    localExecute?: (input: unknown) => Promise<unknown>;
    mcpExecute?: (toolName: string, input: unknown) => Promise<unknown>;
    identity?: (input: unknown) => ToolIdentityResult;
    verify?: (result: unknown) => Promise<boolean> | boolean;
  }) {
    this.definition = options.definition;
    this.source = options.source;
    if (options.serverUrl !== undefined) {
      this.serverUrl = options.serverUrl;
    }
    this.#localExecute = options.localExecute;
    this.#mcpExecute = options.mcpExecute;
    if (options.identity !== undefined) {
      this.identity = options.identity;
    }
    if (options.verify !== undefined) {
      this.verify = options.verify;
    }
    this.execute = (input: unknown): Promise<unknown> => {
      if (this.#localExecute) {
        return this.#localExecute(input);
      }

      return this.#mcpExecute!(this.definition.name, input);
    };
  }
}

/**
 * Internal registry that stores local and MCP tools by name, resolves them for
 * the agent loop via {@link ToolRegistry.get}, and validates for name conflicts
 * via {@link ToolRegistry.validate} before the loop starts. Normally constructed
 * by `initializeTools` inside `executeAgentLoop` — use it directly only when
 * building custom agent plumbing.
 *
 * @example Build a registry manually for testing agent plumbing
 * ```ts
 * import { ToolRegistry } from 'weft';
 *
 * const registry = new ToolRegistry();
 *
 * registry.registerLocal(
 *   { name: 'ping', description: 'Returns pong.', inputSchema: { type: 'object' } },
 *   async (_input: unknown) => 'pong',
 * );
 *
 * registry.validate(); // throws ToolNameConflictError if duplicates exist
 * const tool = registry.get('ping');
 * console.log(await tool?.execute({})); // 'pong'
 * ```
 */
export class ToolRegistry {
  #tools: Map<string, RegistryTool[]>;

  constructor() {
    this.#tools = new Map();
  }

  /** Register a local function as a tool. */
  registerLocal(
    definition: ToolDefinition,
    execute: (input: unknown) => Promise<unknown>,
    identity?: (input: unknown) => ToolIdentityResult,
    verify?: (result: unknown) => Promise<boolean> | boolean,
  ): void {
    const entryOptions: {
      definition: ToolDefinition;
      source: 'local';
      localExecute: (input: unknown) => Promise<unknown>;
      identity?: (input: unknown) => ToolIdentityResult;
      verify?: (result: unknown) => Promise<boolean> | boolean;
    } = { definition, source: 'local', localExecute: execute };
    if (identity !== undefined) {
      entryOptions.identity = identity;
    }
    if (verify !== undefined) {
      entryOptions.verify = verify;
    }
    const entry: RegistryTool = new RegistryToolEntry(entryOptions);
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

/**
 * Thrown by {@link ToolRegistry.validate} when the same tool name is registered
 * from more than one source — for example, a local tool and an MCP tool with
 * the same name. Carries the conflicting `toolName` and the list of `sources`.
 *
 * @example Detect and report tool name conflicts early
 * ```ts
 * import { ToolRegistry, ToolNameConflictError } from 'weft';
 *
 * const registry = new ToolRegistry();
 * registry.registerLocal(
 *   { name: 'search', description: 'Local search.', inputSchema: { type: 'object' } },
 *   async () => [],
 * );
 * registry.registerMCP(
 *   [{ name: 'search', description: 'MCP search.', inputSchema: { type: 'object' } }],
 *   'https://tools.example.com/mcp',
 *   async () => [],
 * );
 *
 * try {
 *   registry.validate();
 * } catch (error) {
 *   if (error instanceof ToolNameConflictError) {
 *     console.error(`Conflict on '${error.toolName}': ${error.sources.join(', ')}`);
 *   }
 * }
 * ```
 */
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
