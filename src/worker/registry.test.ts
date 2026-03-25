import { describe, expect, it } from 'bun:test';
import { WorkerRegistry } from './registry.ts';

describe('WorkerRegistry', () => {
  it('register adds a worker', () => {
    const registry = new WorkerRegistry();

    registry.register({
      id: 'worker-1',
      activities: ['processOrder', 'sendEmail'],
      concurrency: 5,
    });

    expect(registry.size).toBe(1);
  });

  it('unregister removes a worker and returns its info', () => {
    const registry = new WorkerRegistry();

    registry.register({
      id: 'worker-1',
      activities: ['processOrder'],
      concurrency: 5,
    });

    const info = registry.unregister('worker-1');

    expect(info).toBeDefined();
    expect(info!.id).toBe('worker-1');
    expect(registry.size).toBe(0);
  });

  it('unregister returns undefined for unknown worker', () => {
    const registry = new WorkerRegistry();
    const info = registry.unregister('nonexistent');
    expect(info).toBeUndefined();
  });

  it('heartbeat updates lastHeartbeat', () => {
    const registry = new WorkerRegistry();

    registry.register({
      id: 'worker-1',
      activities: ['processOrder'],
      concurrency: 5,
    });

    const before = registry.getAll()[0]!.lastHeartbeat;

    // Record a heartbeat to update the timestamp
    registry.heartbeat('worker-1');

    const after = registry.getAll()[0]!.lastHeartbeat;

    expect(after).toBeGreaterThanOrEqual(before);
  });

  it('heartbeat is a no-op for unknown worker', () => {
    const registry = new WorkerRegistry();
    expect(() => registry.heartbeat('nonexistent')).not.toThrow();
  });

  it('taskAssigned increments inFlight', () => {
    const registry = new WorkerRegistry();

    registry.register({
      id: 'worker-1',
      activities: ['processOrder'],
      concurrency: 5,
    });

    registry.taskAssigned('worker-1');
    registry.taskAssigned('worker-1');

    const worker = registry.getAll()[0]!;
    expect(worker.inFlight).toBe(2);
  });

  it('taskCompleted decrements inFlight', () => {
    const registry = new WorkerRegistry();

    registry.register({
      id: 'worker-1',
      activities: ['processOrder'],
      concurrency: 5,
    });

    registry.taskAssigned('worker-1');
    registry.taskAssigned('worker-1');
    registry.taskCompleted('worker-1');

    const worker = registry.getAll()[0]!;
    expect(worker.inFlight).toBe(1);
  });

  it('taskCompleted does not go below zero', () => {
    const registry = new WorkerRegistry();

    registry.register({
      id: 'worker-1',
      activities: ['processOrder'],
      concurrency: 5,
    });

    registry.taskCompleted('worker-1');

    const worker = registry.getAll()[0]!;
    expect(worker.inFlight).toBe(0);
  });

  it('findWorker returns least-loaded worker for activity', () => {
    const registry = new WorkerRegistry();

    registry.register({
      id: 'worker-1',
      activities: ['processOrder'],
      concurrency: 5,
    });

    registry.register({
      id: 'worker-2',
      activities: ['processOrder'],
      concurrency: 5,
    });

    // Load up worker-1
    registry.taskAssigned('worker-1');
    registry.taskAssigned('worker-1');
    registry.taskAssigned('worker-1');

    // worker-2 has 0 in-flight, so it should be chosen
    const best = registry.findWorker('processOrder');
    expect(best).toBeDefined();
    expect(best!.id).toBe('worker-2');
  });

  it('findWorker with sticky preference prefers that worker', () => {
    const registry = new WorkerRegistry();

    registry.register({
      id: 'worker-1',
      activities: ['processOrder'],
      concurrency: 5,
    });

    registry.register({
      id: 'worker-2',
      activities: ['processOrder'],
      concurrency: 5,
    });

    // Both have equal load, but sticky preference for worker-2
    const best = registry.findWorker('processOrder', { sticky: 'worker-2' });
    expect(best).toBeDefined();
    expect(best!.id).toBe('worker-2');
  });

  it('findWorker with sticky falls back to least-loaded when sticky is at capacity', () => {
    const registry = new WorkerRegistry();

    registry.register({
      id: 'worker-1',
      activities: ['processOrder'],
      concurrency: 2,
    });

    registry.register({
      id: 'worker-2',
      activities: ['processOrder'],
      concurrency: 2,
    });

    // Fill worker-1 to capacity
    registry.taskAssigned('worker-1');
    registry.taskAssigned('worker-1');

    const best = registry.findWorker('processOrder', { sticky: 'worker-1' });
    expect(best).toBeDefined();
    expect(best!.id).toBe('worker-2');
  });

  it('findWorker returns undefined when no worker available', () => {
    const registry = new WorkerRegistry();
    const best = registry.findWorker('unknownActivity');
    expect(best).toBeUndefined();
  });

  it('findWorker returns undefined when all workers are at capacity', () => {
    const registry = new WorkerRegistry();

    registry.register({
      id: 'worker-1',
      activities: ['processOrder'],
      concurrency: 1,
    });

    registry.taskAssigned('worker-1');

    const best = registry.findWorker('processOrder');
    expect(best).toBeUndefined();
  });

  it('size reflects worker count', () => {
    const registry = new WorkerRegistry();
    expect(registry.size).toBe(0);

    registry.register({
      id: 'worker-1',
      activities: ['processOrder'],
      concurrency: 5,
    });

    expect(registry.size).toBe(1);

    registry.register({
      id: 'worker-2',
      activities: ['sendEmail'],
      concurrency: 3,
    });

    expect(registry.size).toBe(2);

    registry.unregister('worker-1');
    expect(registry.size).toBe(1);
  });

  it('getAll returns all workers', () => {
    const registry = new WorkerRegistry();

    registry.register({
      id: 'worker-1',
      activities: ['processOrder'],
      concurrency: 5,
    });

    registry.register({
      id: 'worker-2',
      activities: ['sendEmail'],
      concurrency: 3,
    });

    const all = registry.getAll();
    expect(all).toHaveLength(2);

    const ids = all.map((worker) => worker.id);
    expect(ids).toContain('worker-1');
    expect(ids).toContain('worker-2');
  });

  it('registered workers have connectedAt and lastHeartbeat timestamps', () => {
    const registry = new WorkerRegistry();
    const before = Date.now();

    registry.register({
      id: 'worker-1',
      activities: ['processOrder'],
      concurrency: 5,
    });

    const worker = registry.getAll()[0]!;
    expect(worker.connectedAt).toBeGreaterThanOrEqual(before);
    expect(worker.lastHeartbeat).toBeGreaterThanOrEqual(before);
    expect(worker.inFlight).toBe(0);
  });
});
