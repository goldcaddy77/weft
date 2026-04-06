import { afterEach, describe, expect, it, spyOn } from 'bun:test';

import type { LLMProvider } from '../providers/interface';
import type { ChatResponse } from '../providers/types';

import type { AgentTool } from '../agent';
import { executeAgentLoop } from '../agent';
import { AgentToolCalledEvent } from '../events';
import { MCPServerUnavailableError } from './client';
import { ToolNameConflictError } from './registry';
import { HttpTransport } from './transport-http';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const originalFetch = globalThis.fetch;

function mockFetch(implementation: (...args: any[]) => Promise<Response>): void {
  const mock = Object.assign(implementation, { preconnect: (_url: string) => {} });
  globalThis.fetch = mock as typeof fetch;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function createMockProvider(responses: ChatResponse[]): LLMProvider {
  let callIndex = 0;
  return {
    name: 'mock',
    async chat(): Promise<ChatResponse> {
      return responses[callIndex++]!;
    },
    async stream() {
      return new ReadableStream();
    },
    async countTokens(): Promise<number> {
      return 100;
    },
  };
}

function createChatResponse(content: string, overrides?: Partial<ChatResponse>): ChatResponse {
  return {
    content,
    toolCalls: [],
    usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
    model: 'test-model',
    stopReason: 'end_turn',
    ...overrides,
  };
}

function createToolCallResponse(
  toolCalls: ChatResponse['toolCalls'],
  overrides?: Partial<ChatResponse>,
): ChatResponse {
  return {
    content: '',
    toolCalls,
    usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
    model: 'test-model',
    stopReason: 'tool_use',
    ...overrides,
  };
}

/** Set up a mock MCP server that responds to health, tools, and invocation requests. */
function setupMockMCPServer(
  serverUrl: string,
  tools: { name: string; description: string; inputSchema: Record<string, unknown> }[],
  invokeHandler: (toolName: string, input: unknown) => unknown,
  options?: { healthStatus?: number; discoverStatus?: number; invokeDelay?: number },
): void {
  const { healthStatus = 200, discoverStatus = 200, invokeDelay = 0 } = options ?? {};

  mockFetch(async (input: any, init: any) => {
    const url = typeof input === 'string' ? input : input.url;

    if (url === `${serverUrl}/health`) {
      return new Response('OK', { status: healthStatus });
    }

    if (url === `${serverUrl}/tools` && (!init?.method || init.method === 'GET')) {
      return new Response(JSON.stringify({ tools }), { status: discoverStatus });
    }

    if (url === `${serverUrl}/tools/invoke` && init?.method === 'POST') {
      if (invokeDelay > 0) {
        await new Promise<void>((resolve, reject) => {
          const signal = init?.signal as AbortSignal | undefined;
          const timer = setTimeout(resolve, invokeDelay);
          if (signal) {
            signal.addEventListener('abort', () => {
              clearTimeout(timer);
              reject(new DOMException('The operation was aborted.', 'AbortError'));
            });
          }
        });
      }

      const body = JSON.parse(init?.body);
      const result = invokeHandler(body.name, body.input);
      return new Response(JSON.stringify({ result }), { status: 200 });
    }

    return new Response('Not Found', { status: 404 });
  });
}

// ---------------------------------------------------------------------------
// F1: MCP server URLs in ctx.agent() tools array
// ---------------------------------------------------------------------------

describe('MCP integration: mixed tools', () => {
  it('discovers tools from MCP server URL and makes them available to the agent', async () => {
    const mcpTools = [
      {
        name: 'web_search',
        description: 'Search the web',
        inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
      },
    ];

    setupMockMCPServer('https://mcp.example.com', mcpTools, (toolName) => {
      if (toolName === 'web_search') {
        return { results: ['result1', 'result2'] };
      }
      return { error: 'Unknown tool' };
    });

    const provider = createMockProvider([
      createToolCallResponse([
        { id: 'call-1', name: 'web_search', input: { query: 'hello world' } },
      ]),
      createChatResponse('Found 2 results for "hello world"'),
    ]);

    const result = await executeAgentLoop(
      {
        model: 'test-model',
        provider,
        tools: [{ mcp: 'https://mcp.example.com' }],
      },
      'Search for hello world',
    );

    expect(result.content).toBe('Found 2 results for "hello world"');
    expect(result.turnCount).toBe(2);
  });

  it('supports both local and MCP tools in the same tools array', async () => {
    const mcpTools = [
      {
        name: 'web_search',
        description: 'Search the web',
        inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
      },
    ];

    const executedTools: string[] = [];

    setupMockMCPServer('https://mcp.example.com', mcpTools, (toolName) => {
      executedTools.push(toolName);
      return { results: ['found'] };
    });

    const localTool: AgentTool = {
      definition: {
        name: 'calculator',
        description: 'Calculate math',
        inputSchema: { type: 'object', properties: { expression: { type: 'string' } } },
      },
      execute: async () => {
        executedTools.push('calculator');
        return { answer: 42 };
      },
    };

    const provider = createMockProvider([
      createToolCallResponse([
        { id: 'call-1', name: 'web_search', input: { query: 'test' } },
        { id: 'call-2', name: 'calculator', input: { expression: '6 * 7' } },
      ]),
      createChatResponse('Both tools used successfully'),
    ]);

    const result = await executeAgentLoop(
      {
        model: 'test-model',
        provider,
        tools: [{ mcp: 'https://mcp.example.com' }, localTool],
      },
      'Search and calculate',
    );

    expect(result.content).toBe('Both tools used successfully');
    expect(executedTools).toContain('web_search');
    expect(executedTools).toContain('calculator');
  });

  it('discovers multiple tools from a single MCP server', async () => {
    const mcpTools = [
      {
        name: 'read_file',
        description: 'Read a file',
        inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
      },
      {
        name: 'write_file',
        description: 'Write a file',
        inputSchema: {
          type: 'object',
          properties: { path: { type: 'string' }, content: { type: 'string' } },
        },
      },
      {
        name: 'list_directory',
        description: 'List directory contents',
        inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
      },
    ];

    setupMockMCPServer('https://mcp.example.com', mcpTools, (toolName) => {
      return { success: true, tool: toolName };
    });

    const provider = createMockProvider([
      createToolCallResponse([{ id: 'call-1', name: 'read_file', input: { path: '/tmp' } }]),
      createChatResponse('Done'),
    ]);

    const result = await executeAgentLoop(
      {
        model: 'test-model',
        provider,
        tools: [{ mcp: 'https://mcp.example.com' }],
      },
      'Read a file',
    );

    expect(result.content).toBe('Done');
    expect(result.turnCount).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// F2: Dynamic tool discovery + name conflict detection
// ---------------------------------------------------------------------------

describe('MCP integration: conflict detection', () => {
  it('throws ToolNameConflictError when MCP tool name conflicts with local tool', async () => {
    const mcpTools = [
      {
        name: 'search',
        description: 'MCP search',
        inputSchema: { type: 'object' },
      },
    ];

    setupMockMCPServer('https://mcp.example.com', mcpTools, () => ({}));

    const localSearchTool: AgentTool = {
      definition: {
        name: 'search',
        description: 'Local search',
        inputSchema: { type: 'object' },
      },
      execute: async () => 'local result',
    };

    const provider = createMockProvider([createChatResponse('Should not reach')]);

    await expect(
      executeAgentLoop(
        {
          model: 'test-model',
          provider,
          tools: [{ mcp: 'https://mcp.example.com' }, localSearchTool],
        },
        'Search something',
      ),
    ).rejects.toThrow(ToolNameConflictError);
  });

  it('detects conflicts at initialization, not at first tool call', async () => {
    const mcpTools = [
      {
        name: 'overlap',
        description: 'MCP overlap tool',
        inputSchema: { type: 'object' },
      },
    ];

    setupMockMCPServer('https://mcp.example.com', mcpTools, () => ({}));

    const localTool: AgentTool = {
      definition: {
        name: 'overlap',
        description: 'Local overlap tool',
        inputSchema: { type: 'object' },
      },
      execute: async () => 'local',
    };

    // Provider that never returns tool calls — if conflict detection happens
    // at call time rather than init time, this would succeed instead of throwing.
    const provider = createMockProvider([createChatResponse('No tools needed')]);

    await expect(
      executeAgentLoop(
        {
          model: 'test-model',
          provider,
          tools: [{ mcp: 'https://mcp.example.com' }, localTool],
        },
        'Hello',
      ),
    ).rejects.toThrow(ToolNameConflictError);
  });

  it('disposes MCP clients when registry.validate() throws ToolNameConflictError', async () => {
    // Regression: registry.validate() was previously called outside the try-catch
    // block in initializeTools(). A ToolNameConflictError caused MCP clients that
    // had already been created to leak — their transports were never disposed.
    const mcpTools = [
      {
        name: 'conflicting_tool',
        description: 'MCP tool whose name collides with a local tool',
        inputSchema: { type: 'object' },
      },
    ];

    setupMockMCPServer('https://mcp.example.com', mcpTools, () => ({}));

    const localTool: AgentTool = {
      definition: {
        name: 'conflicting_tool',
        description: 'Local tool with the same name',
        inputSchema: { type: 'object' },
      },
      execute: async () => 'local result',
    };

    const provider = createMockProvider([createChatResponse('Should not reach')]);

    // Spy on HttpTransport[Symbol.dispose] to verify the transport is torn down
    // even though the error is thrown after the client was already constructed.
    const disposeSpy = spyOn(HttpTransport.prototype, Symbol.dispose as unknown as never);

    try {
      await expect(
        executeAgentLoop(
          {
            model: 'test-model',
            provider,
            tools: [{ mcp: 'https://mcp.example.com' }, localTool],
          },
          'Use the tool',
        ),
      ).rejects.toThrow(ToolNameConflictError);

      expect(disposeSpy).toHaveBeenCalledTimes(1);
    } finally {
      disposeSpy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// F3: Schema validation at engine level
// ---------------------------------------------------------------------------

describe('MCP integration: schema validation', () => {
  it('throws ToolSchemaValidationError when MCP tool input has wrong type', async () => {
    const mcpTools = [
      {
        name: 'typed_search',
        description: 'Search with typed input',
        inputSchema: {
          type: 'object',
          properties: { query: { type: 'string' } },
          required: ['query'],
        },
      },
    ];

    setupMockMCPServer('https://mcp.example.com', mcpTools, () => ({}));

    const provider = createMockProvider([
      // LLM sends wrong type: number instead of string
      createToolCallResponse([{ id: 'call-1', name: 'typed_search', input: { query: 123 } }]),
      createChatResponse('Handled validation error'),
    ]);

    // Schema validation errors should be returned as tool error results,
    // not thrown — the agent loop should continue so the LLM can recover.
    const toolReturned: { toolName: string; success: boolean }[] = [];

    const result = await executeAgentLoop(
      {
        model: 'test-model',
        provider,
        tools: [{ mcp: 'https://mcp.example.com' }],
        onToolReturned: (info) =>
          toolReturned.push({ toolName: info.toolName, success: info.success }),
      },
      'Search for something',
    );

    expect(result.content).toBe('Handled validation error');
    expect(toolReturned).toHaveLength(1);
    expect(toolReturned[0]!.success).toBe(false);
  });

  it('passes validation when MCP tool input matches schema', async () => {
    const mcpTools = [
      {
        name: 'typed_search',
        description: 'Search with typed input',
        inputSchema: {
          type: 'object',
          properties: { query: { type: 'string' } },
          required: ['query'],
        },
      },
    ];

    setupMockMCPServer('https://mcp.example.com', mcpTools, (_toolName, input) => {
      return { results: [`found: ${(input as any).query}`] };
    });

    const provider = createMockProvider([
      createToolCallResponse([
        { id: 'call-1', name: 'typed_search', input: { query: 'valid string' } },
      ]),
      createChatResponse('Search succeeded'),
    ]);

    const toolReturned: { toolName: string; success: boolean }[] = [];

    const result = await executeAgentLoop(
      {
        model: 'test-model',
        provider,
        tools: [{ mcp: 'https://mcp.example.com' }],
        onToolReturned: (info) =>
          toolReturned.push({ toolName: info.toolName, success: info.success }),
      },
      'Search for something',
    );

    expect(result.content).toBe('Search succeeded');
    expect(toolReturned).toHaveLength(1);
    expect(toolReturned[0]!.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// F5: MCP results annotated with source field
// ---------------------------------------------------------------------------

describe('MCP integration: source annotation on events', () => {
  it('annotates MCP tool events with source "mcp"', async () => {
    const mcpTools = [
      {
        name: 'mcp_tool',
        description: 'An MCP tool',
        inputSchema: { type: 'object' },
      },
    ];

    setupMockMCPServer('https://mcp.example.com', mcpTools, () => ({ ok: true }));

    const provider = createMockProvider([
      createToolCallResponse([{ id: 'call-1', name: 'mcp_tool', input: {} }]),
      createChatResponse('Done'),
    ]);

    const eventTarget = new EventTarget();
    const toolCalledEvents: AgentToolCalledEvent[] = [];

    eventTarget.addEventListener(AgentToolCalledEvent.type, (event) => {
      toolCalledEvents.push(event as AgentToolCalledEvent);
    });

    await executeAgentLoop(
      {
        model: 'test-model',
        provider,
        tools: [{ mcp: 'https://mcp.example.com' }],
        eventTarget,
        workflowId: 'wf-source-test',
        agentId: 'agent-source-test',
      },
      'Use MCP tool',
    );

    expect(toolCalledEvents).toHaveLength(1);
    expect(toolCalledEvents[0]!.source).toBe('mcp');
  });

  it('annotates local tool events with source "local"', async () => {
    // No MCP server needed — just a local tool with event tracking.
    const localTool: AgentTool = {
      definition: {
        name: 'local_tool',
        description: 'A local tool',
        inputSchema: { type: 'object' },
      },
      execute: async () => 'local result',
    };

    const provider = createMockProvider([
      createToolCallResponse([{ id: 'call-1', name: 'local_tool', input: {} }]),
      createChatResponse('Done'),
    ]);

    const eventTarget = new EventTarget();
    const toolCalledEvents: AgentToolCalledEvent[] = [];

    eventTarget.addEventListener(AgentToolCalledEvent.type, (event) => {
      toolCalledEvents.push(event as AgentToolCalledEvent);
    });

    await executeAgentLoop(
      {
        model: 'test-model',
        provider,
        tools: [localTool],
        eventTarget,
        workflowId: 'wf-local-source',
        agentId: 'agent-local-source',
      },
      'Use local tool',
    );

    expect(toolCalledEvents).toHaveLength(1);
    expect(toolCalledEvents[0]!.source).toBe('local');
  });

  it('correctly distinguishes sources when both local and MCP tools are used', async () => {
    const mcpTools = [
      {
        name: 'remote_search',
        description: 'Remote search',
        inputSchema: { type: 'object' },
      },
    ];

    setupMockMCPServer('https://mcp.example.com', mcpTools, () => ({ found: true }));

    const localTool: AgentTool = {
      definition: {
        name: 'local_calc',
        description: 'Local calculator',
        inputSchema: { type: 'object' },
      },
      execute: async () => ({ answer: 42 }),
    };

    const provider = createMockProvider([
      createToolCallResponse([
        { id: 'call-1', name: 'remote_search', input: {} },
        { id: 'call-2', name: 'local_calc', input: {} },
      ]),
      createChatResponse('Both done'),
    ]);

    const eventTarget = new EventTarget();
    const toolCalledEvents: AgentToolCalledEvent[] = [];

    eventTarget.addEventListener(AgentToolCalledEvent.type, (event) => {
      toolCalledEvents.push(event as AgentToolCalledEvent);
    });

    await executeAgentLoop(
      {
        model: 'test-model',
        provider,
        tools: [{ mcp: 'https://mcp.example.com' }, localTool],
        eventTarget,
        workflowId: 'wf-mixed-source',
        agentId: 'agent-mixed-source',
      },
      'Use both tools',
    );

    expect(toolCalledEvents).toHaveLength(2);

    const mcpEvent = toolCalledEvents.find((e) => e.toolName === 'remote_search');
    const localEvent = toolCalledEvents.find((e) => e.toolName === 'local_calc');

    expect(mcpEvent!.source).toBe('mcp');
    expect(localEvent!.source).toBe('local');
  });
});

// ---------------------------------------------------------------------------
// F6: Auth, health check, timeout
// ---------------------------------------------------------------------------

describe('MCP integration: auth', () => {
  it('sends auth headers with MCP requests when auth is configured', async () => {
    let capturedAuthHeader: string | null = null;

    mockFetch(async (input: any, init: any) => {
      const url = typeof input === 'string' ? input : input.url;
      const headers = new Headers(init?.headers);

      if (url.includes('/health')) {
        return new Response('OK', { status: 200 });
      }

      if (url.includes('/tools') && (!init?.method || init.method === 'GET')) {
        capturedAuthHeader = headers.get('Authorization');
        return new Response(JSON.stringify({ tools: [] }), { status: 200 });
      }

      return new Response('Not Found', { status: 404 });
    });

    const provider = createMockProvider([createChatResponse('No tools')]);

    await executeAgentLoop(
      {
        model: 'test-model',
        provider,
        tools: [
          {
            mcp: 'https://mcp.example.com',
            auth: { type: 'bearer', token: 'secret-token-123' },
          },
        ],
      },
      'Hello',
    );

    expect(capturedAuthHeader).not.toBeNull();
    expect(capturedAuthHeader!).toBe('Bearer secret-token-123');
  });
});

describe('MCP integration: health check', () => {
  it('throws MCPServerUnavailableError when MCP server health check fails', async () => {
    mockFetch(async (input: any) => {
      const url = typeof input === 'string' ? input : input.url;

      if (url.includes('/health')) {
        return new Response('Service Unavailable', { status: 503 });
      }

      return new Response('Not Found', { status: 404 });
    });

    const provider = createMockProvider([createChatResponse('Should not reach')]);

    await expect(
      executeAgentLoop(
        {
          model: 'test-model',
          provider,
          tools: [{ mcp: 'https://unreachable.example.com' }],
        },
        'Hello',
      ),
    ).rejects.toThrow(MCPServerUnavailableError);
  });

  it('throws MCPServerUnavailableError when MCP server is unreachable', async () => {
    mockFetch(async (input: any) => {
      const url = typeof input === 'string' ? input : input.url;

      if (url.includes('/health')) {
        throw new Error('Connection refused');
      }

      return new Response('Not Found', { status: 404 });
    });

    const provider = createMockProvider([createChatResponse('Should not reach')]);

    await expect(
      executeAgentLoop(
        {
          model: 'test-model',
          provider,
          tools: [{ mcp: 'https://unreachable.example.com' }],
        },
        'Hello',
      ),
    ).rejects.toThrow(MCPServerUnavailableError);
  });
});

describe('MCP integration: timeout', () => {
  it('reports MCPToolTimeoutError as a failed tool result when MCP tool exceeds timeout', async () => {
    const mcpTools = [
      {
        name: 'slow_tool',
        description: 'A very slow tool',
        inputSchema: { type: 'object' },
      },
    ];

    // Setup fetch to handle health/discover normally but hang on invoke
    mockFetch(async (input: any, init: any) => {
      const url = typeof input === 'string' ? input : input.url;

      if (url === 'https://mcp.example.com/health') {
        return new Response('OK', { status: 200 });
      }

      if (url === 'https://mcp.example.com/tools' && (!init?.method || init.method === 'GET')) {
        return new Response(JSON.stringify({ tools: mcpTools }), { status: 200 });
      }

      if (url === 'https://mcp.example.com/tools/invoke' && init?.method === 'POST') {
        // Simulate a slow response — wait for abort
        await new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new DOMException('The operation was aborted.', 'AbortError'));
          });
        });
        return new Response('ok');
      }

      return new Response('Not Found', { status: 404 });
    });

    const provider = createMockProvider([
      createToolCallResponse([{ id: 'call-1', name: 'slow_tool', input: {} }]),
      createChatResponse('Tool timed out, handled gracefully'),
    ]);

    const toolReturned: { toolName: string; success: boolean }[] = [];

    // The timeout error is caught by the agent loop and returned as a failed
    // tool result so the LLM can recover, matching the pattern for all tool errors.
    const result = await executeAgentLoop(
      {
        model: 'test-model',
        provider,
        tools: [{ mcp: 'https://mcp.example.com', timeout: 50 }],
        onToolReturned: (info) =>
          toolReturned.push({ toolName: info.toolName, success: info.success }),
      },
      'Use the slow tool',
    );

    expect(result.content).toBe('Tool timed out, handled gracefully');
    expect(toolReturned).toHaveLength(1);
    expect(toolReturned[0]!.toolName).toBe('slow_tool');
    expect(toolReturned[0]!.success).toBe(false);
  });
});
