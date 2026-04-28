import { afterEach, describe, expect, it } from 'bun:test';

import type { Context } from '../../core/context.ts';
import { Engine } from '../../core/engine.ts';
import type { WorkflowContext } from '../../core/types.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import { signJWT } from '../authentication.ts';
import { serve, type WeftServer } from '../index.ts';
import { executeOperation } from '../operation-catalog.ts';
import { anonymousPrincipal, principalFromJwtClaims } from '../principal.ts';
import { createLiveOperationRegistry } from '../rest-bindings.ts';

const TEST_SECRET = 'track-8-replay-auth-secret-1234567890';

function createReplayEngine(): Engine {
  const engine = new Engine({
    storage: new MemoryStorage(),
    checkpointHistory: 10,
  });

  async function firstStep() {
    return { phase: 'first' as const };
  }

  async function secondStep() {
    return { phase: 'second' as const };
  }

  async function thirdStep() {
    return { phase: 'third' as const };
  }

  engine.register('three-steps', {
    version: '1.0.0',
    handler: async function* (ctx: WorkflowContext) {
      yield* (ctx as Context).run(firstStep);
      yield* (ctx as Context).run(secondStep);
      return yield* (ctx as Context).run(thirdStep);
    },
  });

  return engine;
}

async function createReplayWorkflow(
  engine: Engine,
  workflowId = 'wf-replay-auth',
): Promise<string> {
  const handle = await engine.start('three-steps', null, { id: workflowId });
  await handle.result();
  return handle.id;
}

async function issueJwt(scopes: string[]): Promise<string> {
  return signJWT(
    {
      sub: 'track-8-user',
      scope: scopes.join(' '),
    },
    TEST_SECRET,
  );
}

async function postJsonRpc(
  server: WeftServer,
  method: string,
  params: Record<string, unknown>,
  token?: string,
): Promise<Response> {
  return fetch(`${server.url}/jsonrpc`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token !== undefined ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: crypto.randomUUID(),
      method,
      params,
    }),
  });
}

function waitForMessage(
  ws: WebSocket,
  predicate: (parsed: unknown) => boolean,
  timeoutMs = 3_000,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.removeEventListener('message', handler);
      reject(new Error('waitForMessage timed out'));
    }, timeoutMs);

    function handler(event: MessageEvent) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(String(event.data));
      } catch {
        return;
      }

      if (predicate(parsed)) {
        clearTimeout(timer);
        ws.removeEventListener('message', handler);
        resolve(parsed);
      }
    }

    ws.addEventListener('message', handler);
  });
}

function openWebSocket(url: string, token?: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket =
      token === undefined
        ? new WebSocket(url)
        : // oxlint-disable-next-line typescript/no-explicit-any -- Bun's WebSocket accepts a headers init option not in the lib.dom type.
          new WebSocket(url, { headers: { authorization: `Bearer ${token}` } } as any);
    socket.addEventListener('open', () => resolve(socket));
    socket.addEventListener('error', (event: Event) => reject(event));
  });
}

