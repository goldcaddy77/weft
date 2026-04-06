import { describe, expect, it } from 'bun:test';

import type { ToolDefinition } from '../providers/types';

import { ToolNameConflictError, ToolRegistry } from './registry';

function createToolDefinition(name: string): ToolDefinition {
  return {
    name,
    description: `Tool: ${name}`,
    inputSchema: { type: 'object', properties: {} },
  };
}

describe('ToolRegistry', () => {
  it('registers a local tool', () => {
    const registry = new ToolRegistry();
    const definition = createToolDefinition('calculator');
    const execute = async (input: unknown) => input;

    registry.registerLocal(definition, execute);

    expect(registry.size).toBe(1);
    const tool = registry.get('calculator');
    expect(tool).toBeDefined();
    expect(tool!.source).toBe('local');
    expect(tool!.definition).toBe(definition);
  });

  it('keeps local execute detached from the registry entry instance', async () => {
    const registry = new ToolRegistry();

    registry.registerLocal(createToolDefinition('calculator'), async (input) => input);

    const { execute } = registry.get('calculator')!;
    expect(await execute({ value: 42 })).toEqual({ value: 42 });
  });

  it('registers MCP tools', () => {
    const registry = new ToolRegistry();
    const tools = [createToolDefinition('search'), createToolDefinition('fetch')];
    const execute = async (_toolName: string, input: unknown) => input;

    registry.registerMCP(tools, 'https://mcp.example.com', execute);

    expect(registry.size).toBe(2);
    const searchTool = registry.get('search');
    expect(searchTool).toBeDefined();
    expect(searchTool!.source).toBe('mcp');
    expect(searchTool!.serverUrl).toBe('https://mcp.example.com');
  });

  it('invokes wrapped MCP execute handlers with the tool name and input', async () => {
    const registry = new ToolRegistry();
    const calls: Array<{ toolName: string; input: unknown }> = [];

    registry.registerMCP(
      [createToolDefinition('search')],
      'https://mcp.example.com',
      async (toolName, input) => {
        calls.push({ toolName, input });
        return { ok: true };
      },
    );

    const { execute } = registry.get('search')!;
    expect(await execute({ query: 'weather' })).toEqual({ ok: true });
    expect(calls).toEqual([{ toolName: 'search', input: { query: 'weather' } }]);
  });

  it('returns undefined for unknown tool names', () => {
    const registry = new ToolRegistry();

    expect(registry.get('nonexistent')).toBeUndefined();
  });

  it('returns all tool definitions via getDefinitions', () => {
    const registry = new ToolRegistry();
    const localDef = createToolDefinition('local-tool');
    const mcpDefs = [createToolDefinition('mcp-tool')];

    registry.registerLocal(localDef, async () => null);
    registry.registerMCP(mcpDefs, 'https://mcp.example.com', async () => null);

    const definitions = registry.getDefinitions();
    expect(definitions).toHaveLength(2);

    const names = definitions.map((d) => d.name);
    expect(names).toContain('local-tool');
    expect(names).toContain('mcp-tool');
  });

  it('throws ToolNameConflictError when local and MCP tools share a name', () => {
    const registry = new ToolRegistry();

    registry.registerLocal(createToolDefinition('conflict'), async () => null);
    registry.registerMCP(
      [createToolDefinition('conflict')],
      'https://mcp.example.com',
      async () => null,
    );

    expect(() => registry.validate()).toThrow(ToolNameConflictError);
  });

  it('reports the correct size', () => {
    const registry = new ToolRegistry();

    expect(registry.size).toBe(0);

    registry.registerLocal(createToolDefinition('a'), async () => null);
    registry.registerLocal(createToolDefinition('b'), async () => null);

    expect(registry.size).toBe(2);
  });

  it('does not conflict when same-source tools have different names', () => {
    const registry = new ToolRegistry();

    registry.registerLocal(createToolDefinition('tool-a'), async () => null);
    registry.registerLocal(createToolDefinition('tool-b'), async () => null);

    expect(() => registry.validate()).not.toThrow();
  });

  it('returns all registered tools via getAll', () => {
    const registry = new ToolRegistry();

    registry.registerLocal(createToolDefinition('local'), async () => null);
    registry.registerMCP(
      [createToolDefinition('remote')],
      'https://mcp.example.com',
      async () => null,
    );

    const all = registry.getAll();
    expect(all).toHaveLength(2);
  });
});

describe('ToolNameConflictError', () => {
  it('stores toolName and sources', () => {
    const error = new ToolNameConflictError('conflict', ['local', 'https://mcp.example.com']);

    expect(error).toBeInstanceOf(Error);
    expect(error.toolName).toBe('conflict');
    expect(error.sources).toEqual(['local', 'https://mcp.example.com']);
    expect(error.message).toContain('conflict');
  });
});
