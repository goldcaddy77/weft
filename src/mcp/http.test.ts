import { afterEach, describe, expect, it } from 'bun:test';
import { z } from 'zod';

import { Engine } from '../core/engine.ts';
import { tenantFromInputField } from '../core/tenant.ts';
import type { DefinitionSchema, WorkflowContext } from '../core/types.ts';
import { signJWT } from '../server/authentication.ts';
import { serve, type WeftServer } from '../server/index.ts';
import { MemoryStorage } from '../storage/memory.ts';
import { waitForCondition } from '../testing/fake-timers.ts';
import { handleMcpHttpRequest } from './http.ts';
import { createMcpSessionManager, type McpSessionManager } from './session.ts';

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
    handler: async function* (
      context: WorkflowContext,
      input: { tenantId?: string | undefined; label?: string | undefined },
    ) {
      let label = input.label ?? 'initial';
      context.onQuery('label', () => label);
      context.onUpdate('setLabel', (payload) => {
        label = typeof payload === 'string' ? payload : 'updated';
        return label;
      });
      const released = yield* context.waitForSignal<string>('release');
      return { label, released };
    },
  });
  engine.register('hidden-no-schema', async function* () {
    return 'hidden';
  });

  engine.registerActivity('internal-only-activity', async () => 'not exposed');

  return engine;
}

