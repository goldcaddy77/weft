import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { Engine } from '../core/engine';
import { MemoryStorage } from '../storage/memory';
import { resetSetupServiceWorkerRegistry, setupServiceWorker } from './setup.ts';

interface FakeEvent {
  request?: Request;
  tag?: string;
  respondWith?: (response: Response | Promise<Response>) => void;
  waitUntil?: (promise: Promise<unknown>) => void;
}

interface FakeServiceWorkerScope {
  addEventListener(type: string, listener: (event: FakeEvent) => void): void;
  skipWaiting(): Promise<void>;
  clients: { claim(): Promise<void> };
  listeners: Map<string, Array<(event: FakeEvent) => void>>;
  skipWaitingCalls: number;
  claimCalls: number;
}

function createFakeServiceWorkerScope(): FakeServiceWorkerScope {
  const listeners = new Map<string, Array<(event: FakeEvent) => void>>();
  const scope: FakeServiceWorkerScope = {
    listeners,
    skipWaitingCalls: 0,
    claimCalls: 0,
    addEventListener(type, listener) {
      // Real Service Worker `addEventListener` is additive. Store listeners
      // in a list so tests can verify the helper registers each event type
      // exactly once even across concurrent setup calls.
      const existing = listeners.get(type);
      if (existing === undefined) listeners.set(type, [listener]);
      else existing.push(listener);
    },
    async skipWaiting() {
      this.skipWaitingCalls++;
    },
    clients: {
      claim: async () => {
        scope.claimCalls++;
      },
    },
  };
  return scope;
}

function listenerFor(scope: FakeServiceWorkerScope, type: string): (event: FakeEvent) => void {
  const list = scope.listeners.get(type);
  if (list === undefined || list.length === 0) {
    throw new Error(`no listener attached for ${type}`);
  }
  if (list.length > 1) {
    throw new Error(`expected exactly one ${type} listener, found ${list.length}`);
  }
  return list[0]!;
}

function withFakeSelf(scope: FakeServiceWorkerScope, fn: () => Promise<void>): Promise<void> {
  const previous = (globalThis as { self?: unknown }).self;
  (globalThis as { self?: unknown }).self = scope;
  return fn().finally(() => {
    if (previous === undefined) {
      delete (globalThis as { self?: unknown }).self;
    } else {
      (globalThis as { self?: unknown }).self = previous;
    }
    resetSetupServiceWorkerRegistry(scope);
  });
}

