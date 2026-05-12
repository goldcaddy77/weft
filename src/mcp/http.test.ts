import { afterEach, describe, expect, it } from 'bun:test';
import { z } from 'zod';

import { Engine } from '../core/engine.ts';
import { tenantFromInputField } from '../core/tenant.ts';
import type { WorkflowContext } from '../core/types.ts';
import { signJWT } from '../server/authentication.ts';
import { serve, type WeftServer } from '../server/index.ts';
import { MemoryStorage } from '../storage/memory.ts';
import { waitForRealTimersForTesting } from '../testing/fake-timers.ts';
import { handleMcpHttpRequest } from './http.ts';
import { createMcpSessionManager } from './session.ts';

const MCP_PROTOCOL_VERSION = '2025-11-25';
const TEST_SECRET = 'mcp-test-secret-at-least-32-chars';

type JsonRpcEnvelope = {
  jsonrpc: '2.0';
  id?: string | number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
};

type ToolCallResult = {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
};

function createEngine(): Engine {
  const engine = new Engine({
    storage: new MemoryStorage(),
    tenantResolver: tenantFromInputField('tenantId'),
  });

  engine.register('greet-customer', {
    description: 'Greet a customer by name.',
    inputSchema: z.object({
      tenantId: z.string().optional(),
      name: z.string(),
    }),
    handler: async function* (_context: WorkflowContext, input: { name: string }) {
      return { message: `Hello, ${input.name}!` };
    },
  });

  engine.register('hold-for-cancel', {
    description: 'Wait for a release signal.',
    inputSchema: z.object({
      tenantId: z.string().optional(),
      label: z.string().optional(),
    }),
    handler: async function* (context: WorkflowContext) {
      return yield* context.waitForSignal<string>('release');
    },
  });

  engine.registerActivity('internal-only-activity', async () => 'not exposed');

  return engine;
}

async function waitForStatus(
  engine: Engine,
  workflowId: string,
  status: 'running' | 'completed' | 'cancelled',
): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const state = await engine.get(workflowId);
    if (state?.status === status) return;
    await waitForRealTimersForTesting(10);
  }
  throw new Error(`workflow ${workflowId} did not reach ${status}`);
}

async function initialize(server: WeftServer, headers?: HeadersInit): Promise<string> {
  const requestHeaders = new Headers(headers);
  requestHeaders.set('accept', 'application/json, text/event-stream');
  requestHeaders.set('content-type', 'application/json');
  const response = await fetch(`${server.url}/mcp`, {
    method: 'POST',
    headers: requestHeaders,
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'weft-test-client', version: '1.0.0' },
      },
    }),
  });

  expect(response.status).toBe(200);
  const sessionId = response.headers.get('Mcp-Session-Id');
  expect(sessionId).toBeTruthy();

  const body = (await response.json()) as JsonRpcEnvelope;
  expect(body.error).toBeUndefined();
  expect(body.result).toMatchObject({
    protocolVersion: MCP_PROTOCOL_VERSION,
    capabilities: {
      tools: expect.any(Object),
      resources: expect.objectContaining({ subscribe: true }),
      logging: expect.any(Object),
      prompts: expect.any(Object),
    },
    serverInfo: { name: 'weft' },
  });

  return sessionId!;
}

async function mcpPost(
  server: WeftServer,
  sessionId: string,
  message: Record<string, unknown>,
  headers?: HeadersInit,
): Promise<Response> {
  const requestHeaders = new Headers(headers);
  requestHeaders.set('accept', 'application/json, text/event-stream');
  requestHeaders.set('content-type', 'application/json');
  requestHeaders.set('Mcp-Session-Id', sessionId);
  requestHeaders.set('Mcp-Protocol-Version', MCP_PROTOCOL_VERSION);
  return fetch(`${server.url}/mcp`, {
    method: 'POST',
    headers: requestHeaders,
    body: JSON.stringify(message),
  });
}

async function mcpJson(
  server: WeftServer,
  sessionId: string,
  message: Record<string, unknown>,
  headers?: HeadersInit,
): Promise<JsonRpcEnvelope> {
  const response = await mcpPost(server, sessionId, message, headers);
  expect(response.status).toBe(200);
  return (await response.json()) as JsonRpcEnvelope;
}

