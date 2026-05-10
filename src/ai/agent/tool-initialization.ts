import type { ToolIdentityResult } from '../declaration.ts';
import { computeSemanticHash } from '../tool-effect-log.ts';
import type { AgentTool, ToolDescriptor } from './types.ts';

/**
 * A resolved tool entry ready for use in the agent runtime.
 *
 * @internal
 */
export interface RegistryToolEntry {
  definition: ToolDescriptor;
  execute: (input: unknown) => Promise<unknown>;
  verify?: (result: unknown) => Promise<boolean> | boolean;
  identity?: (input: unknown) => ToolIdentityResult;
  source: 'local';
}

class ToolRegistry {
  readonly #tools: Map<string, RegistryToolEntry> = new Map();

  register(tool: RegistryToolEntry): void {
    if (this.#tools.has(tool.definition.name)) {
      throw new Error(`Duplicate tool name: "${tool.definition.name}"`);
    }
    this.#tools.set(tool.definition.name, tool);
  }

  getAll(): RegistryToolEntry[] {
    return [...this.#tools.values()];
  }
}

type InitializeToolsResult = {
  registry: ToolRegistry;
  dispose: () => void;
};

interface LegacyAgentTool {
  definition: {
    name: string;
    description?: string | undefined;
    inputSchema: unknown;
  };
  execute: (input: unknown) => Promise<unknown>;
  verify?: (result: unknown) => Promise<boolean> | boolean;
  identity?: (input: unknown) => ToolIdentityResult;
}

type StaticToolIdentity = Readonly<{
  namespace: string;
  name: string;
  version?: string | undefined;
}>;

function disposeNoop(): void {
  return;
}

/**
 * Process a plain AgentTool array and return a populated registry.
 *
 * @internal
 */
export async function initializeTools(
  tools: ReadonlyArray<unknown>,
  _signal?: AbortSignal,
): Promise<InitializeToolsResult> {
  const registry = new ToolRegistry();
  for (const tool of tools) {
    registry.register(await normalizeTool(tool));
  }

  return {
    registry,
    dispose: disposeNoop,
  };
}

async function normalizeTool(tool: unknown): Promise<RegistryToolEntry> {
  if (isFlatAgentTool(tool)) {
    const execute = await tool.execute;
    const entry: RegistryToolEntry = {
      definition: {
        name: tool.name,
        ...(tool.description !== undefined ? { description: tool.description } : {}),
        input: tool.input,
      },
      execute,
      source: 'local',
    };
    if (tool.verify !== undefined) {
      entry.verify = tool.verify;
    }
    if (typeof tool.identity === 'function') {
      entry.identity = tool.identity;
    } else if (tool.identity !== undefined) {
      entry.identity = staticToolIdentity(tool.identity);
    }
    return entry;
  }

  if (isLegacyAgentTool(tool)) {
    const entry: RegistryToolEntry = {
      definition: {
        name: tool.definition.name,
        ...(tool.definition.description !== undefined
          ? { description: tool.definition.description }
          : {}),
        input: tool.definition.inputSchema,
      },
      execute: tool.execute,
      source: 'local',
    };
    if (tool.verify !== undefined) {
      entry.verify = tool.verify;
    }
    if (tool.identity !== undefined) {
      entry.identity = tool.identity;
    }
    return entry;
  }

  throw new TypeError('Agent tools must be flat tool definitions with name, input, and execute.');
}

function isFlatAgentTool(value: unknown): value is AgentTool {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record['name'] === 'string' &&
    'input' in record &&
    (typeof record['execute'] === 'function' || isPromiseLikeFunction(record['execute']))
  );
}

function isLegacyAgentTool(value: unknown): value is LegacyAgentTool {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  const definition = record['definition'];
  return (
    typeof definition === 'object' &&
    definition !== null &&
    typeof (definition as Record<string, unknown>)['name'] === 'string' &&
    'inputSchema' in definition &&
    typeof record['execute'] === 'function'
  );
}

function isPromiseLikeFunction(
  value: unknown,
): value is Promise<(input: unknown, context?: unknown) => Promise<unknown>> {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Promise<unknown>).then === 'function'
  );
}

function staticToolIdentity(identity: StaticToolIdentity): (input: unknown) => ToolIdentityResult {
  return (input) => ({
    semanticHash: computeSemanticHash({ identity, arguments: input }),
    intentCriticalFields: ['identity', 'arguments'],
  });
}
