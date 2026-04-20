import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { Context } from '../core/context.ts';
import { Engine } from '../core/engine.ts';
import type { WorkflowContext } from '../core/types.ts';
import { handleRequest } from '../server/handler.ts';
import { MemoryStorage } from '../storage/memory.ts';
import { HttpClient, HttpClientError } from './index.ts';
import type { WeftClient } from './interface.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function* echoWorkflow(_ctx: WorkflowContext, input: unknown) {
  return input;
}

async function* waitForSignalWorkflow(ctx: WorkflowContext, input: unknown) {
  const signal = yield* (ctx as Context).waitForSignal<string>('continue');
  return `${String(input)}:${signal}`;
}

function requestInputToUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') {
    return input;
  }

  if (input instanceof URL) {
    return input.toString();
  }

  return input.url;
}

let engine: Engine;
let server: ReturnType<typeof Bun.serve>;
let client: WeftClient;

beforeAll(() => {
  engine = new Engine({ storage: new MemoryStorage() });
  engine.register('echo', echoWorkflow);
  engine.register('wait-for-signal', waitForSignalWorkflow);

  server = Bun.serve({
    port: 0, // random available port
    async fetch(request) {
      return handleRequest(request, engine);
    },
  });

  client = new HttpClient({ baseUrl: `http://localhost:${server.port}` });
});