function parseToolText(result: unknown): unknown {
  const toolResult = result as ToolCallResult;
  expect(toolResult.isError).not.toBe(true);
  expect(toolResult.content[0]?.type).toBe('text');
  return JSON.parse(toolResult.content[0]!.text);
}

describe('MCP Streamable HTTP transport', () => {
  let server: WeftServer | undefined;

  afterEach(async () => {
    await server?.stop();
    server = undefined;
  });

  it('initializes a session, lists tools, calls a registered workflow tool, and hides activities', async () => {
    const engine = createEngine();
    server = serve({ engine, port: 0 });
    const sessionId = await initialize(server);

    const tools = await mcpJson(server, sessionId, {
      jsonrpc: '2.0',
      id: 'tools',
      method: 'tools/list',
      params: {},
    });

    const names = ((tools.result as { tools: Array<{ name: string }> }).tools ?? []).map(
      (tool) => tool.name,
    );
    expect(names).toContain('greet_customer');
    expect(names).toContain('start_workflow');
    expect(names).toContain('cancel_workflow');
    expect(names).not.toContain('internal_only_activity');

    const greetTool = (
      tools.result as { tools: Array<{ name: string; inputSchema: unknown }> }
    ).tools.find((tool) => tool.name === 'greet_customer');
    expect(greetTool?.inputSchema).toMatchObject({
      type: 'object',
      properties: expect.objectContaining({ name: expect.any(Object) }),
    });

    const called = await mcpJson(server, sessionId, {
      jsonrpc: '2.0',
      id: 'call',
      method: 'tools/call',
      params: { name: 'greet_customer', arguments: { name: 'Ada' } },
    });

    expect(parseToolText(called.result)).toMatchObject({
      result: { message: 'Hello, Ada!' },
      workflowId: expect.any(String),
    });
  });

  it('reads workflow resources and emits resource update notifications for subscriptions', async () => {
    const engine = createEngine();
    server = serve({ engine, port: 0 });
    const sessionId = await initialize(server);

    const handle = await engine.start('hold-for-cancel', { label: 'resource-test' });
    await waitForStatus(engine, handle.id, 'running');
    const uri = `weft://workflows/${handle.id}/state`;

    const read = await mcpJson(server, sessionId, {
      jsonrpc: '2.0',
      id: 'read',
      method: 'resources/read',
      params: { uri },
    });

    const contents = (read.result as { contents: Array<{ uri: string; text: string }> }).contents;
    expect(contents[0]?.uri).toBe(uri);
    expect(JSON.parse(contents[0]!.text)).toMatchObject({
      id: handle.id,
      status: 'running',
    });

    const controller = new AbortController();
    const streamResponse = await fetch(`${server.url}/mcp`, {
      headers: {
        accept: 'text/event-stream',
        'Mcp-Session-Id': sessionId,
        'Mcp-Protocol-Version': MCP_PROTOCOL_VERSION,
      },
      signal: controller.signal,
    });
    expect(streamResponse.status).toBe(200);

    const subscribed = await mcpJson(server, sessionId, {
      jsonrpc: '2.0',
      id: 'subscribe',
      method: 'resources/subscribe',
      params: { uri },
    });
    expect(subscribed.result).toEqual({});

    await engine.signal(handle.id, 'release', 'done');
    await waitForStatus(engine, handle.id, 'completed');

    const notificationText = await readUntil(streamResponse, 'notifications/resources/updated');
    controller.abort();
    expect(notificationText).toContain(uri);
  });

  it('maps MCP cancellation notifications to engine.cancel for an in-flight workflow tool call', async () => {
    const engine = createEngine();
    server = serve({ engine, port: 0 });
    const sessionId = await initialize(server);

    const pendingCall = mcpJson(server, sessionId, {
      jsonrpc: '2.0',
      id: 'pending-tool-call',
      method: 'tools/call',
      params: { name: 'hold_for_cancel', arguments: { label: 'cancel-me' } },
    });

    let workflowId: string | undefined;
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline && workflowId === undefined) {
      const list = await engine.list({ type: 'hold-for-cancel' });
      workflowId = list.items.find((item) => item.status === 'running')?.id;
      if (workflowId === undefined) await waitForRealTimersForTesting(10);
    }
    expect(workflowId).toBeTruthy();

    const cancellation = await mcpPost(server, sessionId, {
      jsonrpc: '2.0',
      method: 'notifications/cancelled',
      params: { requestId: 'pending-tool-call', reason: 'test cancellation' },
    });
    expect(cancellation.status).toBe(202);
    await waitForStatus(engine, workflowId!, 'cancelled');

    const response = await pendingCall;
    const toolResult = response.result as ToolCallResult;
    expect(toolResult.isError).toBe(true);
    expect(toolResult.content[0]?.text).toContain('cancelled');
  });

  it('scopes workflow resources to the authenticated tenant stored on the MCP session', async () => {
    const engine = createEngine();
    const tenantA = await engine.start(
      'greet-customer',
      { tenantId: 'tenant-a', name: 'Ada' },
      { id: 'tenant-a-workflow' },
    );
    const tenantB = await engine.start(
      'greet-customer',
      { tenantId: 'tenant-b', name: 'Grace' },
      { id: 'tenant-b-workflow' },
    );
    await tenantA.result();
    await tenantB.result();

    const token = await signJWT(
      {
        sub: 'tenant-a-user',
        tenantId: 'tenant-a',
        scope: [
          'workflows:read',
          'workflows:write',
          'signals:write',
          'updates:write',
          'queries:read',
          'events:read',
          'system:read',
        ].join(' '),
      },
      TEST_SECRET,
    );

    server = serve({
      engine,
      port: 0,
      auth: { jwt: { secret: TEST_SECRET } },
    });
    const sessionId = await initialize(server, { authorization: `Bearer ${token}` });

    const visible = await mcpJson(
      server,
      sessionId,
      {
        jsonrpc: '2.0',
        id: 'list',
        method: 'tools/call',
        params: { name: 'list_workflows', arguments: {} },
      },
      { authorization: `Bearer ${token}` },
    );
    const listed = parseToolText(visible.result) as { items: Array<{ id: string }> };
    expect(listed.items.map((item) => item.id)).toEqual(['tenant-a-workflow']);

    const denied = await mcpJson(
      server,
      sessionId,
      {
        jsonrpc: '2.0',
        id: 'tenant-b-read',
        method: 'resources/read',
        params: { uri: 'weft://workflows/tenant-b-workflow/state' },
      },
      { authorization: `Bearer ${token}` },
    );
    expect(denied.error?.code).toBe(-32002);
  });

  it('denies anonymous direct-handler requests when authentication is required', async () => {
    const engine = createEngine();
    const sessionManager = createMcpSessionManager(engine);

    try {
      const initialized = await handleMcpHttpRequest({
        request: jsonRequest({
          jsonrpc: '2.0',
          id: 'init',
          method: 'initialize',
          params: { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {} },
        }),
        engine,
        sessionManager,
        authRequired: true,
      });
      expect(initialized.status).toBe(200);
      const sessionId = initialized.headers.get('Mcp-Session-Id');
      expect(sessionId).toBeTruthy();

      const tools = await handleMcpHttpRequest({
        request: jsonRequest(
          { jsonrpc: '2.0', id: 'tools', method: 'tools/list', params: {} },
          sessionId!,
        ),
        engine,
        sessionManager,
        authRequired: true,
      });

      expect(tools.status).toBe(200);
      const envelope = (await tools.json()) as JsonRpcEnvelope;
      expect(envelope.error).toMatchObject({
        code: -32011,
        message: 'MCP request requires authentication',
      });
    } finally {
      await sessionManager[Symbol.asyncDispose]();
    }
  });
});

async function readUntil(response: Response, expectedText: string): Promise<string> {
  const body = response.body;
  if (body === null) throw new Error('SSE response had no body');
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const result = await reader.read();
    if (result.done) break;
    text += decoder.decode(result.value, { stream: true });
    if (text.includes(expectedText)) {
      await reader.cancel();
      return text;
    }
  }
  await reader.cancel();
  throw new Error(`did not receive ${expectedText}`);
}

function jsonRequest(message: Record<string, unknown>, sessionId?: string): Request {
  const headers = new Headers({
    accept: 'application/json, text/event-stream',
    'content-type': 'application/json',
    'Mcp-Protocol-Version': MCP_PROTOCOL_VERSION,
  });
  if (sessionId !== undefined) headers.set('Mcp-Session-Id', sessionId);
  return new Request('http://localhost/mcp', {
    method: 'POST',
    headers,
    body: JSON.stringify(message),
  });
}
