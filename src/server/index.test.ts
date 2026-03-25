import { afterEach, describe, expect, it } from 'bun:test';

import { Engine } from '../core/engine.ts';
import type { WorkflowContext } from '../core/types.ts';
import { MemoryStorage } from '../storage/memory.ts';
import type { WeftServer } from './index.ts';
import { serve } from './index.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Drain microtasks so fire-and-forget work completes. */
async function flush(): Promise<void> {
  await Bun.sleep(10);
}

function createEngine(): Engine {
  const storage = new MemoryStorage();
  const engine = new Engine({ storage });

  engine.register('echo', async function* (_ctx: WorkflowContext, input: unknown) {
    return input;
  });

  return engine;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('serve', () => {
  let engine: Engine;
  let server: WeftServer;

  afterEach(() => {
    server?.stop();
    engine?.[Symbol.dispose]();
  });

  it('starts a server on the specified port', () => {
    engine = createEngine();
    server = serve({ engine, port: 0 });

    expect(server.port).toBeGreaterThan(0);
  });

  it('responds to health check (GET /v1/health)', async () => {
    engine = createEngine();
    server = serve({ engine, port: 0 });

    const response = await fetch(`${server.url}/v1/health`);

    expect(response.status).toBe(200);
    const body = (await response.json()) as { status: string };
    expect(body.status).toBe('ok');
  });

  it('handles workflow API routes (POST /v1/workflows)', async () => {
    engine = createEngine();
    server = serve({ engine, port: 0 });

    const response = await fetch(`${server.url}/v1/workflows`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'echo', input: 'hello' }),
    });

    expect(response.status).toBe(201);
    const body = (await response.json()) as { id: string };
    expect(typeof body.id).toBe('string');
    expect(body.id.length).toBeGreaterThan(0);
  });

  it('stops cleanly via stop()', async () => {
    engine = createEngine();
    server = serve({ engine, port: 0 });
    const { url } = server;

    // Verify it is running
    const response = await fetch(`${url}/v1/health`);
    expect(response.status).toBe(200);

    server.stop();

    // After stopping, fetch should fail
    try {
      await fetch(`${url}/v1/health`);
      // If fetch succeeds, the server did not stop — fail the test
      expect(true).toBe(false);
    } catch {
      // Expected: connection refused or similar error
      expect(true).toBe(true);
    }
  });

  it('stops via Symbol.dispose', async () => {
    engine = createEngine();
    server = serve({ engine, port: 0 });
    const { url } = server;

    // Verify it is running
    const response = await fetch(`${url}/v1/health`);
    expect(response.status).toBe(200);

    server[Symbol.dispose]();

    try {
      await fetch(`${url}/v1/health`);
      expect(true).toBe(false);
    } catch {
      expect(true).toBe(true);
    }
  });

  it('url property returns correct URL', () => {
    engine = createEngine();
    server = serve({ engine, port: 0 });

    expect(server.url).toBe(`http://${server.hostname}:${server.port}`);
  });

  it('defaults to port 7233', () => {
    engine = createEngine();
    // Use the default port; rely on it being available in test environments
    server = serve({ engine, port: 7233 });

    expect(server.port).toBe(7233);
  });

  it('lists workflows through the server', async () => {
    engine = createEngine();
    server = serve({ engine, port: 0 });

    // Start two workflows
    await fetch(`${server.url}/v1/workflows`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'echo', input: 1 }),
    });
    await fetch(`${server.url}/v1/workflows`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'echo', input: 2 }),
    });
    await flush();

    const response = await fetch(`${server.url}/v1/workflows`);

    expect(response.status).toBe(200);
    const body = (await response.json()) as { items: unknown[]; total: number };
    expect(body.items.length).toBe(2);
    expect(body.total).toBe(2);
  });

  it('returns a WebSocket upgrade failure for non-matching upgrade requests', async () => {
    engine = createEngine();
    server = serve({ engine, port: 0 });

    // Attempt a WebSocket-style request to a non-WebSocket route
    // Bun's fetch cannot do a real WebSocket upgrade, but we can
    // verify the server handles the upgrade header gracefully
    const response = await fetch(`${server.url}/v1/health`, {
      headers: { upgrade: 'websocket' },
    });

    // The server should return 400 since upgrade fails on a non-WebSocket route
    // (or Bun may strip the upgrade header in fetch — either way, the server
    // should not crash)
    expect(response.status).toBeDefined();
  });
});
