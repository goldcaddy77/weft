import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { HeartbeatManager } from './heartbeat.ts';

describe('HeartbeatManager', () => {
  let sendHeartbeat: ReturnType<typeof mock>;
  let manager: HeartbeatManager;

  beforeEach(() => {
    sendHeartbeat = mock(() => {});
    manager = new HeartbeatManager(sendHeartbeat, 50);
  });

  afterEach(() => {
    manager.stop();
  });

  it('beat calls sendHeartbeat with details', () => {
    const details = { progress: 42 };
    manager.beat(details);

    expect(sendHeartbeat).toHaveBeenCalledTimes(1);
    expect(sendHeartbeat).toHaveBeenCalledWith(details);
  });

  it('beat calls sendHeartbeat without details', () => {
    manager.beat();

    expect(sendHeartbeat).toHaveBeenCalledTimes(1);
    expect(sendHeartbeat).toHaveBeenCalledWith(undefined);
  });

  it('start begins periodic heartbeats', async () => {
    manager.start();

    // Wait for a few intervals to fire
    await Bun.sleep(130);

    // At least 2 heartbeats should have fired in ~130ms with 50ms interval
    expect(sendHeartbeat.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('stop stops heartbeats', async () => {
    manager.start();
    await Bun.sleep(60);

    manager.stop();
    const countAfterStop = sendHeartbeat.mock.calls.length;

    await Bun.sleep(100);

    // No additional heartbeats after stop
    expect(sendHeartbeat).toHaveBeenCalledTimes(countAfterStop);
  });

  it('isRunning reflects state', () => {
    expect(manager.isRunning).toBe(false);

    manager.start();
    expect(manager.isRunning).toBe(true);

    manager.stop();
    expect(manager.isRunning).toBe(false);
  });

  it('start is idempotent when already running', () => {
    manager.start();
    manager.start(); // should not create a second interval

    expect(manager.isRunning).toBe(true);
  });

  it('stop is safe to call when not running', () => {
    expect(() => manager.stop()).not.toThrow();
  });

  it('uses default interval when none provided', () => {
    const defaultManager = new HeartbeatManager(sendHeartbeat);
    expect(defaultManager.isRunning).toBe(false);
    defaultManager.stop();
  });
});