afterAll(async () => {
  server.stop(true);
  await engine[Symbol.asyncDispose]();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('HttpClient', () => {
  it('implements WeftClient', () => {
    expect(client.start).toBeFunction();
    expect(client.get).toBeFunction();
    expect(client.list).toBeFunction();
    expect(client.cancel).toBeFunction();
    expect(client.signal).toBeFunction();
    expect(client.query).toBeFunction();
    expect(client.update).toBeFunction();
    expect(client.resume).toBeFunction();
    expect(client.recoverAll).toBeFunction();
    expect(client.timeout).toBeFunction();
    expect(client.getAttributes).toBeFunction();
    expect(client.setAttributes).toBeFunction();
    expect(client.getEvents).toBeFunction();
    expect(client.getTimeline).toBeFunction();
    expect(client.replayTo).toBeFunction();
    expect(client.listReviews).toBeFunction();
    expect(client.submitReview).toBeFunction();
    expect(client.setBudgetPolicy).toBeFunction();
    expect(client.getBudgetPolicy).toBeFunction();
    expect(client.getStreamChunks).toBeFunction();
    expect(client.submitCoordinatedUpdate).toBeFunction();
    expect(client.getUpdateResult).toBeFunction();
  });

  describe('start', () => {
    it('starts a workflow and returns a handle with a workflow id', async () => {
      const handle = await client.start('echo', 'hello');
      expect(handle.id).toBeString();
      expect(handle.id.length).toBeGreaterThan(0);
    });

    it('respects a custom id in start options', async () => {
      const handle = await client.start('echo', 'hello', { id: 'http-custom-id' });
      expect(handle.id).toBe('http-custom-id');
    });

    it('returns a handle whose result() resolves with the workflow output', async () => {
      const handle = await client.start('echo', 42);
      const result = await handle.result();
      expect(result).toBe(42);
    });

    it('forwards StartOptions.tags through the HTTP client', async () => {
      const handle = await client.start('echo', 'tagged', {
        id: 'http-client-tags',
        tags: ['nightly', 'v2'],
      });
      await handle.result();

      const state = await client.get('http-client-tags');
      expect(state?.tags).toEqual(['nightly', 'v2']);
    });

    it('persists handle.addTags(...tags) and handle.removeTags(...tags) through the HTTP routes', async () => {
      const handle = await client.start('wait-for-signal', 'payload', {
        id: 'http-client-tag-mutations',
        tags: ['alpha'],
      });
      await Bun.sleep(10);

      await handle.addTags('beta');
      await handle.removeTags('alpha');

      const state = await client.get('http-client-tag-mutations');
      expect(state?.tags).toEqual(['beta']);

      const result = await client.list({ tags: ['beta'] });
      expect(result.items.some((item) => item.id === 'http-client-tag-mutations')).toBe(true);

      await handle.signal('continue', 'done');
      await expect(handle.result()).resolves.toBe('payload:done');
    });
  });

  describe('get', () => {
    it('returns the workflow state for a known workflow', async () => {
      const handle = await client.start('echo', 'data', { id: 'http-get-test' });
      await handle.result();

      const state = await client.get('http-get-test');
      expect(state).not.toBeNull();
      expect(state!.id).toBe('http-get-test');
      expect(state!.type).toBe('echo');
      expect(state!.status).toBe('completed');
    });

    it('returns null for an unknown workflow', async () => {
      const state = await client.get('nonexistent');
      expect(state).toBeNull();
    });
  });

  describe('list', () => {
    it('lists workflows', async () => {
      const result = await client.list();
      expect(result.items.length).toBeGreaterThanOrEqual(1);
      expect(result.total).toBeGreaterThanOrEqual(1);
    });

    it('filters by status', async () => {
      const result = await client.list({ status: 'completed' });
      expect(result.items.every((item) => item.status === 'completed')).toBe(true);
    });

    it('filters by repeated tag query parameters', async () => {
      const firstHandle = await client.start('echo', 'one', {
        id: 'http-tag-wf-1',
        tags: ['nightly', 'v2', 'release-candidate'],
      });
      const secondHandle = await client.start('echo', 'two', {
        id: 'http-tag-wf-2',
        tags: ['nightly'],
      });
      await firstHandle.result();
      await secondHandle.result();

      const result = await client.list({ tags: ['nightly', 'v2', 'release-candidate'] });
      expect(result.items.map((item) => item.id)).toEqual(['http-tag-wf-1']);
    });
  });

  describe('cancel', () => {
    it('cancels a workflow via the client', async () => {
      const handle = await client.start('echo', 'data', { id: 'http-cancel-test' });
      await handle.result();
      // Cancelling a completed workflow — should not error
      await client.cancel('http-cancel-test');
    });
  });

  describe('handle.cancel', () => {
    it('delegates to client.cancel', async () => {
      const handle = await client.start('echo', 'data', { id: 'http-handle-cancel' });
      await handle.result();
      await handle.cancel();
    });
  });

  describe('handle.signal', () => {
    it('delegates to client.signal', async () => {
      const handle = await client.start('echo', 'data', { id: 'http-handle-signal' });
      await handle.result();
      await handle.signal('test-signal', { key: 'value' });
    });
  });

  describe('getEvents', () => {
    it('returns event history for a workflow', async () => {
      const handle = await client.start('echo', 'data', { id: 'http-events-test' });
      await handle.result();

      const events = await client.getEvents('http-events-test');
      expect(Array.isArray(events)).toBe(true);
    });
  });

  describe('getTimeline / replayTo', () => {
    it('returns timeline entries and replay data over HTTP', async () => {
      async function firstHttpStep() {
        return { phase: 'first' as const };
      }

      async function secondHttpStep() {
        return { phase: 'second' as const };
      }

      engine.register('http-timeline', {
        version: '6.0.0',
        handler: async function* (ctx: WorkflowContext) {
          yield* (ctx as import('../core/context.ts').Context).run(firstHttpStep);
          return yield* (ctx as import('../core/context.ts').Context).run(secondHttpStep);
        },
      });

      const handle = await client.start('http-timeline', null, { id: 'wf-http-client-timeline' });
      await handle.result();

      const timeline = await client.getTimeline('wf-http-client-timeline');
      const replay = await client.replayTo('wf-http-client-timeline', 2);

      expect(timeline).toHaveLength(2);
      expect(timeline[0]?.operationLabel).toBe('firstHttpStep');
      expect(replay?.checkpoint.step).toBe(2);
      expect(replay?.accumulatedResults).toEqual([[0, { phase: 'first' }]]);
    });

    it('returns empty timeline and null replay for missing data over HTTP', async () => {
      const handle = await client.start('echo', 'done', { id: 'wf-http-missing-replay' });
      await handle.result();

      await expect(client.getTimeline('missing-workflow')).resolves.toEqual([]);
      await expect(client.replayTo('missing-workflow', 1)).resolves.toBeNull();
      await expect(client.replayTo('wf-http-missing-replay', 1)).resolves.toBeNull();
    });
  });

  describe('getAttributes / setAttributes', () => {
    it('round-trips search attributes', async () => {
      const handle = await client.start('echo', 'data', { id: 'http-attrs-test' });
      await handle.result();

      await client.setAttributes('http-attrs-test', { priority: 'high' });
      const attributes = await client.getAttributes('http-attrs-test');
      expect(attributes).not.toBeNull();
      expect(attributes!['priority']).toBe('high');
    });
  });

  describe('listReviews', () => {
    it('returns an array', async () => {
      const reviews = await client.listReviews();
      expect(Array.isArray(reviews)).toBe(true);
    });
  });

  describe('getUpdateResult', () => {
    it('returns null for an unknown update', async () => {
      const result = await client.getUpdateResult('nonexistent');
      expect(result).toBeNull();
    });
  });

  describe('same interface as LocalClient', () => {
    it('both export WeftClient-compatible classes', async () => {
      const { LocalClient } = await import('./local.ts');
      const localEngine = new Engine({ storage: new MemoryStorage() });
      localEngine.register('echo', echoWorkflow);

      const local: WeftClient = new LocalClient(localEngine);
      const remote: WeftClient = client;

      // Both should have the same set of methods
      const clientMethods = [
        'start',
        'get',
        'list',
        'cancel',
        'signal',
        'query',
        'update',
        'resume',
        'recoverAll',
        'timeout',
        'getAttributes',
        'setAttributes',
        'getEvents',
        'listReviews',
        'submitReview',
        'setBudgetPolicy',
        'getBudgetPolicy',
        'getStreamChunks',
        'submitCoordinatedUpdate',
        'getUpdateResult',
      ] as const;

      for (const method of clientMethods) {
        expect(typeof local[method]).toBe('function');
        expect(typeof remote[method]).toBe('function');
      }

      await localEngine[Symbol.asyncDispose]();
    });
  });
});

describe('HttpClient request surface', () => {
  const originalFetch = globalThis.fetch;
  const originalWarn = console.warn;
  const originalSetInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    console.warn = originalWarn;
    globalThis.setInterval = originalSetInterval;
    globalThis.clearInterval = originalClearInterval;
  });

  function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  it('serializes the full client surface into the expected HTTP requests', async () => {
    const fetchCalls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const responses = [
      jsonResponse({ id: 'wf-1' }),
      jsonResponse({ result: 'hello' }),
      new Response(null, { status: 204 }),
      new Response(null, { status: 204 }),
      jsonResponse({ result: 'handle-update' }),
      jsonResponse({ result: 'handle-query' }),
      jsonResponse({ priority: 'high' }),
      new Response(null, { status: 204 }),
      jsonResponse({ id: 'wf-1', status: 'running' }),
      jsonResponse({ items: [], total: 0 }),
      new Response(null, { status: 204 }),
      new Response(null, { status: 204 }),
      jsonResponse({ result: 'client-query' }),
      jsonResponse({ result: 'client-update' }),
      jsonResponse({ id: 'wf-2' }),
      jsonResponse({ recovered: ['wf-3', 'wf-4'] }),
      new Response(null, { status: 204 }),
      jsonResponse({ priority: 'high' }),
      new Response(null, { status: 204 }),
      jsonResponse({ events: [{ type: 'workflow:started' }] }),
      jsonResponse({ items: [{ reviewId: 'review-1' }] }),
      new Response(null, { status: 204 }),
      new Response(null, { status: 204 }),
      jsonResponse({ namespace: 'agents', daily: { maxCost: 10 } }),
      jsonResponse({
        chunks: [
          { sequence: 2, value: 'chunk-a' },
          { sequence: 3, value: 'chunk-b' },
        ],
      }),
      jsonResponse({ updateId: 'update-1', result: 'accepted' }),
      jsonResponse({ status: 'completed', result: 'done', error: 'warn' }),
    ];

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = requestInputToUrl(input);
      fetchCalls.push({ url, init });
      const response = responses.shift();
      if (!response) {
        throw new Error(`Unexpected fetch: ${url}`);
      }
      return response;
    }) as unknown as typeof fetch;

    const httpClient = new HttpClient({
      baseUrl: 'http://example.test///',
      headers: { Authorization: 'Bearer token' },
    });

    const handle = await httpClient.start('echo', 'hello', { id: 'wf/1', executionTimeout: '5m' });
    expect(handle.id).toBe('wf-1');
    expect(await handle.result()).toBe('hello');
    await handle.cancel();
    await handle.signal('status', { ok: true });
    expect(await handle.update('rename', { value: 1 }, { timeout: 50 })).toBe('handle-update');
    expect(await handle.query('status')).toBe('handle-query');
    expect(await handle.getAttributes()).toEqual({ priority: 'high' });
    await handle.setAttributes({ priority: 'critical' });

    expect(await httpClient.get('wf/1')).toMatchObject({ id: 'wf-1', status: 'running' });
    await httpClient.list({
      status: ['running', 'completed'],
      type: 'echo',
      limit: 5,
      offset: 2,
      attributes: [{ key: 'priority', value: 'high', gt: 1, lt: 9, gte: 2, lte: 8 }],
    });
    await httpClient.cancel('wf/1');
    await httpClient.signal('wf/1', 'status', { ok: true });
    expect(await httpClient.query('wf/1', 'status')).toBe('client-query');
    expect(await httpClient.update('wf/1', 'rename', { value: 2 }, { timeout: 10 })).toBe(
      'client-update',
    );

    const resumed = await httpClient.resume('wf/1');
    expect(resumed.id).toBe('wf-2');
    const recovered = await httpClient.recoverAll();
    expect(recovered.map((recoveredHandle) => recoveredHandle.id)).toEqual(['wf-3', 'wf-4']);
    await httpClient.timeout('wf/1');
    expect(await httpClient.getAttributes('wf/1')).toEqual({ priority: 'high' });
    await httpClient.setAttributes('wf/1', { priority: 'critical' });
    expect(await httpClient.getEvents('wf/1')).toMatchObject([{ type: 'workflow:started' }]);
    expect(await httpClient.listReviews()).toEqual([{ reviewId: 'review-1' }]);
    await httpClient.submitReview('review-1', { decision: 'approved', reviewer: 'alex' });
    await httpClient.setBudgetPolicy({ namespace: 'agents', daily: { maxCost: 10 } });
    expect(await httpClient.getBudgetPolicy('agents')).toEqual({
      namespace: 'agents',
      daily: { maxCost: 10 },
    });
    expect(await httpClient.getStreamChunks('wf/1', 'stream/key', { after: 1 })).toEqual([
      { sequence: 2, value: 'chunk-a' },
      { sequence: 3, value: 'chunk-b' },
    ]);
    expect(
      await httpClient.submitCoordinatedUpdate(
        'wf/1',
        'rename',
        { value: 3 },
        {
          timeout: 20,
          idempotencyKey: 'idempotent-1',
        },
      ),
    ).toEqual({ updateId: 'update-1', result: 'accepted' });
    expect(await httpClient.getUpdateResult('update-1')).toEqual({
      updateId: 'update-1',
      result: 'done',
      error: 'warn',
    });

    const startCall = fetchCalls[0]!;
    expect(startCall.url).toBe('http://example.test/v1/workflows');
    expect(startCall.init?.method).toBe('POST');
    expect(new Headers(startCall.init?.headers).get('Authorization')).toBe('Bearer token');
    expect(new Headers(startCall.init?.headers).get('Content-Type')).toBe('application/json');
    const startBody = startCall.init?.body;
    expect(typeof startBody).toBe('string');
    if (typeof startBody !== 'string') {
      throw new Error('Expected start request body to be a string');
    }
    expect(JSON.parse(startBody)).toEqual({
      type: 'echo',
      input: 'hello',
      id: 'wf/1',
      executionTimeout: '5m',
    });

    const listCall = fetchCalls[9]!;
    const listUrl = new URL(listCall.url);
    expect(listUrl.searchParams.getAll('status')).toEqual(['running', 'completed']);
    expect(listUrl.searchParams.get('type')).toBe('echo');
    expect(listUrl.searchParams.get('limit')).toBe('5');
    expect(listUrl.searchParams.get('offset')).toBe('2');
    expect(listUrl.searchParams.get('attr.priority')).toBe('high');
    expect(listUrl.searchParams.get('attr.priority.gt')).toBe('1');
    expect(listUrl.searchParams.get('attr.priority.lt')).toBe('9');
    expect(listUrl.searchParams.get('attr.priority.gte')).toBe('2');
    expect(listUrl.searchParams.get('attr.priority.lte')).toBe('8');

    expect(fetchCalls[10]?.init?.method).toBe('DELETE');
    expect(fetchCalls[11]?.url).toContain('/signal/status');
    expect(fetchCalls[13]?.url).toContain('/update/rename');
    expect(fetchCalls[14]?.url).toContain('/resume');
    expect(fetchCalls[15]?.url).toBe('http://example.test/v1/recover');
    expect(fetchCalls[24]?.url).toContain('/streams/stream%2Fkey?after=1');
  });

  it('serializes startAt in the workflow start payload', async () => {
    const fetchCalls: Array<{ url: string; init: RequestInit | undefined }> = [];

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      fetchCalls.push({ url: requestInputToUrl(input), init });
      return jsonResponse({ id: 'wf-start-at' });
    }) as unknown as typeof fetch;

    const httpClient = new HttpClient({ baseUrl: 'http://example.test' });
    await httpClient.start('echo', 'hello', { startAt: 12_345 });

    const startBody = fetchCalls[0]?.init?.body;
    expect(typeof startBody).toBe('string');
    if (typeof startBody !== 'string') {
      throw new Error('Expected start request body to be a string');
    }
    expect(JSON.parse(startBody)).toEqual({
      type: 'echo',
      input: 'hello',
      startAt: 12_345,
    });
  });

  it('serializes startAfter in the workflow start payload', async () => {
    const fetchCalls: Array<{ url: string; init: RequestInit | undefined }> = [];

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      fetchCalls.push({ url: requestInputToUrl(input), init });
      return jsonResponse({ id: 'wf-start-after' });
    }) as unknown as typeof fetch;

    const httpClient = new HttpClient({ baseUrl: 'http://example.test' });
    await httpClient.start('echo', 'hello', { startAfter: '5m' });

    const startBody = fetchCalls[0]?.init?.body;
    expect(typeof startBody).toBe('string');
    if (typeof startBody !== 'string') {
      throw new Error('Expected start request body to be a string');
    }
    expect(JSON.parse(startBody)).toEqual({
      type: 'echo',
      input: 'hello',
      startAfter: '5m',
    });
  });

  it('returns null or empty collections for missing GET resources', async () => {
    const responses = [
      new Response(JSON.stringify({ error: 'missing' }), { status: 404 }),
      new Response(JSON.stringify({ error: 'missing' }), { status: 404 }),
      new Response(JSON.stringify({ error: 'missing' }), { status: 404 }),
    ];

    globalThis.fetch = (async () =>
      responses.shift() ?? new Response(null, { status: 500 })) as unknown as typeof fetch;

    const httpClient = new HttpClient({ baseUrl: 'http://example.test' });

    expect(await httpClient.get('missing')).toBeNull();
    expect(await httpClient.getEvents('missing')).toEqual([]);
    expect(await httpClient.getUpdateResult('missing')).toBeNull();
  });

  it('converts coordinated update business errors and propagates transport errors', async () => {
    const responses = [
      new Response(JSON.stringify({ error: 'business rejection' }), { status: 422 }),
      new Response('unauthorized', { status: 401, statusText: 'Unauthorized' }),
    ];

    globalThis.fetch = (async () =>
      responses.shift() ?? new Response(null, { status: 500 })) as unknown as typeof fetch;

    const httpClient = new HttpClient({ baseUrl: 'http://example.test' });

    expect(await httpClient.submitCoordinatedUpdate('wf-1', 'rename')).toEqual({
      updateId: '',
      error: 'business rejection',
    });
    await expect(httpClient.submitCoordinatedUpdate('wf-1', 'rename')).rejects.toMatchObject({
      status: 401,
      message: 'Unauthorized',
    });
  });

  it('throws a 404 client error when handle.result() points at a missing workflow', async () => {
    const responses = [
      jsonResponse({ id: 'wf-1' }),
      new Response(JSON.stringify({ error: 'missing' }), { status: 404 }),
    ];

    globalThis.fetch = (async () =>
      responses.shift() ?? new Response(null, { status: 500 })) as unknown as typeof fetch;

    const httpClient = new HttpClient({ baseUrl: 'http://example.test' });
    const handle = await httpClient.start('echo', 'hello');

    await expect(handle.result()).rejects.toBeInstanceOf(HttpClientError);
  });

  it('polls handle events, closes on terminal events, and warns when polling fails', async () => {
    let intervalCallback: (() => void) | undefined;
    let clearedIntervals = 0;
    const warnings: unknown[][] = [];
    const responses = [
      jsonResponse({ id: 'wf-terminal' }),
      jsonResponse({
        events: [{ type: 'workflow:completed', data: { result: 'done' } }],
      }),
      jsonResponse({ id: 'wf-warning' }),
    ];

    globalThis.fetch = (async () => {
      const response = responses.shift();
      if (response) {
        return response;
      }
      throw new Error('poll failed');
    }) as unknown as typeof fetch;
    console.warn = (...arguments_) => {
      warnings.push(arguments_);
    };
    globalThis.setInterval = ((callback: TimerHandler) => {
      intervalCallback = callback as () => void;
      return 1 as unknown as ReturnType<typeof setInterval>;
    }) as unknown as typeof setInterval;
    globalThis.clearInterval = (() => {
      clearedIntervals++;
    }) as typeof clearInterval;

    const httpClient = new HttpClient({ baseUrl: 'http://example.test' });

    const handle = await httpClient.start('echo', 'hello');
    const terminalEvent = await new Promise<Event>((resolve) => {
      handle.addEventListener('workflow:completed', resolve as EventListener);
    });

    expect(terminalEvent).toBeInstanceOf(CustomEvent);
    expect((terminalEvent as CustomEvent).detail).toEqual({ result: 'done' });
    expect(clearedIntervals).toBe(1);

    const warningHandle = await httpClient.start('echo', 'warn');
    warningHandle.addEventListener('workflow:started', (() => {}) as EventListener);
    await intervalCallback?.();
    await Bun.sleep(0);

    expect(warnings[0]?.[0]).toBe('[weft] Event poll error:');
  });

  it('closes a handle when the workflow disappears after previously-emitted events', async () => {
    let intervalCallback: (() => void) | undefined;
    let clearedIntervals = 0;
    const responses = [
      jsonResponse({ id: 'wf-disappear' }),
      jsonResponse({
        events: [{ type: 'workflow:started', data: { phase: 'first' } }],
      }),
      new Response(JSON.stringify({ error: 'missing' }), { status: 404 }),
      new Response(JSON.stringify({ error: 'missing' }), { status: 404 }),
    ];

    globalThis.fetch = (async () =>
      responses.shift() ?? new Response(null, { status: 500 })) as unknown as typeof fetch;
    globalThis.setInterval = ((callback: TimerHandler) => {
      intervalCallback = callback as () => void;
      return 1 as unknown as ReturnType<typeof setInterval>;
    }) as unknown as typeof setInterval;
    globalThis.clearInterval = (() => {
      clearedIntervals++;
    }) as typeof clearInterval;

    const httpClient = new HttpClient({ baseUrl: 'http://example.test' });
    const handle = await httpClient.start('echo', 'hello');

    await new Promise<void>((resolve) => {
      handle.addEventListener('workflow:started', () => resolve());
    });
    await intervalCallback?.();
    await Bun.sleep(0);

    expect(clearedIntervals).toBe(1);
  });

  it('removes listeners and disposes a handle without extra network requests', async () => {
    let intervalIdentifier: ReturnType<typeof setInterval> | undefined;
    let clearedIntervals = 0;

    globalThis.fetch = (async () => jsonResponse({ id: 'wf-dispose' })) as unknown as typeof fetch;
    globalThis.setInterval = (() => {
      intervalIdentifier = 99 as unknown as ReturnType<typeof setInterval>;
      return intervalIdentifier;
    }) as unknown as typeof setInterval;
    globalThis.clearInterval = ((timer: Timer) => {
      expect(timer).toBe(intervalIdentifier!);
      clearedIntervals++;
    }) as unknown as typeof clearInterval;

    const httpClient = new HttpClient({ baseUrl: 'http://example.test' });
    const handle = await httpClient.start('echo', 'hello');
    const listener = (() => {}) as EventListener;

    handle.addEventListener('workflow:started', listener);
    handle.removeEventListener('workflow:started', listener);
    handle[Symbol.dispose]();

    expect(clearedIntervals).toBe(1);
  });
});