async function waitForStatus(
  engine: Engine,
  workflowId: string,
  status: 'running' | 'completed' | 'cancelled',
): Promise<void> {
  await waitForCondition(
    async () => {
      const state = await engine.get(workflowId);
      return state?.status === status;
    },
    { timeoutMs: 2_000, intervalMs: 10, label: `workflow ${workflowId} to reach ${status}` },
  );
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

  const initialized = await mcpPost(
    server,
    sessionId!,
    {
      jsonrpc: '2.0',
      method: 'notifications/initialized',
    },
    headers,
  );
  expect(initialized.status).toBe(202);

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

function countingDefinitionSchema<TInput = unknown>(
  onInputConversion: () => void,
): DefinitionSchema<unknown, TInput> {
  return {
    '~standard': {
      version: 1,
      vendor: 'counting-test',
      jsonSchema: {
        input: () => {
          onInputConversion();
          return {
            type: 'object',
            properties: { name: { type: 'string' } },
            required: ['name'],
            additionalProperties: false,
          };
        },
        output: () => ({ type: 'object' }),
      },
    },
  };
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
    expect(names).toContain('signal_workflow');
    expect(names).toContain('query_workflow');
    expect(names).toContain('cancel_workflow');
    expect(names).toContain('get_workflow_state');
    expect(names).not.toContain('internal_only_activity');
    expect(names).not.toContain('hidden_no_schema');

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

    const started = await mcpJson(server, sessionId, {
      jsonrpc: '2.0',
      id: 'start-control',
      method: 'tools/call',
      params: {
        name: 'start_workflow',
        arguments: {
          type: 'hold-for-cancel',
          id: 'mcp-control-workflow',
          input: { label: 'initial-label' },
        },
      },
    });
    expect(parseToolText(started.result)).toEqual({ workflowId: 'mcp-control-workflow' });
    await waitForStatus(engine, 'mcp-control-workflow', 'running');

    const queried = await mcpJson(server, sessionId, {
      jsonrpc: '2.0',
      id: 'query-control',
      method: 'tools/call',
      params: {
        name: 'query_workflow',
        arguments: { workflowId: 'mcp-control-workflow', name: 'label' },
      },
    });
    expect(parseToolText(queried.result)).toEqual({ result: 'initial-label' });

    const updated = await mcpJson(server, sessionId, {
      jsonrpc: '2.0',
      id: 'update-control',
      method: 'tools/call',
      params: {
        name: 'update_workflow',
        arguments: {
          workflowId: 'mcp-control-workflow',
          name: 'setLabel',
          payload: 'updated-label',
        },
      },
    });
    expect(parseToolText(updated.result)).toEqual({ result: 'updated-label' });

    const signalled = await mcpJson(server, sessionId, {
      jsonrpc: '2.0',
      id: 'signal-control',
      method: 'tools/call',
      params: {
        name: 'signal_workflow',
        arguments: { workflowId: 'mcp-control-workflow', name: 'release', payload: 'done' },
      },
    });
    expect(parseToolText(signalled.result)).toEqual({ ok: true });
    await waitForStatus(engine, 'mcp-control-workflow', 'completed');

    const state = await mcpJson(server, sessionId, {
      jsonrpc: '2.0',
      id: 'get-control',
      method: 'tools/call',
      params: { name: 'get_workflow_state', arguments: { workflowId: 'mcp-control-workflow' } },
    });
    expect(parseToolText(state.result)).toMatchObject({
      id: 'mcp-control-workflow',
      status: 'completed',
    });

    const failedToolCall = await mcpJson(server, sessionId, {
      jsonrpc: '2.0',
      id: 'bad-tool-call',
      method: 'tools/call',
      params: { name: 'get_workflow_state', arguments: {} },
    });
    expect(failedToolCall.error).toBeUndefined();
    expect((failedToolCall.result as ToolCallResult).isError).toBe(true);
  });

  it('reuses the converted tool registry until workflow definitions change', async () => {
    const engine = new Engine({ storage: new MemoryStorage() });
    let inputConversions = 0;
    engine.register('counted-tool', {
      inputSchema: countingDefinitionSchema<{ name?: string }>(() => {
        inputConversions += 1;
      }),
      handler: async function* (_context: WorkflowContext, input: { name?: string }) {
        return { message: `Hello, ${input.name ?? 'there'}!` };
      },
    });
    server = serve({ engine, port: 0 });
    const sessionId = await initialize(server);

    await mcpJson(server, sessionId, {
      jsonrpc: '2.0',
      id: 'first-list',
      method: 'tools/list',
      params: {},
    });
    await mcpJson(server, sessionId, {
      jsonrpc: '2.0',
      id: 'second-list',
      method: 'tools/list',
      params: {},
    });
    expect(inputConversions).toBe(1);

    const called = await mcpJson(server, sessionId, {
      jsonrpc: '2.0',
      id: 'call-counted-tool',
      method: 'tools/call',
      params: { name: 'counted_tool', arguments: { name: 'Ada' } },
    });
    expect(parseToolText(called.result)).toMatchObject({
      result: { message: 'Hello, Ada!' },
    });
    expect(inputConversions).toBe(1);

    engine.register('late-tool', {
      inputSchema: countingDefinitionSchema(() => {
        inputConversions += 1;
      }),
      handler: async function* () {
        return { ok: true };
      },
    });

    const afterRegistration = await mcpJson(server, sessionId, {
      jsonrpc: '2.0',
      id: 'after-registration',
      method: 'tools/list',
      params: {},
    });
    const names = (
      (afterRegistration.result as { tools: Array<{ name: string }> }).tools ?? []
    ).map((tool) => tool.name);
    expect(names).toContain('late_tool');
    expect(inputConversions).toBe(3);
  });

  it('reads workflow resources and emits resource update notifications for subscriptions', async () => {
    const engine = createEngine();
    server = serve({ engine, port: 0 });
    const sessionId = await initialize(server);

    const handle = await engine.start('hold-for-cancel', { label: 'resource-test' });
    const encodedHandle = await engine.start(
      'hold-for-cancel',
      { label: 'encoded-resource-test' },
      { id: 'workflow with spaces' },
    );
    await waitForStatus(engine, handle.id, 'running');
    await waitForStatus(engine, encodedHandle.id, 'running');
    const uri = `weft://workflows/${handle.id}/state`;
    const encodedUri = `weft://workflows/${encodeURIComponent(encodedHandle.id)}/state`;

    const resources = await mcpJson(server, sessionId, {
      jsonrpc: '2.0',
      id: 'resources-list',
      method: 'resources/list',
      params: {},
    });
    const resourceUris = (
      (resources.result as { resources: Array<{ uri: string }> }).resources ?? []
    ).map((resource) => resource.uri);
    expect(resourceUris).toContain(encodedUri);
    expect(resourceUris).not.toContain(`weft://workflows/${encodedHandle.id}/state`);

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

    const encodedRead = await mcpJson(server, sessionId, {
      jsonrpc: '2.0',
      id: 'read-encoded',
      method: 'resources/read',
      params: { uri: encodedUri },
    });
    const encodedContents = (encodedRead.result as { contents: Array<{ text: string }> }).contents;
    expect(JSON.parse(encodedContents[0]!.text)).toMatchObject({
      id: encodedHandle.id,
      status: 'running',
    });

    const events = await mcpJson(server, sessionId, {
      jsonrpc: '2.0',
      id: 'events',
      method: 'resources/read',
      params: { uri: `weft://workflows/${handle.id}/events` },
    });
    const eventContents = (events.result as { contents: Array<{ text: string }> }).contents;
    expect(JSON.parse(eventContents[0]!.text)).toMatchObject({ events: expect.any(Array) });

    const checkpoints = await mcpJson(server, sessionId, {
      jsonrpc: '2.0',
      id: 'checkpoints',
      method: 'resources/read',
      params: { uri: `weft://workflows/${handle.id}/checkpoints` },
    });
    const checkpointContents = (checkpoints.result as { contents: Array<{ text: string }> })
      .contents;
    expect(JSON.parse(checkpointContents[0]!.text)).toMatchObject({
      checkpoints: expect.any(Array),
    });

    const search = await mcpJson(server, sessionId, {
      jsonrpc: '2.0',
      id: 'search',
      method: 'resources/read',
      params: { uri: 'weft://workflows/search?status=running&type=hold-for-cancel' },
    });
    const searchContents = (search.result as { contents: Array<{ text: string }> }).contents;
    expect(JSON.parse(searchContents[0]!.text)).toMatchObject({
      items: expect.arrayContaining([expect.objectContaining({ id: handle.id })]),
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

    let workflowId = '';
    await waitForCondition(
      async () => {
        const list = await engine.list({ type: 'hold-for-cancel' });
        workflowId = list.items.find((item) => item.status === 'running')?.id ?? '';
        return workflowId.length > 0;
      },
      { timeoutMs: 2_000, intervalMs: 10, label: 'running MCP workflow tool call' },
    );

    const cancellation = await mcpPost(server, sessionId, {
      jsonrpc: '2.0',
      method: 'notifications/cancelled',
      params: { requestId: 'pending-tool-call', reason: 'test cancellation' },
    });
    expect(cancellation.status).toBe(202);
    await waitForStatus(engine, workflowId, 'cancelled');

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
    const tenantASecond = await engine.start(
      'greet-customer',
      { tenantId: 'tenant-a', name: 'Katherine' },
      { id: 'tenant-a-workflow-2' },
    );
    await tenantA.result();
    await tenantB.result();
    await tenantASecond.result();

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
    const readOnlyToken = await signJWT(
      {
        sub: 'tenant-a-user',
        tenantId: 'tenant-a',
        scope: 'workflows:read',
      },
      TEST_SECRET,
    );
    const tenantBToken = await signJWT(
      {
        sub: 'tenant-b-user',
        tenantId: 'tenant-b',
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
    expect(listed.items.map((item) => item.id)).toEqual([
      'tenant-a-workflow',
      'tenant-a-workflow-2',
    ]);

    const secondVisiblePage = await mcpJson(
      server,
      sessionId,
      {
        jsonrpc: '2.0',
        id: 'list-page',
        method: 'tools/call',
        params: { name: 'list_workflows', arguments: { limit: 1, offset: 1 } },
      },
      { authorization: `Bearer ${token}` },
    );
    expect(parseToolText(secondVisiblePage.result)).toMatchObject({
      items: [expect.objectContaining({ id: 'tenant-a-workflow-2' })],
      total: 2,
      offset: 1,
      limit: 1,
    });

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

    const mismatchedPrincipal = await mcpPost(
      server,
      sessionId,
      {
        jsonrpc: '2.0',
        id: 'wrong-principal',
        method: 'tools/list',
        params: {},
      },
      { authorization: `Bearer ${tenantBToken}` },
    );
    expect(mismatchedPrincipal.status).toBe(403);

    const readOnlyList = await mcpJson(
      server,
      sessionId,
      {
        jsonrpc: '2.0',
        id: 'readonly-list',
        method: 'tools/call',
        params: { name: 'list_workflows', arguments: {} },
      },
      { authorization: `Bearer ${readOnlyToken}` },
    );
    expect(parseToolText(readOnlyList.result)).toMatchObject({
      items: [
        expect.objectContaining({ id: 'tenant-a-workflow' }),
        expect.objectContaining({ id: 'tenant-a-workflow-2' }),
      ],
    });

    const readOnlyWrite = await mcpJson(
      server,
      sessionId,
      {
        jsonrpc: '2.0',
        id: 'readonly-write',
        method: 'tools/call',
        params: {
          name: 'start_workflow',
          arguments: { type: 'greet-customer', input: { name: 'Ada' } },
        },
      },
      { authorization: `Bearer ${readOnlyToken}` },
    );
    expect((readOnlyWrite.result as ToolCallResult).isError).toBe(true);
    expect((readOnlyWrite.result as ToolCallResult).content[0]?.text).toContain('workflows:write');
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

      const ready = await sendDirectInitializedNotification(engine, sessionManager, sessionId!);
      expect(ready.status).toBe(202);

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

  it('requires initialize and initialized notification before normal requests', async () => {
    const engine = createEngine();
    const sessionManager = createMcpSessionManager(engine);

    try {
      const initialized = await initializeDirectHandlerSession(engine, sessionManager);
      expect(initialized.status).toBe(200);
      const sessionId = initialized.headers.get('Mcp-Session-Id');
      expect(sessionId).toBeTruthy();

      const beforeReady = await handleMcpHttpRequest({
        request: jsonRequest(
          { jsonrpc: '2.0', id: 'tools', method: 'tools/list', params: {} },
          sessionId!,
        ),
        engine,
        sessionManager,
        authRequired: false,
      });
      expect(beforeReady.status).toBe(200);
      expect((await beforeReady.json()) as JsonRpcEnvelope).toMatchObject({
        error: {
          code: -32000,
          message: 'MCP session must receive notifications/initialized before requests',
        },
      });

      const ready = await sendDirectInitializedNotification(engine, sessionManager, sessionId!);
      expect(ready.status).toBe(202);

      const afterReady = await handleMcpHttpRequest({
        request: jsonRequest(
          { jsonrpc: '2.0', id: 'tools-ready', method: 'tools/list', params: {} },
          sessionId!,
        ),
        engine,
        sessionManager,
        authRequired: false,
      });
      expect(afterReady.status).toBe(200);
      const envelope = (await afterReady.json()) as JsonRpcEnvelope;
      expect(envelope.error).toBeUndefined();
    } finally {
      await sessionManager[Symbol.asyncDispose]();
    }
  });

  it('returns HTTP negotiation and session errors for invalid MCP transport requests', async () => {
    const engine = createEngine();
    const sessionManager = createMcpSessionManager(engine);

    try {
      const methodNotAllowed = await handleMcpHttpRequest({
        request: new Request('http://localhost/mcp', { method: 'PUT' }),
        engine,
        sessionManager,
        authRequired: false,
      });
      expect(methodNotAllowed.status).toBe(405);

      const badAccept = await handleMcpHttpRequest({
        request: jsonRequest(
          { jsonrpc: '2.0', id: 'bad-accept', method: 'initialize', params: {} },
          undefined,
          { accept: 'text/plain' },
        ),
        engine,
        sessionManager,
        authRequired: false,
      });
      expect(badAccept.status).toBe(406);

      const badContentType = await handleMcpHttpRequest({
        request: jsonRequest(
          { jsonrpc: '2.0', id: 'bad-content', method: 'initialize', params: {} },
          undefined,
          { 'content-type': 'text/plain' },
        ),
        engine,
        sessionManager,
        authRequired: false,
      });
      expect(badContentType.status).toBe(415);

      const missingSession = await handleMcpHttpRequest({
        request: jsonRequest({ jsonrpc: '2.0', id: 'missing', method: 'tools/list', params: {} }),
        engine,
        sessionManager,
        authRequired: false,
      });
      expect(missingSession.status).toBe(400);

      const unknownSession = await handleMcpHttpRequest({
        request: jsonRequest(
          { jsonrpc: '2.0', id: 'unknown', method: 'tools/list', params: {} },
          'missing-session',
        ),
        engine,
        sessionManager,
        authRequired: false,
      });
      expect(unknownSession.status).toBe(404);

      const oversize = await handleMcpHttpRequest({
        request: jsonRequest({ jsonrpc: '2.0', id: 'oversize', method: 'initialize', params: {} }),
        engine,
        sessionManager,
        authRequired: false,
        maxBodyBytes: 5,
      });
      expect(oversize.status).toBe(413);

      const initialized = await initializeDirectHandlerSession(engine, sessionManager);
      const sessionId = initialized.headers.get('Mcp-Session-Id');
      expect(sessionId).toBeTruthy();

      const wrongVersion = await handleMcpHttpRequest({
        request: jsonRequest(
          { jsonrpc: '2.0', id: 'wrong-version', method: 'tools/list', params: {} },
          sessionId!,
          { 'Mcp-Protocol-Version': '1999-01-01' },
        ),
        engine,
        sessionManager,
        authRequired: false,
      });
      expect(wrongVersion.status).toBe(400);

      const deleted = await handleMcpHttpRequest({
        request: new Request('http://localhost/mcp', {
          method: 'DELETE',
          headers: { 'Mcp-Session-Id': sessionId! },
        }),
        engine,
        sessionManager,
        authRequired: false,
      });
      expect(deleted.status).toBe(204);

      const afterDelete = await handleMcpHttpRequest({
        request: jsonRequest(
          { jsonrpc: '2.0', id: 'after-delete', method: 'tools/list', params: {} },
          sessionId!,
        ),
        engine,
        sessionManager,
        authRequired: false,
      });
      expect(afterDelete.status).toBe(404);

      const getAfterDelete = await handleMcpHttpRequest({
        request: new Request('http://localhost/mcp', {
          headers: { accept: 'text/event-stream', 'Mcp-Session-Id': sessionId! },
        }),
        engine,
        sessionManager,
        authRequired: false,
      });
      expect(getAfterDelete.status).toBe(404);
    } finally {
      await sessionManager[Symbol.asyncDispose]();
    }
  });

  it('rejects excess live sessions and purges idle sessions before accepting new initialization', async () => {
    const engine = createEngine();
    let now = 1_000;
    const sessionManager = createMcpSessionManager(engine, {
      maximumSessions: 1,
      sessionIdleTimeoutMilliseconds: 10,
      currentTimeMilliseconds: () => now,
    });

    try {
      const first = await initializeDirectHandlerSession(engine, sessionManager);
      expect(first.status).toBe(200);
      const firstSessionId = first.headers.get('Mcp-Session-Id');
      expect(firstSessionId).toBeTruthy();

      const rejected = await initializeDirectHandlerSession(engine, sessionManager);
      expect(rejected.status).toBe(429);
      expect(await rejected.text()).toBe('Too many MCP sessions');
      expect(rejected.headers.get('Mcp-Session-Id')).toBeNull();

      now += 11;

      const acceptedAfterExpiry = await initializeDirectHandlerSession(engine, sessionManager);
      expect(acceptedAfterExpiry.status).toBe(200);
      const nextSessionId = acceptedAfterExpiry.headers.get('Mcp-Session-Id');
      expect(nextSessionId).toBeTruthy();
      expect(nextSessionId).not.toBe(firstSessionId);

      const staleSessionLookup = await handleMcpHttpRequest({
        request: jsonRequest(
          { jsonrpc: '2.0', id: 'tools', method: 'tools/list', params: {} },
          firstSessionId!,
        ),
        engine,
        sessionManager,
        authRequired: false,
      });
      expect(staleSessionLookup.status).toBe(404);
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

function jsonRequest(
  message: Record<string, unknown>,
  sessionId?: string,
  headers?: HeadersInit,
): Request {
  const baseHeaders = new Headers({
    accept: 'application/json, text/event-stream',
    'content-type': 'application/json',
    'Mcp-Protocol-Version': MCP_PROTOCOL_VERSION,
  });
  const requestHeaders = new Headers(baseHeaders);
  for (const [key, value] of new Headers(headers ?? {})) {
    requestHeaders.set(key, value);
  }
  if (sessionId !== undefined) requestHeaders.set('Mcp-Session-Id', sessionId);
  return new Request('http://localhost/mcp', {
    method: 'POST',
    headers: requestHeaders,
    body: JSON.stringify(message),
  });
}

function initializeDirectHandlerSession(
  engine: Engine,
  sessionManager: McpSessionManager,
): Promise<Response> {
  return handleMcpHttpRequest({
    request: jsonRequest({
      jsonrpc: '2.0',
      id: 'init',
      method: 'initialize',
      params: { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {} },
    }),
    engine,
    sessionManager,
    authRequired: false,
  });
}

function sendDirectInitializedNotification(
  engine: Engine,
  sessionManager: McpSessionManager,
  sessionId: string,
): Promise<Response> {
  return handleMcpHttpRequest({
    request: jsonRequest({ jsonrpc: '2.0', method: 'notifications/initialized' }, sessionId),
    engine,
    sessionManager,
    authRequired: false,
  });
}
