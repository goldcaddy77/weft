import { describe, expect, it } from 'bun:test';
import { RemoteWorker } from './index.ts';

describe('RemoteWorker', () => {
  it('constructor stores options with defaults', () => {
    const worker = new RemoteWorker({
      serverUrl: 'ws://localhost:8080',
      activities: {
        processOrder: async (input) => input,
      },
    });

    // Verify it was created without throwing
    expect(worker).toBeDefined();

    // Clean up
    worker[Symbol.dispose]();
  });

  it('connected is false before connect', () => {
    const worker = new RemoteWorker({
      serverUrl: 'ws://localhost:8080',
      activities: {
        processOrder: async (input) => input,
      },
    });

    expect(worker.connected).toBe(false);

    worker[Symbol.dispose]();
  });

  it('inFlight starts at 0', () => {
    const worker = new RemoteWorker({
      serverUrl: 'ws://localhost:8080',
      activities: {
        processOrder: async (input) => input,
      },
    });

    expect(worker.inFlight).toBe(0);

    worker[Symbol.dispose]();
  });

  it('[Symbol.dispose] is callable', () => {
    const worker = new RemoteWorker({
      serverUrl: 'ws://localhost:8080',
      activities: {
        processOrder: async (input) => input,
      },
    });

    expect(() => worker[Symbol.dispose]()).not.toThrow();
  });

  it('[Symbol.dispose] is idempotent', () => {
    const worker = new RemoteWorker({
      serverUrl: 'ws://localhost:8080',
      activities: {
        processOrder: async (input) => input,
      },
    });

    worker[Symbol.dispose]();
    expect(() => worker[Symbol.dispose]()).not.toThrow();
  });
});
