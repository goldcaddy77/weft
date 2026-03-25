import { describe, expect, it } from 'bun:test';
import { LongPollWorker } from './long-poll.ts';

describe('LongPollWorker', () => {
  it('constructor stores options with defaults', () => {
    const worker = new LongPollWorker({
      serverUrl: 'http://localhost:8080',
      activities: {
        processOrder: async (input) => input,
      },
    });

    expect(worker).toBeDefined();

    worker[Symbol.dispose]();
  });

  it('running is false initially', () => {
    const worker = new LongPollWorker({
      serverUrl: 'http://localhost:8080',
      activities: {
        processOrder: async (input) => input,
      },
    });

    expect(worker.running).toBe(false);

    worker[Symbol.dispose]();
  });

  it('inFlight starts at 0', () => {
    const worker = new LongPollWorker({
      serverUrl: 'http://localhost:8080',
      activities: {
        processOrder: async (input) => input,
      },
    });

    expect(worker.inFlight).toBe(0);

    worker[Symbol.dispose]();
  });

  it('[Symbol.dispose] stops polling', () => {
    const worker = new LongPollWorker({
      serverUrl: 'http://localhost:8080',
      activities: {
        processOrder: async (input) => input,
      },
    });

    // Start polling, then dispose
    worker.start();
    expect(worker.running).toBe(true);

    worker[Symbol.dispose]();
    expect(worker.running).toBe(false);
  });

  it('[Symbol.dispose] is idempotent', () => {
    const worker = new LongPollWorker({
      serverUrl: 'http://localhost:8080',
      activities: {
        processOrder: async (input) => input,
      },
    });

    worker[Symbol.dispose]();
    expect(() => worker[Symbol.dispose]()).not.toThrow();
  });
});