describe('setupServiceWorker', () => {
  beforeEach(() => {
    // Each test installs a fresh fake `self` and clears any prior registry
    // entries inside `withFakeSelf`'s teardown.
  });

  afterEach(() => {
    delete (globalThis as { self?: unknown }).self;
  });

  it('attaches all four listeners synchronously before register completes', async () => {
    const scope = createFakeServiceWorkerScope();
    let registerSettled = false;
    let listenerCountAtRegisterStart = -1;

    await withFakeSelf(scope, async () => {
      const setup = setupServiceWorker({
        storage: new MemoryStorage(),
        register: async () => {
          listenerCountAtRegisterStart = scope.listeners.size;
          await new Promise((resolve) => setTimeout(resolve, 5));
          registerSettled = true;
        },
      });
      // Listeners must be attached before the helper returns its promise.
      expect(scope.listeners.size).toBe(4);
      expect(scope.listeners.has('install')).toBe(true);
      expect(scope.listeners.has('activate')).toBe(true);
      expect(scope.listeners.has('fetch')).toBe(true);
      expect(scope.listeners.has('periodicsync')).toBe(true);
      const result = await setup;
      expect(registerSettled).toBe(true);
      expect(listenerCountAtRegisterStart).toBe(4);
      result.engine[Symbol.dispose]();
    });
  });

  it('returns the same result for concurrent calls during initialization', async () => {
    const scope = createFakeServiceWorkerScope();
    await withFakeSelf(scope, async () => {
      const first = setupServiceWorker({ storage: new MemoryStorage() });
      const second = setupServiceWorker({ storage: new MemoryStorage() });
      const [a, b] = await Promise.all([first, second]);
      expect(a).toBe(b);
      // Listeners attached only once.
      expect(scope.listeners.size).toBe(4);
      a.engine[Symbol.dispose]();
    });
  });

  it('throws when called again after attached', async () => {
    const scope = createFakeServiceWorkerScope();
    await withFakeSelf(scope, async () => {
      const first = await setupServiceWorker({ storage: new MemoryStorage() });
      await expect(setupServiceWorker({ storage: new MemoryStorage() })).rejects.toThrow(
        /already initialized/,
      );
      first.engine[Symbol.dispose]();
    });
  });

  it('rethrows registration failures and rejects subsequent calls', async () => {
    const scope = createFakeServiceWorkerScope();
    const failure = new Error('register exploded');
    await withFakeSelf(scope, async () => {
      await expect(
        setupServiceWorker({
          storage: new MemoryStorage(),
          register: async () => {
            throw failure;
          },
        }),
      ).rejects.toThrow('register exploded');
      // Subsequent call must reject with the original cause attached.
      let caught: unknown;
      try {
        await setupServiceWorker({ storage: new MemoryStorage() });
        expect.unreachable('expected throw');
      } catch (error) {
        caught = error;
      }
      expect((caught as { cause?: unknown }).cause).toBe(failure);
    });
  });

  it('rejects when engine.storage and options.storage do not match', async () => {
    const scope = createFakeServiceWorkerScope();
    await withFakeSelf(scope, async () => {
      const storageA = new MemoryStorage();
      const storageB = new MemoryStorage();
      const engine = new Engine({ storage: storageA });
      try {
        await expect(setupServiceWorker({ engine, storage: storageB })).rejects.toThrow(
          /same instance/,
        );
      } finally {
        engine[Symbol.dispose]();
      }
    });
  });

  it('routes a matching fetch through the engine after registration completes', async () => {
    const scope = createFakeServiceWorkerScope();
    await withFakeSelf(scope, async () => {
      const setup = await setupServiceWorker({
        storage: new MemoryStorage(),
        pathPrefix: '/weft/',
        register: (engine) => {
          engine.register('hello', async function* hello() {
            yield;
            return 'world';
          });
        },
      });
      const fetchListener = listenerFor(scope, 'fetch');
      let respondedWith: Promise<Response> | undefined;
      const fakeRequest = new Request('https://example.com/weft/v1/health', { method: 'GET' });
      const fakeEvent: FakeEvent = {
        request: fakeRequest,
        respondWith(response) {
          respondedWith = Promise.resolve(response);
        },
      };
      fetchListener(fakeEvent);
      expect(respondedWith).toBeDefined();
      const response = await respondedWith!;
      expect(response).toBeInstanceOf(Response);
      setup.engine[Symbol.dispose]();
    });
  });

  it('responds with an explicit error when register rejected', async () => {
    const scope = createFakeServiceWorkerScope();
    await withFakeSelf(scope, async () => {
      try {
        await setupServiceWorker({
          storage: new MemoryStorage(),
          register: async () => {
            throw new Error('boom');
          },
        });
      } catch {
        /* ignored — we want to exercise the error-path fetch handler */
      }
      const fetchListener = listenerFor(scope, 'fetch');
      let respondedWith: Promise<Response> | undefined;
      const fakeEvent: FakeEvent = {
        request: new Request('https://example.com/weft/v1/health'),
        respondWith(response) {
          respondedWith = Promise.resolve(response);
        },
      };
      fetchListener(fakeEvent);
      const response = await respondedWith!;
      expect(response.status).toBe(503);
      const text = await response.text();
      expect(text).toMatch(/boom/);
    });
  });

  it('runs scheduler tick when periodicsync fires for the matching tag', async () => {
    const scope = createFakeServiceWorkerScope();
    await withFakeSelf(scope, async () => {
      const setup = await setupServiceWorker({
        storage: new MemoryStorage(),
        periodicSyncTag: 'weft-test',
      });
      const periodicListener = listenerFor(scope, 'periodicsync');
      let captured: Promise<unknown> | undefined;
      // Matching tag — should call waitUntil with a real promise.
      periodicListener({
        tag: 'weft-test',
        waitUntil(promise) {
          captured = promise;
        },
      });
      expect(captured).toBeDefined();
      await captured;
      // Non-matching tag — must not call waitUntil.
      let nonMatching: Promise<unknown> | undefined;
      periodicListener({
        tag: 'unrelated',
        waitUntil(promise) {
          nonMatching = promise;
        },
      });
      expect(nonMatching).toBeUndefined();
      setup.engine[Symbol.dispose]();
    });
  });

  it('install/activate fire skipWaiting and clients.claim', async () => {
    const scope = createFakeServiceWorkerScope();
    await withFakeSelf(scope, async () => {
      const setup = await setupServiceWorker({ storage: new MemoryStorage() });
      const installListener = listenerFor(scope, 'install');
      const activateListener = listenerFor(scope, 'activate');
      let installPromise: Promise<unknown> | undefined;
      installListener({
        waitUntil(promise) {
          installPromise = promise;
        },
      });
      await installPromise;
      let activatePromise: Promise<unknown> | undefined;
      activateListener({
        waitUntil(promise) {
          activatePromise = promise;
        },
      });
      await activatePromise;
      expect(scope.skipWaitingCalls).toBe(1);
      expect(scope.claimCalls).toBe(1);
      setup.engine[Symbol.dispose]();
    });
  });

  it('holds fetches dispatched mid-registration until ready resolves', async () => {
    const scope = createFakeServiceWorkerScope();
    await withFakeSelf(scope, async () => {
      let releaseRegister: () => void = () => {};
      const setupPromise = setupServiceWorker({
        storage: new MemoryStorage(),
        register: async (engine) => {
          await new Promise<void>((resolve) => {
            releaseRegister = resolve;
          });
          engine.register('hello', async function* hello() {
            yield;
            return 'world';
          });
        },
      });
      // Immediately fire a fetch matching the prefix while register is still
      // pending. The handler must call respondWith synchronously, but the
      // returned promise must not resolve until register completes.
      const fetchListener = listenerFor(scope, 'fetch');
      let respondedWith: Promise<Response> | undefined;
      fetchListener({
        request: new Request('https://example.com/weft/v1/health'),
        respondWith(response) {
          respondedWith = Promise.resolve(response);
        },
      });
      expect(respondedWith).toBeDefined();
      // The response promise should still be pending. Race it against a
      // very short timer to confirm.
      const racedBefore = await Promise.race([
        respondedWith!.then(() => 'response'),
        new Promise<string>((resolve) => setTimeout(() => resolve('timer'), 10)),
      ]);
      expect(racedBefore).toBe('timer');
      // Release register; respondedWith should now settle.
      releaseRegister();
      const setup = await setupPromise;
      const response = await respondedWith!;
      expect(response).toBeInstanceOf(Response);
      setup.engine[Symbol.dispose]();
    });
  });

  it('periodic-sync waitUntil rejects when register failed', async () => {
    const scope = createFakeServiceWorkerScope();
    await withFakeSelf(scope, async () => {
      try {
        await setupServiceWorker({
          storage: new MemoryStorage(),
          register: async () => {
            throw new Error('register-explodes');
          },
        });
      } catch {
        /* expected */
      }
      const periodicListener = listenerFor(scope, 'periodicsync');
      let captured: Promise<unknown> | undefined;
      periodicListener({
        tag: 'weft-timers',
        waitUntil(promise) {
          captured = promise;
        },
      });
      expect(captured).toBeDefined();
      let rejected: unknown;
      try {
        await captured;
      } catch (error) {
        rejected = error;
      }
      expect((rejected as Error | undefined)?.message).toMatch(/register-explodes/);
    });
  });
});