describe('weft.workflows.replay authorization parity', () => {
  const servers: WeftServer[] = [];

  afterEach(async () => {
    while (servers.length > 0) {
      await servers.pop()?.stop();
    }
  });

  it('REST uses the same scoped access policy as JSON-RPC HTTP', async () => {
    const engine = createReplayEngine();
    const workflowId = await createReplayWorkflow(engine);
    const noScopeToken = await issueJwt(['quota:read']);
    const readToken = await issueJwt(['workflows:read']);

    const anonymousServer = serve({ engine, port: 0 });
    const authenticatedServer = serve({
      engine,
      port: 0,
      auth: { jwt: { secret: TEST_SECRET } },
    });
    servers.push(anonymousServer, authenticatedServer);

    const anonymousRest = await fetch(`${anonymousServer.url}/v1/workflows/${workflowId}/replay/2`);
    expect(anonymousRest.status).toBe(401);

    const forbiddenRest = await fetch(
      `${authenticatedServer.url}/v1/workflows/${workflowId}/replay/2`,
      {
        headers: { Authorization: `Bearer ${noScopeToken}` },
      },
    );
    expect(forbiddenRest.status).toBe(403);

    const successRest = await fetch(
      `${authenticatedServer.url}/v1/workflows/${workflowId}/replay/2`,
      {
        headers: { Authorization: `Bearer ${readToken}` },
      },
    );
    expect(successRest.status).toBe(200);
    expect(successRest.headers.get('content-type')).toBe('application/json');

    const anonymousJsonRpc = await postJsonRpc(anonymousServer, 'weft.workflows.replay', {
      workflowId,
      step: 2,
    });
    expect(anonymousJsonRpc.status).toBe(200);
    const anonymousJsonRpcBody = (await anonymousJsonRpc.json()) as {
      error?: { data?: { weftCode?: string; httpStatus?: number } };
    };
    expect(anonymousJsonRpcBody.error?.data?.weftCode).toBe('Unauthorized');
    expect(anonymousJsonRpcBody.error?.data?.httpStatus).toBe(401);

    const forbiddenJsonRpc = await postJsonRpc(
      authenticatedServer,
      'weft.workflows.replay',
      { workflowId, step: 2 },
      noScopeToken,
    );
    expect(forbiddenJsonRpc.status).toBe(200);
    const forbiddenJsonRpcBody = (await forbiddenJsonRpc.json()) as {
      error?: { data?: { weftCode?: string; httpStatus?: number } };
    };
    expect(forbiddenJsonRpcBody.error?.data?.weftCode).toBe('Forbidden');
    expect(forbiddenJsonRpcBody.error?.data?.httpStatus).toBe(403);

    const successJsonRpc = await postJsonRpc(
      authenticatedServer,
      'weft.workflows.replay',
      { workflowId, step: 2 },
      readToken,
    );
    expect(successJsonRpc.status).toBe(200);
    const successJsonRpcBody = (await successJsonRpc.json()) as {
      result?: { checkpoint?: { step?: number } };
      error?: unknown;
    };
    expect(successJsonRpcBody.error).toBeUndefined();
    expect(successJsonRpcBody.result?.checkpoint?.step).toBe(2);
  });

  it('WebSocket sessions bind authenticated identity at upgrade time', async () => {
    const anonymousEngine = createReplayEngine();
    const anonymousWorkflowId = await createReplayWorkflow(anonymousEngine, 'wf-replay-ws-anon');
    const anonymousServer = serve({ engine: anonymousEngine, port: 0 });
    servers.push(anonymousServer);

    const anonymousSocket = await openWebSocket(
      `${anonymousServer.url.replace('http://', 'ws://')}/jsonrpc`,
    );
    const anonymousResponsePromise = waitForMessage(anonymousSocket, (parsed) => {
      return (
        typeof parsed === 'object' && parsed !== null && (parsed as { id?: string }).id === 'anon'
      );
    });
    anonymousSocket.send(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 'anon',
        method: 'weft.workflows.replay',
        params: { workflowId: anonymousWorkflowId, step: 2 },
      }),
    );
    const anonymousResponse = (await anonymousResponsePromise) as {
      error?: { data?: { weftCode?: string; httpStatus?: number } };
    };
    expect(anonymousResponse.error?.data?.weftCode).toBe('Unauthorized');
    expect(anonymousResponse.error?.data?.httpStatus).toBe(401);
    anonymousSocket.close();

    const authenticatedEngine = createReplayEngine();
    const authenticatedWorkflowId = await createReplayWorkflow(
      authenticatedEngine,
      'wf-replay-ws-authenticated',
    );
    const readToken = await issueJwt(['workflows:read']);
    const authenticatedServer = serve({
      engine: authenticatedEngine,
      port: 0,
      auth: { jwt: { secret: TEST_SECRET } },
    });
    servers.push(authenticatedServer);

    const authenticatedSocket = await openWebSocket(
      `${authenticatedServer.url.replace('http://', 'ws://')}/jsonrpc`,
      readToken,
    );
    const authenticatedResponsePromise = waitForMessage(authenticatedSocket, (parsed) => {
      return (
        typeof parsed === 'object' &&
        parsed !== null &&
        (parsed as { id?: string }).id === 'authenticated'
      );
    });
    authenticatedSocket.send(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 'authenticated',
        method: 'weft.workflows.replay',
        params: { workflowId: authenticatedWorkflowId, step: 2 },
      }),
    );
    const authenticatedResponse = (await authenticatedResponsePromise) as {
      result?: { checkpoint?: { step?: number } };
      error?: unknown;
    };
    expect(authenticatedResponse.error).toBeUndefined();
    expect(authenticatedResponse.result?.checkpoint?.step).toBe(2);
    authenticatedSocket.close();
  });

  it('stdio authorization uses the same operation-level policy hook once a session exists', async () => {
    const engine = createReplayEngine();
    const workflowId = await createReplayWorkflow(engine);
    const registry = createLiveOperationRegistry();

    const anonymousResult = await executeOperation(
      'weft.workflows.replay',
      { workflowId, step: 2 },
      {
        principal: anonymousPrincipal(),
        engine,
        transport: 'jsonRpcStdio',
        registry,
      },
    );
    expect(anonymousResult.ok).toBe(false);
    if (anonymousResult.ok) {
      throw new Error('expected anonymous stdio replay to be denied');
    }
    expect(anonymousResult.fault.code).toBe('Unauthorized');

    const scopedResult = await executeOperation(
      'weft.workflows.replay',
      { workflowId, step: 2 },
      {
        principal: principalFromJwtClaims({ sub: 'track-8-user', scope: 'workflows:read' }),
        engine,
        transport: 'jsonRpcStdio',
        registry,
      },
    );
    expect(scopedResult.ok).toBe(true);
    if (!scopedResult.ok) {
      throw new Error('expected scoped stdio replay to succeed');
    }
    const replay = scopedResult.value as { checkpoint: { step: number } };
    expect(replay.checkpoint.step).toBe(2);
  });
});
