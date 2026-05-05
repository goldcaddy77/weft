import type { ToolIdentityResult } from '../declaration.ts';
import type { AgentTool, ToolDefinition } from './types.ts';

/**
 * A resolved tool entry ready for use in the agent runtime.
 *
 * @internal
 */
export interface RegistryToolEntry {
  definition: ToolDefinition;
  execute: (input: unknown) => Promise<unknown>;
  verify?: (result: unknown) => Promise<boolean> | boolean;
  identity?: (input: unknown) => ToolIdentityResult;
  source: 'local';
}

class ToolRegistry {
  readonly #tools: Map<string, RegistryToolEntry> = new Map();

  register(tool: AgentTool): void {
    if (this.#tools.has(tool.definition.name)) {
      throw new Error(`Duplicate tool name: "${tool.definition.name}"`);
    }
    const entry: RegistryToolEntry = {
      definition: tool.definition,
      execute: tool.execute,
      source: 'local',
    };
    if (tool.verify !== undefined) {
      entry.verify = tool.verify;
    }
    if (tool.identity !== undefined) {
      entry.identity = tool.identity;
    }
    this.#tools.set(tool.definition.name, entry);
  }

  getAll(): RegistryToolEntry[] {
    return [...this.#tools.values()];
  }
}

type InitializeToolsResult = {
  registry: ToolRegistry;
  dispose: () => void;
};

function disposeNoop(): void {
  return;
}

/**
 * Process a plain AgentTool array and return a populated registry.
 *
 * @internal
 */
export async function initializeTools(
  tools: AgentTool[],
  _signal?: AbortSignal,
): Promise<InitializeToolsResult> {
  const registry = new ToolRegistry();
  for (const tool of tools) {
    registry.register(tool);
  }

  return {
    registry,
    dispose: disposeNoop,
  };
}
